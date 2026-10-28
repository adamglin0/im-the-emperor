// MCP 服务器配置：存取（表 mcp_servers，仅配置）、校验规范化、密钥合并、审批（官员只可收缩）、授权解析、通知 broker 与部门。
// 密钥（headers/env 的值）只在本表与 broker 内存：对外一律 toMcpServerView；事件、待办正文、审批 payload 不含密钥值。
import {
  ApiError,
  MCP_DEFAULT_IMAGE,
  MCP_ENV_KEY_RE,
  MCP_HEADER_KEY_RE,
  MCP_ID_RE,
  MCP_LIMITS,
  McpAdminClient,
  mcpMatchTargets,
  mcpTargetKey,
  toMcpServerView,
  type Address,
  type Approval,
  type McpAccess,
  type McpInternalState,
  type McpNetwork,
  type McpServerConfig,
  type McpServerInput,
  type McpTarget,
  type McpTransport,
  type McpWriteRes,
} from "@court/shared";
import { bad, HubError, invalidState, notFound, versionConflict, type HubCtx } from "../ctx.ts";
import { longFetch } from "./long-fetch.ts";
import { getMeta, setMeta } from "./registry.ts";

const TRANSPORTS: McpTransport[] = ["streamable_http", "stdio"];
const NETWORKS: McpNetwork[] = ["bridge", "none"];
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,254}$/;
const MAX_ARG_LEN = 4096;
const MAX_COMMAND_LEN = 4096;
const MAX_SECRET_LEN = 16_384;
const MAX_URL_LEN = 2048;
const MAX_TOOL_NAME_LEN = 128;
const MIN_MEMORY_MB = 64;
const MIN_CPUS = 0.1;
const UNREACHABLE_EVENT_EVERY_MS = 60_000;
const RELOAD_TIMEOUT_MS = 5_000;

/** 连接相关字段：任何改动对官员都算「放大」（等于换了一个服务器） */
const CONNECTION_FIELDS = ["transport", "url", "headers", "image", "command", "args", "env", "network", "memory_mb", "cpus"] as const;

/** 待批配置（含密钥）存 meta 而非审批 payload：/api/approvals 对各部门可读 */
const pendingKey = (approvalId: string) => `mcp_pending:${approvalId}`;

export interface McpPendingPayload {
  op: "create" | "update";
  id: string;
  /** 目标配置视图（无密钥）；完整配置在 meta mcp_pending:<approval_id> */
  server: ReturnType<typeof toMcpServerView>;
  /** 修改：申请时的服务器版本；批准时不符则不执行 */
  base_version: number | null;
  reason: string;
  actor: Address;
  trace_id?: string;
}

export interface McpService {
  version(): number;
  listServers(): McpServerConfig[];
  getServerOrNull(id: string): McpServerConfig | undefined;
  getServer(id: string): McpServerConfig;
  /** 校验并规范化：base 给出时为修改（缺省字段沿用 base，密钥 null = 沿用）；返回目标配置（元数据未更新） */
  normalize(input: McpServerInput, base: McpServerConfig | undefined, opts: { id: string; checkUnique?: boolean; checkCount?: boolean }): McpServerConfig;
  /** 新建（皇帝直接生效；官员 → 待批） */
  createServer(input: McpServerInput, actor: Address, meta?: { reason?: string; trace_id?: string }): McpWriteRes;
  /** 修改（皇帝直接生效；官员只收缩直接生效，放大 → 待批） */
  updateServer(id: string, input: McpServerInput, actor: Address, meta?: { reason?: string; trace_id?: string; expected_version?: number }): McpWriteRes;
  deleteServer(id: string, actor: Address, meta?: { reason?: string; expected_version?: number }): McpWriteRes;
  /** 官员修改须皇帝批准的「放大」项（空 = 只收缩，可直接生效） */
  needsApproval(before: McpServerConfig, after: McpServerConfig): string[];
  /** 差异说明（密钥只列键名） */
  diff(before: McpServerConfig | undefined, after: McpServerConfig): string[];
  internalState(): McpInternalState;
  accessOf(postId: string): McpAccess;
  /** 提交后：broker 重载 → 各部门刷新 MCP 工具 */
  notifyChanged(): void;
  admin(timeoutMs?: number): McpAdminClient;
}

