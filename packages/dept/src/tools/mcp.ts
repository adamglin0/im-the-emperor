// MCP 服务器配置工具（mcp_admin 组，docs/mcp.md §2.2/§4）：增删改查、授权、测试、查可用范围。
// 官员新建/放大权限 → 皇帝待批；收缩/删除直接生效（hub 判定）。密钥只写不读。
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  MCP_LIMITS,
  mcpTargetKey,
  type McpServerInput,
  type McpServerView,
  type McpTarget,
  type McpWriteMeta,
  type McpWriteRes,
} from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { ToolError, defineTool, fmtTime, ok, resolveDept, resolveOfficialId, resolvePost, snip, untrustedBlock, writeMeta } from "./_util.ts";

export const MCP_PENDING_HINT = "已呈皇帝待批，批复后会通知你；无需重复提交。";
const APPLIED_HINT = "已生效；获授权官员的 MCP 工具会在其下一轮开始时自动刷新。";

/**
 * 密钥键值（headers/env）用 [{key, value}] 列表而非 Record：Record 生成 patternProperties，
 * 部分模型提供商（如 Gemini）拒收；对象数组各家都支持。调用 hub 前再转成 Record。
 */
const secretEntries = (what: string, keyExample: string) =>
  Type.Array(
    Type.Object({
      key: Type.String({ description: `键名，如 ${keyExample}` }),
      value: Type.Optional(Type.String({ description: "值。不填表示沿用已存的值（密钥只写不读，修改时不知道原值就不填）" })),
    }),
    { description: `${what}：键值对列表。给出此字段时整体替换（未列出的键会被删除）；不填此字段则保持不变。` },
  );

type SecretEntry = { key: string; value?: string | null };

/** [{key, value}] → { key: value | null }（null = 沿用已存的值）；键名为空或重复时报错 */
function secretEntriesToRecord(entries: SecretEntry[], field: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const { key, value } of entries) {
    const name = key.trim();
    if (!name) throw new ToolError(`${field} 中有空键名`);
    if (Object.hasOwn(out, name)) throw new ToolError(`${field} 中键 ${name} 重复`, "每个键只写一次。");
    out[name] = value ?? null;
  }
  return out;
}

const SECRET_WRITE_TOOLS = new Set(["mcp_create_server", "mcp_update_server"]);

/** 记日志/推实时流前遮去 headers/env 的值（密钥只写不读，不得落进官员日志或界面） */
export function redactMcpSecretsInArgs(toolName: string, args: unknown): unknown {
  if (!SECRET_WRITE_TOOLS.has(toolName) || !args || typeof args !== "object") return args;
  const redacted: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const field of ["headers", "env"]) {
    const entries = redacted[field];
    if (Array.isArray(entries)) {
      redacted[field] = entries.map((e) => (e && typeof e === "object" && (e as SecretEntry).value != null ? { ...e, value: "***" } : e));
    } else if (entries && typeof entries === "object") {
      redacted[field] = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v == null ? v : "***"]));
    }
  }
  return redacted;
}

const targetSchema = Type.Object({
  kind: StringEnum(["all", "dept", "official"] as const, { description: "授权对象类型：all=所有官员；dept=某部门全体；official=某位官员（跟人走，调岗不失效）" }),
  id: Type.Optional(Type.String({ description: "kind=dept 时填部门 ID 或中文名；kind=official 时填 official_id、官员姓名或其职位 ID；kind=all 不填" })),
});