// ───────────────────────── 小工具 ─────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function sameRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return sameJson(ka, kb) && ka.every((k) => a![k] === b![k]);
}

function intIn(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${field} 必须是 ${min}–${max} 的整数`);
  return v;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw bad(`${field} 必须是字符串`);
  return v;
}

/** stdio 环境变量保留名：broker 用它们跑 docker CLI 或固定在容器里（HOME/缓存目录指向 tmpfs），不许覆盖 */
const RESERVED_ENV_KEYS = new Set(["PATH", "HOME", "NPM_CONFIG_CACHE", "UV_CACHE_DIR"]);
export function isReservedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return RESERVED_ENV_KEYS.has(upper) || upper.startsWith("DOCKER_");
}

/** 合并密钥映射：值 null = 沿用 base 中同名键；未出现的键 = 删除 */
function mergeSecrets(
  input: unknown,
  base: Record<string, string> | undefined,
  field: "headers" | "env",
  keyRe: RegExp,
  maxKeys: number,
): Record<string, string> | undefined {
  if (input === undefined) return base ? { ...base } : undefined;
  if (input === null) return undefined;
  if (!isObj(input)) throw bad(`${field} 必须是对象 {键: 值}；值为 null 表示沿用已存的值`);
  const keys = Object.keys(input);
  if (keys.length > maxKeys) throw bad(`${field} 最多 ${maxKeys} 项（现有 ${keys.length} 项）`);
  const label = field === "headers" ? "请求头" : "环境变量";
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!keyRe.test(k) || k === "__proto__") throw bad(`${label}名 ${JSON.stringify(k).slice(0, 140)} 不合法（须匹配 ${keyRe.source}）`);
    if (field === "env" && isReservedEnvKey(k)) {
      throw bad(`环境变量名 ${k} 是保留名，不能设置（PATH、HOME、npm_config_cache、UV_CACHE_DIR 及 DOCKER_ 开头的变量由 MCP 中转站固定使用），请换个名字`);
    }
    const v = input[k];
    if (v === null) {
      // hasOwn：免得 constructor/toString 等键名取到原型上的函数
      const old = base && Object.hasOwn(base, k) ? base[k] : undefined;
      if (old === undefined) throw bad(`${label} ${k} 没有已存的值可沿用（null 只能用于修改已有的键），请直接填写值`);
      out[k] = old;
      continue;
    }
    if (typeof v !== "string") throw bad(`${label} ${k} 的值必须是字符串（或 null 表示沿用已存的值）`);
    if (v.length > MAX_SECRET_LEN) throw bad(`${label} ${k} 的值过长（上限 ${MAX_SECRET_LEN} 字）`);
    if (field === "headers" && /[\r\n\0]/.test(v)) throw bad(`请求头 ${k} 的值不能含换行或 NUL 字符`);
    if (field === "env" && v.includes("\0")) throw bad(`环境变量 ${k} 的值不能含 NUL 字符`);
    out[k] = v;
  }
  return out;
}

/** 展示用：去掉 url 中的用户名/密码（http://user:pass@host 里的凭据） */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "***";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** 已存密钥被原样沿用的键（值相同） */
function retainedSecretKeys(before: Record<string, string> | undefined, after: Record<string, string> | undefined): string[] {
  if (!before || !after) return [];
  return Object.keys(after).filter((k) => Object.hasOwn(before, k) && before[k] === after[k]);
}

/** 决定密钥发往何处/由谁读取的字段：改了它们而沿用旧密钥 = 把已存密钥交给新的端点/代码 */
const SECRET_RECEIVER_FIELDS = ["transport", "url", "image", "command", "args"] as const;

function targetLabel(ctx: HubCtx, t: McpTarget): string {
  if (t.kind === "all") return "所有人";
  if (t.kind === "dept") return `部门 ${ctx.registry.dept(t.id)?.name ?? t.id}`;
  const o = ctx.registry.official(t.id);
  const post = ctx.registry.postOf(t.id);
  return `官员 ${o?.name ?? t.id}${post ? `（${post}）` : ""}`;
}

// ───────────────────────── 服务 ─────────────────────────

export function createMcp(ctx: HubCtx): McpService {
  let lastUnreachableAt = -Infinity;

  const version = () => Number(getMeta(ctx, "mcp_version") ?? "0");

  function listServers(): McpServerConfig[] {
    return ctx.db.allJson<McpServerConfig>("SELECT data_json FROM mcp_servers ORDER BY id LIMIT 1000");
  }
  function getServerOrNull(id: string): McpServerConfig | undefined {
    return ctx.db.getJson<McpServerConfig>("SELECT data_json FROM mcp_servers WHERE id = ?", id);
  }
  function getServer(id: string): McpServerConfig {
    const s = getServerOrNull(id);
    if (!s) throw notFound(`MCP 服务器 ${id}（可先 GET /api/mcp/servers 查看现有 id）`);
    return s;
  }

  function normalizeTargets(v: unknown): McpTarget[] {
    if (!Array.isArray(v)) throw bad('targets 必须是数组，如 [{"kind":"all"}]、[{"kind":"dept","id":"bingbu"}]、[{"kind":"official","id":"of_xxx"}]');
    if (v.length > MCP_LIMITS.maxTargets) throw bad(`targets 最多 ${MCP_LIMITS.maxTargets} 项`);
    const out: McpTarget[] = [];
    const seen = new Set<string>();
    for (const raw of v) {
      if (!isObj(raw)) throw bad("targets 每项须是对象 {kind, id?}");
      let t: McpTarget;
      if (raw.kind === "all") t = { kind: "all" };
      else if (raw.kind === "dept") {
        const id = str(raw.id, "targets[].id");
        if (!ctx.registry.dept(id)) throw bad(`授权部门 ${id} 不存在，可选：${ctx.registry.depts().map((d) => d.id).join("/")}`);
        t = { kind: "dept", id };
      } else if (raw.kind === "official") {
        const id = str(raw.id, "targets[].id");
        if (!ctx.registry.official(id)) throw bad(`授权官员 ${id} 不存在（填 official_id，如 of_xxx；可在名册 /api/registry 查）`);
        t = { kind: "official", id };
      } else throw bad(`targets[].kind 只能是 all/dept/official（收到 ${JSON.stringify(raw.kind)}）`);
      const k = mcpTargetKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }

  function normalize(input: McpServerInput, base: McpServerConfig | undefined, opts: { id: string; checkUnique?: boolean; checkCount?: boolean }): McpServerConfig {
    if (!isObj(input)) throw bad("请求体必须是 MCP 服务器配置对象");
    const id = opts.id;
    if (typeof id !== "string" || !MCP_ID_RE.test(id)) throw bad(`id ${JSON.stringify(id ?? "")} 不合法：须 2–24 位，小写字母开头，只含小写字母、数字、_、-（它会成为工具名前缀）`);
    if (opts.checkUnique && getServerOrNull(id)) throw invalidState(`MCP 服务器 ${id} 已存在，请换一个 id，或用 PATCH /api/mcp/servers/${id} 修改`);
    if (opts.checkCount && (ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_servers")?.n ?? 0) >= MCP_LIMITS.maxServers) {
      throw invalidState(`MCP 服务器已达上限 ${MCP_LIMITS.maxServers} 个，请先删除不用的`);
    }

    // 公共字段
    const nameRaw = input.name ?? base?.name;
    if (nameRaw === undefined) throw bad("name（显示名称）必填，1–60 字");
    const name = str(nameRaw, "name").trim();
    if (name.length < 1 || name.length > 60) throw bad("name 须 1–60 字");
    const description = str(input.description ?? base?.description ?? "", "description").trim();
    if (description.length > 500) throw bad("description 最多 500 字");
    const transport = (input.transport ?? base?.transport) as McpTransport | undefined;
    if (!transport || !TRANSPORTS.includes(transport)) throw bad(`transport 必填，只能是 ${TRANSPORTS.join(" / ")}`);
    const enabledRaw = input.enabled ?? base?.enabled ?? true;
    if (typeof enabledRaw !== "boolean") throw bad("enabled 必须是 true/false");
    const targets = input.targets !== undefined ? normalizeTargets(input.targets) : [...(base?.targets ?? [])];

    const out: McpServerConfig = {
      id,
      name,
      description,
      transport,
      enabled: enabledRaw,
      targets,
      version: base?.version ?? 0,
      created_at: base?.created_at ?? 0,
      updated_at: base?.updated_at ?? 0,
      updated_by: base?.updated_by ?? "system:hub",
    };

    // tool_allow：null/[] = 全部
    const allowRaw = input.tool_allow !== undefined ? input.tool_allow : base?.tool_allow;
    if (allowRaw != null) {
      if (!Array.isArray(allowRaw)) throw bad("tool_allow 必须是工具名数组（MCP 原名）；空数组 = 开放全部工具");
      if (allowRaw.length > MCP_LIMITS.maxToolAllow) throw bad(`tool_allow 最多 ${MCP_LIMITS.maxToolAllow} 项`);
      const set: string[] = [];
      for (const t of allowRaw) {
        if (typeof t !== "string" || !t.trim() || t.length > MAX_TOOL_NAME_LEN) throw bad(`tool_allow 每项须是 1–${MAX_TOOL_NAME_LEN} 字的工具名`);
        if (!set.includes(t)) set.push(t);
      }
      if (set.length) out.tool_allow = set;
    }

    const timeoutRaw = input.timeout_seconds !== undefined ? input.timeout_seconds : base?.timeout_seconds;
    if (timeoutRaw != null) out.timeout_seconds = intIn(timeoutRaw, "timeout_seconds", 1, MCP_LIMITS.maxTimeoutSeconds);

    // 只保留当前 transport 的字段：另一种的字段（入参或旧值）一律丢弃；切换 transport 时也不沿用旧连接字段
    const sameTransport = base?.transport === transport;
    const prev = sameTransport ? base : undefined;

    if (transport === "streamable_http") {
      const urlRaw = input.url !== undefined ? input.url : prev?.url;
      if (urlRaw == null || urlRaw === "") throw bad("streamable_http 须填写 url（http:// 或 https://，须从 MCP 中转站容器可达）");
      const url = str(urlRaw, "url").trim();
      if (url.length > MAX_URL_LEN) throw bad(`url 过长（上限 ${MAX_URL_LEN} 字）`);
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw bad(`url ${JSON.stringify(url.slice(0, 200))} 不是合法地址`);
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("url 只能是 http:// 或 https://");
      out.url = url;
      const headers = mergeSecrets(input.headers, prev?.headers, "headers", MCP_HEADER_KEY_RE, MCP_LIMITS.maxHeaders);
      if (headers && Object.keys(headers).length) out.headers = headers;
    } else {
      const image = str(input.image !== undefined && input.image !== null && input.image !== "" ? input.image : (prev?.image ?? MCP_DEFAULT_IMAGE), "image").trim();
      if (!IMAGE_RE.test(image)) throw bad(`image ${JSON.stringify(image.slice(0, 200))} 不是合法的 docker 镜像名（如 ${MCP_DEFAULT_IMAGE}）`);
      out.image = image;
      const commandRaw = input.command !== undefined ? input.command : prev?.command;
      if (commandRaw == null) throw bad('stdio 须填写 command（容器内要执行的命令，如 "npx" 或 "uvx"）');
      const command = str(commandRaw, "command").trim();
      if (!command || command.length > MAX_COMMAND_LEN) throw bad(`command 须 1–${MAX_COMMAND_LEN} 字`);
      out.command = command;
      const argsRaw = input.args !== undefined ? input.args : prev?.args;
      if (argsRaw != null) {
        if (!Array.isArray(argsRaw)) throw bad('args 必须是字符串数组，如 ["-y", "@modelcontextprotocol/server-everything"]');
        if (argsRaw.length > MCP_LIMITS.maxArgs) throw bad(`args 最多 ${MCP_LIMITS.maxArgs} 项`);
        for (const a of argsRaw) if (typeof a !== "string" || a.length > MAX_ARG_LEN || a.includes("\0")) throw bad(`args 每项须是不超过 ${MAX_ARG_LEN} 字的字符串`);
        if (argsRaw.length) out.args = [...argsRaw];
      }
      const env = mergeSecrets(input.env, prev?.env, "env", MCP_ENV_KEY_RE, MCP_LIMITS.maxEnv);
      if (env && Object.keys(env).length) out.env = env;
      const network = (input.network ?? prev?.network ?? "bridge") as McpNetwork;
      if (!NETWORKS.includes(network)) throw bad("network 只能是 bridge（可上外网）或 none（断网）");
      out.network = network;
      const mem = input.memory_mb ?? prev?.memory_mb ?? MCP_LIMITS.defaultMemoryMb;
      out.memory_mb = intIn(mem, "memory_mb", MIN_MEMORY_MB, MCP_LIMITS.maxMemoryMb);
      const cpus = input.cpus ?? prev?.cpus ?? MCP_LIMITS.defaultCpus;
      if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus < MIN_CPUS || cpus > MCP_LIMITS.maxCpus) throw bad(`cpus 须在 ${MIN_CPUS}–${MCP_LIMITS.maxCpus} 之间`);
      out.cpus = Math.round(cpus * 100) / 100;
    }
    return out;
  }

  function needsApproval(before: McpServerConfig, after: McpServerConfig): string[] {
    const why: string[] = [];
    if (!before.enabled && after.enabled) why.push("启用服务器");
    const had = new Set(before.targets.map(mcpTargetKey));
    const added = after.targets.filter((t) => !had.has(mcpTargetKey(t)));
    if (added.length) why.push(`新增授权对象：${added.map((t) => targetLabel(ctx, t)).join("、")}`);
    const ba = before.tool_allow ?? [];
    const aa = after.tool_allow ?? [];
    if (ba.length && !aa.length) why.push("清空工具白名单（等于开放全部工具）");
    else if (ba.length && aa.some((t) => !ba.includes(t))) why.push(`工具白名单新增：${aa.filter((t) => !ba.includes(t)).join("、")}`);
    for (const f of CONNECTION_FIELDS) {
      const changed = f === "headers" || f === "env" ? !sameRecord(before[f], after[f]) : !sameJson(before[f], after[f]);
      if (changed) why.push(`修改连接配置 ${f}`);
    }
    return why;
  }

  function diff(before: McpServerConfig | undefined, after: McpServerConfig): string[] {
    const lines: string[] = [];
    const show = (v: unknown, f?: string) => (v === undefined ? "（无）" : JSON.stringify(f === "url" && typeof v === "string" ? redactUrl(v) : v));
    const plain = ["name", "description", "transport", "enabled", "tool_allow", "timeout_seconds", "url", "image", "command", "args", "network", "memory_mb", "cpus"] as const;
    for (const f of plain) {
      if (before && sameJson(before[f], after[f])) continue;
      if (!before && after[f] === undefined) continue;
      lines.push(before ? `${f}：${show(before[f], f)} → ${show(after[f], f)}` : `${f}：${show(after[f], f)}`);
    }
    const bt = new Set((before?.targets ?? []).map(mcpTargetKey));
    const at = new Set(after.targets.map(mcpTargetKey));
    const add = after.targets.filter((t) => !bt.has(mcpTargetKey(t)));
    const del = (before?.targets ?? []).filter((t) => !at.has(mcpTargetKey(t)));
    if (add.length) lines.push(`授权新增：${add.map((t) => targetLabel(ctx, t)).join("、")}`);
    if (del.length) lines.push(`授权移除：${del.map((t) => targetLabel(ctx, t)).join("、")}`);
    for (const f of ["headers", "env"] as const) {
      const b = before?.[f] ?? {};
      const a = after[f] ?? {};
      const added = Object.keys(a).filter((k) => !Object.hasOwn(b, k));
      const removed = Object.keys(b).filter((k) => !Object.hasOwn(a, k));
      const changed = Object.keys(a).filter((k) => Object.hasOwn(b, k) && a[k] !== b[k]);
      const label = f === "headers" ? "请求头" : "环境变量";
      if (added.length) lines.push(`${label}新增键：${added.join("、")}（值不显示）`);
      if (removed.length) lines.push(`${label}删除键：${removed.join("、")}`);
      if (changed.length) lines.push(`${label}改值：${changed.join("、")}（值不显示）`);
    }
    return lines;
  }

  /** 改动了哪些字段（只给字段名：事件对各部门可读，不放值） */
  function changedFields(before: McpServerConfig, after: McpServerConfig): string[] {
    const fields = ["name", "description", "transport", "enabled", "targets", "tool_allow", "timeout_seconds", ...CONNECTION_FIELDS.filter((f) => f !== "transport")] as const;
    return fields.filter((f) => (f === "headers" || f === "env" ? !sameRecord(before[f], after[f]) : !sameJson(before[f], after[f])));
  }

  /** 修改了接收密钥的端点/代码却沿用旧密钥：须在审批正文里提醒陛下 */
  function secretHandoverWarning(before: McpServerConfig | undefined, after: McpServerConfig): string {
    if (!before) return "";
    const receivers = SECRET_RECEIVER_FIELDS.filter((f) => !sameJson(before[f], after[f]));
    if (!receivers.length) return "";
    const kept = [...retainedSecretKeys(before.headers, after.headers).map((k) => `请求头 ${k}`), ...retainedSecretKeys(before.env, after.env).map((k) => `环境变量 ${k}`)];
    if (!kept.length) return "";
    return `注意：改了 ${receivers.join("、")}，但沿用已存密钥（${kept.join("、")}）——批准后这些密钥将交给新的地址/镜像/命令。`;
  }

  /** 写表 + bump 总版本 + 事件；须在 db.tx 内调用。server.version 取新的总版本（删后重建同 id 也不会撞 broker 的 id@version 连接键） */
  function persist(next: McpServerConfig, actor: Address, kind: "created" | "updated", note: string): McpServerConfig {
    const v = version() + 1;
    setMeta(ctx, "mcp_version", String(v));
    const now = ctx.now();
    const saved: McpServerConfig = { ...next, version: v, created_at: kind === "created" ? now : next.created_at || now, updated_at: now, updated_by: actor };
    ctx.db.run(
      "INSERT INTO mcp_servers (id, version, updated_at, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, data_json = excluded.data_json",
      saved.id,
      saved.version,
      saved.updated_at,
      JSON.stringify(saved),
    );
    ctx.events.emit({
      type: kind === "created" ? "mcp.created" : "mcp.updated",
      actor,
      subject_type: "mcp_server",
      subject_id: saved.id,
      summary: `${kind === "created" ? "新建" : "修改"} MCP 服务器 ${saved.name}（${saved.id}，v${saved.version}，${saved.enabled ? "启用" : "停用"}）${note ? `：${note}` : ""}`.slice(0, 300),
      data: { id: saved.id, version: saved.version, mcp_version: v, enabled: saved.enabled, transport: saved.transport },
    });
    notifyChanged();
    return saved;
  }

  function requestApproval(op: "create" | "update", target: McpServerConfig, before: McpServerConfig | undefined, actor: Address, meta: { reason?: string; trace_id?: string }, why: string[]): McpWriteRes {
    const reason = String(meta.reason ?? "").trim();
    const payload: McpPendingPayload = {
      op,
      id: target.id,
      server: toMcpServerView(target),
      base_version: before ? before.version : null,
      reason,
      actor,
    };
    if (meta.trace_id) payload.trace_id = meta.trace_id;
    const lines = diff(before, target);
    const body = [
      `${actor} 申请${op === "create" ? "新建" : "修改"} MCP 服务器 ${target.name}（${target.id}，${target.transport}）。`,
      `理由：${reason || "（未说明）"}`,
      why.length ? `须陛下批准的原因：${why.join("；")}` : "",
      secretHandoverWarning(before, target),
      lines.length ? `变更：\n${lines.map((l) => `- ${l}`).join("\n")}` : "",
      "批准后立即生效；若期间该服务器已被他人修改，则不执行，请申请人重新申请。",
    ]
      .filter(Boolean)
      .join("\n");
    const a = ctx.approvals.request("mcp_config", payload as unknown as Record<string, unknown>, actor, `${op === "create" ? "新建" : "修改"} MCP 服务器 ${target.name}（${target.id}）`, body.slice(0, 8000));
    setMeta(ctx, pendingKey(a.id), JSON.stringify(target));
    ctx.events.emit({
      type: "mcp.requested",
      actor,
      subject_type: "mcp_server",
      subject_id: target.id,
      summary: `${actor} 申请${op === "create" ? "新建" : "修改"} MCP 服务器 ${target.name}（${target.id}），待陛下批准`.slice(0, 300),
      data: { id: target.id, approval_id: a.id, op, base_version: payload.base_version },
    });
    return { status: "pending_approval", approval_id: a.id, notification_id: a.notification_id };
  }

  const isOfficial = (actor: Address) => actor.startsWith("post:");

  function checkExpected(cur: McpServerConfig, expected: number | undefined): void {
    if (expected === undefined || expected === null) return;
    if (Number(expected) !== cur.version) throw versionConflict(cur.version);
  }

  function dropPending(approvalId: string): void {
    ctx.db.run("DELETE FROM meta WHERE k = ?", pendingKey(approvalId));
  }

  function applyApproval(a: Approval): void {
    try {
      applyPending(a);
    } catch (e) {
      // 执行失败时外层事务回滚：事后再删暂存的配置（含密钥），免得残留
      setImmediate(() => {
        try {
          dropPending(a.id);
        } catch {
          /* hub 已关闭 */
        }
      });
      throw e;
    }
  }

  function applyPending(a: Approval): void {
    const p = a.payload as unknown as McpPendingPayload;
    const raw = getMeta(ctx, pendingKey(a.id));
    dropPending(a.id);
    if (!raw) throw new Error(`待批的 MCP 配置（${p.id}）已丢失，请重新申请`);
    const target = JSON.parse(raw) as McpServerConfig;
    const cur = getServerOrNull(target.id);
    if (p.op === "create") {
      if (cur) throw new Error(`MCP 服务器 ${target.id} 在审批期间已被创建（当前 v${cur.version}），本申请作废；如仍需调整请基于现状重新申请`);
      if ((ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_servers")?.n ?? 0) >= MCP_LIMITS.maxServers) throw new Error(`MCP 服务器已达上限 ${MCP_LIMITS.maxServers} 个`);
    } else {
      if (!cur) throw new Error(`MCP 服务器 ${target.id} 在审批期间已被删除，本申请作废`);
      if (cur.version !== p.base_version) {
        throw new Error(`MCP 服务器 ${target.id} 在审批期间已被修改（申请基于 v${p.base_version}，当前 v${cur.version}），本申请作废；请先 mcp_get_server 读取现状再重新申请`);
      }
    }
    // 名册可能在审批期间变化：授权对象重新校验
    normalizeTargets(target.targets);
    persist(cur ? { ...target, created_at: cur.created_at } : target, p.actor ?? a.requested_by, p.op === "create" ? "created" : "updated", `${p.reason || "官员申请"}（陛下准奏）`);
  }

  ctx.approvals.onApprove("mcp_config", applyApproval);
  (ctx.approvals as { onReject?: (t: Approval["type"], fn: (a: Approval) => void) => void }).onReject?.("mcp_config", (a) => dropPending(a.id));

  function admin(timeoutMs = RELOAD_TIMEOUT_MS): McpAdminClient {
    // longFetch：测试/重启可超过全局 fetch 的 300s 响应头时限
    return new McpAdminClient({ baseUrl: ctx.mcpUrl.replace(/\/+$/, ""), token: ctx.mcpToken, timeoutMs, fetchImpl: longFetch });
  }

  function notifyChanged(): void {
    // 事务是同步的：setImmediate 时已提交。broker 先重载，再让部门刷新工具清单
    setImmediate(() => {
      void (async () => {
        try {
          await admin().reload();
        } catch (e) {
          try {
            const now = ctx.now();
            if (now - lastUnreachableAt >= UNREACHABLE_EVENT_EVERY_MS) {
              lastUnreachableAt = now;
              const msg = e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).message;
              ctx.events.emit({ type: "mcp.broker_unreachable", actor: "system:hub", summary: `MCP 中转站重载失败（${ctx.mcpUrl}）：${msg}`.slice(0, 300) });
            }
          } catch {
            /* hub 已关闭 */
          }
        }
        try {
          for (const d of ctx.registry.depts()) {
            ctx.doorbell.control(d.id, "/control/mcp", {}).catch((e: Error) => {
              try {
                ctx.events.emit({ type: "dept.control_failed", actor: "system:hub", dept: d.id, summary: `控制命令 /control/mcp 未送达 ${d.name}：${e.message}`.slice(0, 300) });
              } catch {
                /* hub 已关闭 */
              }
            });
          }
        } catch {
          /* hub 已关闭 */
        }
      })();
    });
  }

  return {
    version,
    listServers,
    getServerOrNull,
    getServer,
    normalize,
    needsApproval,
    diff,
    admin,
    notifyChanged,

    createServer(input, actor, meta = {}) {
      const id = typeof input?.id === "string" ? input.id.trim() : "";
      if (!id) throw bad("id 必填：2–24 位，小写字母开头，只含小写字母、数字、_、-");
      const target = normalize(input, undefined, { id, checkUnique: true, checkCount: true });
      if (isOfficial(actor)) return requestApproval("create", target, undefined, actor, meta, ["新建服务器须陛下批准"]);
      return { status: "applied", server: toMcpServerView(persist(target, actor, "created", String(meta.reason ?? "").trim())) };
    },

    updateServer(id, input, actor, meta = {}) {
      const cur = getServer(id);
      checkExpected(cur, meta.expected_version);
      if (input?.id !== undefined && input.id !== id) throw bad(`不能修改 id（${id}）：如需改名请新建后删除旧的`);
      const target = normalize(input, cur, { id });
      const lines = diff(cur, target);
      if (!lines.length) return { status: "applied", server: toMcpServerView(cur) };
      if (isOfficial(actor)) {
        const why = needsApproval(cur, target);
        if (why.length) return requestApproval("update", target, cur, actor, meta, why);
      }
      return { status: "applied", server: toMcpServerView(persist(target, actor, "updated", String(meta.reason ?? "").trim() || `改动：${changedFields(cur, target).join("、")}`)) };
    },

    deleteServer(id, actor, meta = {}) {
      const cur = getServer(id);
      checkExpected(cur, meta.expected_version);
      const v = version() + 1;
      setMeta(ctx, "mcp_version", String(v));
      ctx.db.run("DELETE FROM mcp_servers WHERE id = ?", id);
      const reason = String(meta.reason ?? "").trim();
      ctx.events.emit({
        type: "mcp.deleted",
        actor,
        subject_type: "mcp_server",
        subject_id: id,
        summary: `删除 MCP 服务器 ${cur.name}（${id}）${reason ? `：${reason}` : ""}`.slice(0, 300),
        data: { id, version: cur.version, mcp_version: v },
      });
      notifyChanged();
      return { status: "deleted", id };
    },

    internalState(): McpInternalState {
      const tokens: Record<string, string> = {};
      for (const r of ctx.db.all<{ id: string; token: string }>("SELECT id, token FROM depts LIMIT 100")) tokens[r.token] = r.id;
      const posts: McpInternalState["posts"] = {};
      for (const p of ctx.registry.posts()) {
        const o = ctx.registry.officialOf(p.post_id);
        posts[p.post_id] = o ? { dept: p.dept, official_id: o.official_id } : { dept: p.dept };
      }
      return { version: version(), servers: listServers(), tokens, posts };
    },

    accessOf(postId: string): McpAccess {
      const post = ctx.registry.post(postId);
      if (!post) throw notFound(`职位 ${postId}`);
      const o = ctx.registry.officialOf(postId);
      const who = { dept: post.dept, official_id: o?.official_id };
      const servers: McpAccess["servers"] = [];
      for (const s of listServers()) {
        if (!s.enabled) continue;
        const via = mcpMatchTargets(s.targets, who);
        if (via.length) servers.push({ id: s.id, name: s.name, via });
      }
      const out: McpAccess = { post_id: postId, servers };
      if (o) out.official_id = o.official_id;
      return out;
    },
  };
}

/** broker 错误 → hub 错误：连不上/令牌不符 → 503；其余状态码与信息原样透出 */
export async function viaMcp<T>(ctx: HubCtx, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401 || e.status === 403) throw new HubError(503, "unavailable", `MCP 中转站拒绝了 hub 的令牌（${ctx.mcpUrl}）：请确认 hub 与 mcp 两个服务的 MCP_TOKEN 一致`);
      if (e.status === 503 && /无法连接/.test(e.message)) throw new HubError(503, "unavailable", `MCP 中转站不可达（${ctx.mcpUrl}）：${e.message}`);
      throw new HubError(e.status, e.code, e.message);
    }
    throw new HubError(503, "unavailable", `MCP 中转站不可达（${ctx.mcpUrl}）：${(e as Error).message}`);
  }
}