/** 新建/修改共用的配置字段（全部可选；新建时的必填项在 run 里检查） */
const configFields = {
  name: Type.Optional(Type.String({ description: "显示名称（1–60 字）" })),
  description: Type.Optional(Type.String({ description: "用途说明（≤500 字），会显示给获授权官员" })),
  transport: Type.Optional(StringEnum(["streamable_http", "stdio"] as const, { description: "连接方式：streamable_http=远程 HTTP 地址；stdio=在独立 docker 容器里运行命令" })),
  enabled: Type.Optional(Type.Boolean({ description: "是否启用" })),
  targets: Type.Optional(Type.Array(targetSchema, { description: `授权对象（整体替换，可多选，≤${MCP_LIMITS.maxTargets}）` })),
  tool_allow: Type.Optional(Type.Array(Type.String({ description: "MCP 工具原名" }), { description: "只开放这些工具（整体替换）；空数组 = 全部开放" })),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MCP_LIMITS.maxTimeoutSeconds, description: `单次调用超时秒数（默认 ${MCP_LIMITS.defaultTimeoutSeconds}）` })),
  url: Type.Optional(Type.String({ description: "streamable_http：服务器地址（http/https，须从中转站容器可达）" })),
  headers: Type.Optional(secretEntries("streamable_http：请求头", "Authorization")),
  image: Type.Optional(Type.String({ description: "stdio：容器镜像，如 node:24-slim（npx）或 ghcr.io/astral-sh/uv:python3.12-bookworm-slim（uvx）" })),
  command: Type.Optional(Type.String({ description: "stdio：容器内执行的命令，如 npx" })),
  args: Type.Optional(Type.Array(Type.String({ description: "一个参数" }), { description: "stdio：命令参数（整体替换），如 [\"-y\", \"@modelcontextprotocol/server-everything\"]" })),
  env: Type.Optional(secretEntries("stdio：环境变量（API 密钥等）", "GITHUB_TOKEN")),
  network: Type.Optional(StringEnum(["bridge", "none"] as const, { description: "stdio：容器网络。bridge=可访问外网（npx/uvx 首次需下载）；none=断网" })),
  memory_mb: Type.Optional(Type.Integer({ minimum: 64, maximum: MCP_LIMITS.maxMemoryMb, description: `stdio：内存上限 MB（默认 ${MCP_LIMITS.defaultMemoryMb}）` })),
  cpus: Type.Optional(Type.Number({ minimum: 0.1, maximum: MCP_LIMITS.maxCpus, description: `stdio：CPU 上限（默认 ${MCP_LIMITS.defaultCpus}）` })),
};
const configSchema = Type.Object(configFields);
type ConfigParams = Static<typeof configSchema>;

const CONFIG_KEYS = Object.keys(configFields) as (keyof ConfigParams)[];

export function mcpAdminTools(ctx: ToolContext): AgentTool<any>[] {
  const toTargets = (raw: { kind: string; id?: string }[]): McpTarget[] =>
    raw.map((t) => {
      if (t.kind === "all") return { kind: "all" };
      const id = t.id?.trim();
      if (!id) throw new ToolError(`授权对象 kind=${t.kind} 缺少 id`, "dept 填部门 ID/名称，official 填 official_id/姓名/职位。");
      if (t.kind === "dept") return { kind: "dept", id: resolveDept(ctx, id).id };
      if (t.kind === "official") return { kind: "official", id: resolveOfficialId(ctx, id) };
      throw new ToolError(`未知的授权对象类型 ${t.kind}`, "可选 all / dept / official。");
    });

  /** 工具参数 → McpServerInput（只带出给出的字段） */
  const toInput = (p: ConfigParams): McpServerInput => {
    const out: Record<string, unknown> = {};
    for (const k of CONFIG_KEYS) if (p[k] !== undefined) out[k] = p[k];
    if (p.targets) out.targets = toTargets(p.targets);
    if (p.headers) out.headers = secretEntriesToRecord(p.headers, "headers");
    if (p.env) out.env = secretEntriesToRecord(p.env, "env");
    return out as McpServerInput;
  };

  const meta = (toolCallId: string, reason: string, expected_version?: number): McpWriteMeta => {
    const m = writeMeta(ctx, toolCallId);
    return { idem_key: m.idem_key, trace_id: m.trace_id, reason, ...(expected_version !== undefined ? { expected_version } : {}) };
  };

  const view = (s: McpServerView) => ({
    id: s.id,
    name: s.name,
    description: snip(s.description, 300),
    transport: s.transport,
    enabled: s.enabled,
    targets: s.targets.map(mcpTargetKey),
    tool_allow: s.tool_allow,
    timeout_seconds: s.timeout_seconds,
    url: s.url,
    header_keys: s.header_keys,
    image: s.image,
    command: s.command,
    args: s.args,
    env_keys: s.env_keys,
    network: s.network,
    memory_mb: s.memory_mb,
    cpus: s.cpus,
    version: s.version,
    updated_at: fmtTime(s.updated_at),
    updated_by: s.updated_by,
  });

  const writeResult = (r: McpWriteRes, what: string) => {
    if (r.status === "pending_approval") {
      return ok(`${what}须皇帝批准，已呈皇帝待批（approval_id ${r.approval_id}）`, { status: r.status, approval_id: r.approval_id }, { hint: MCP_PENDING_HINT });
    }
    if (r.status === "deleted") return ok(`${what}：已删除 MCP 服务器 ${r.id}`, { status: r.status, id: r.id }, { hint: APPLIED_HINT });
    return ok(`${what}：已生效（v${r.server.version}）`, view(r.server), { hint: APPLIED_HINT });
  };

  return [
    defineTool({
      name: "mcp_list_servers",
      label: "MCP 服务器列表",
      description: "列出全部 MCP 服务器配置（id、名称、连接方式、启用、授权对象、工具白名单；密钥只给键名）。with_status=true 时附中转站连接状态与工具数。",
      parameters: Type.Object({
        with_status: Type.Optional(Type.Boolean({ description: "是否附带中转站实时状态（默认 true）" })),
      }),
      async run(p) {
        const servers = await ctx.hub.mcpServers();
        let status: Map<string, { state: string; tool_count?: number; error?: string }> | undefined;
        let statusNote: string | undefined;
        if (p.with_status !== false) {
          try {
            status = new Map((await ctx.hub.mcpStatus()).map((s) => [s.id, s]));
          } catch (e) {
            statusNote = `中转站状态暂不可得：${(e as Error).message}`;
          }
        }
        const rows = servers.map((s) => {
          const st = status?.get(s.id);
          return {
            id: s.id,
            name: s.name,
            transport: s.transport,
            enabled: s.enabled,
            targets: s.targets.map(mcpTargetKey),
            tool_allow: s.tool_allow,
            endpoint: s.transport === "stdio" ? `${s.image ?? ""} ${s.command ?? ""} ${(s.args ?? []).join(" ")}`.trim() : s.url,
            version: s.version,
            state: st?.state,
            tool_count: st?.tool_count,
            error: st?.error ? snip(st.error, 200) : undefined,
          };
        });
        return ok(`MCP 服务器 ${rows.length} 个`, rows, statusNote ? { hint: statusNote } : undefined);
      },
    }),

    defineTool({
      name: "mcp_get_server",
      label: "查看 MCP 服务器",
      description: "查看某个 MCP 服务器的完整配置（密钥只给键名）与版本号。修改前先看这里取 version 作 expected_version。",
      parameters: Type.Object({ id: Type.String({ description: "服务器 ID" }) }),
      async run(p) {
        const s = await ctx.hub.mcpServer(p.id);
        return ok(`MCP 服务器 ${s.id}（${s.name}）v${s.version}`, view(s));
      },
    }),

    defineTool({
      name: "mcp_create_server",
      label: "新建 MCP 服务器",
      refetch: "mcp_list_servers",
      description:
        "新建 MCP 服务器配置并指定授权对象。官员新建一律须皇帝批准（返回 pending_approval）。" +
        "streamable_http 需 url（可带 headers）；stdio 需 image + command（+args/env），在独立 docker 容器中运行。" +
        "密钥（headers/env 的值）只写不读。须写明理由。",
      parameters: Type.Object({
        id: Type.String({ description: "服务器 ID：小写字母开头，2–24 位 a-z0-9_-；会成为工具名前缀 mcp__<id>__" }),
        ...configFields,
        name: Type.String({ description: "显示名称（1–60 字）" }),
        transport: StringEnum(["streamable_http", "stdio"] as const, { description: "连接方式：streamable_http=远程 HTTP 地址；stdio=在独立 docker 容器里运行命令" }),
        targets: Type.Array(targetSchema, { description: "授权对象（可多选）：所有人 / 某部门 / 某官员" }),
        reason: Type.String({ description: "申请理由（呈皇帝审批时展示）" }),
      }),
      async run(p, call) {
        const input: McpServerInput = { ...toInput(p), id: p.id };
        if (input.enabled === undefined) input.enabled = true;
        const r = await ctx.hub.createMcpServer({ ...input, ...meta(call.toolCallId, p.reason) });
        return writeResult(r, `新建 MCP 服务器 ${p.id}`);
      },
    }),

    defineTool({
      name: "mcp_update_server",
      label: "修改 MCP 服务器",
      refetch: "mcp_get_server",
      description:
        "修改 MCP 服务器配置：只填要改的字段（数组/对象字段整体替换）。" +
        "只收缩权限（停用、移除授权对象、缩小工具白名单、改名称/说明/超时）直接生效；" +
        "启用、新增授权对象、放宽白名单、改连接参数（url/headers/image/command/args/env/网络/资源）须皇帝批准（返回 pending_approval）。" +
        "headers/env 中某项不填 value 表示沿用原值。建议带 expected_version 防并发覆盖。",
      parameters: Type.Object({
        id: Type.String({ description: "服务器 ID" }),
        ...configFields,
        expected_version: Type.Optional(Type.Integer({ minimum: 1, description: "期望的当前版本号（来自 mcp_get_server）；不符则报版本冲突" })),
        reason: Type.String({ description: "修改理由" }),
      }),
      async run(p, call) {
        const input = toInput(p);
        if (!Object.keys(input).length) throw new ToolError("没有任何要修改的字段");
        const r = await ctx.hub.updateMcpServer(p.id, { ...input, ...meta(call.toolCallId, p.reason, p.expected_version) });
        return writeResult(r, `修改 MCP 服务器 ${p.id}`);
      },
    }),

    defineTool({
      name: "mcp_delete_server",
      label: "删除 MCP 服务器",
      refetch: "mcp_get_server",
      description: "删除 MCP 服务器配置（直接生效，获授权官员随即失去其工具）。不可恢复，须写明理由；只想暂停请用 mcp_update_server 设 enabled=false。",
      parameters: Type.Object({
        id: Type.String({ description: "服务器 ID" }),
        expected_version: Type.Optional(Type.Integer({ minimum: 1, description: "期望的当前版本号；不符则报版本冲突" })),
        reason: Type.String({ description: "删除理由" }),
      }),
      async run(p, call) {
        const r = await ctx.hub.deleteMcpServer(p.id, meta(call.toolCallId, p.reason, p.expected_version));
        return writeResult(r, `删除 MCP 服务器 ${p.id}`);
      },
    }),

    defineTool({
      name: "mcp_test_server",
      label: "测试 MCP 服务器",
      refetch: "mcp_list_servers",
      description: "测试已保存的 MCP 服务器：经中转站临时连接并列出工具（含工具名与参数名）。restart=true 改为断开并重连正式连接（stdio 即重启容器）。stdio 首次可能需下载镜像/依赖，较慢。",
      parameters: Type.Object({
        id: Type.String({ description: "服务器 ID" }),
        restart: Type.Optional(Type.Boolean({ description: "改为重启正式连接（默认 false：仅测试）" })),
      }),
      async run(p) {
        if (p.restart) {
          const s = await ctx.hub.restartMcpServer(p.id);
          return ok(`已重启 MCP 服务器 ${p.id} 的连接：${s.state}`, { state: s.state, tool_count: s.tool_count, error: s.error ? snip(s.error, 500) : undefined, container: s.container });
        }
        const r = await ctx.hub.testMcpServer(p.id);
        const head = r.ok
          ? `测试通过：${r.server_info ? `${r.server_info.name} ${r.server_info.version}，` : ""}工具 ${r.tools.length} 个，耗时 ${r.duration_ms}ms`
          : `测试失败（耗时 ${r.duration_ms}ms）：${snip(r.error, 500) || "未知错误"}`;
        if (!r.tools.length) return ok(head);
        // 工具描述来自外部服务器，属不可信资料
        const lines = r.tools.map((t) => {
          const props = (t.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
          const params = props ? Object.keys(props).join(", ") : "";
          return `- ${t.name}(${params})：${snip(t.description, 120)}`;
        });
        const block = untrustedBlock(ctx, `mcp_test_server:${p.id}`, lines.join("\n"));
        return ok(`${head}\n${block.text}`, undefined, block.hint ? { hint: block.hint } : undefined);
      },
    }),

    defineTool({
      name: "mcp_get_access",
      label: "MCP 授权查询",
      description: "查询某职位（在任官员）可用哪些 MCP 服务器，以及经哪条授权（所有人/部门/本人）获得。不填 post 查自己。",
      parameters: Type.Object({
        post: Type.Optional(Type.String({ description: "职位 ID（或职衔/姓名）；不填为自己" })),
      }),
      async run(p) {
        const post = p.post ? resolvePost(ctx, p.post).post_id : ctx.post.post_id;
        const a = await ctx.hub.mcpAccess(post);
        return ok(`${a.post_id}${a.official_id ? `（${a.official_id}）` : ""} 可用 MCP 服务器 ${a.servers.length} 个`, a.servers.map((s) => ({ id: s.id, name: s.name, via: s.via.map(mcpTargetKey) })));
      },
    }),
  ];
}
