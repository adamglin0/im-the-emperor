// MCP（Model Context Protocol）工具接入契约：hub 存配置、mcp 中转站（broker）连服务器、部门把 MCP 工具装成官员工具。
// 本文件不得引入 node 模块（Web 也会导入）。
//
// 数据流：
//   皇帝/授权官员 ──hub /api/mcp/*──▶ hub 表 mcp_servers（仅配置；密钥只写不读）
//   hub ──/admin/reload──▶ broker 拉 /api/internal/mcp/state（含密钥）；hub ──/control/mcp──▶ 各部门刷新工具
//   官员 ──broker /v1/tools、/v1/call（部门 token + X-Acting-Post）──▶ broker 按授权范围放行 ──▶ MCP 服务器
//   stdio 服务器：broker 以 `docker run -i` 为每个服务器起一个独立容器（默认 bridge 网络，不入朝廷网络）。
import { HttpClient } from "./api.ts";

export type McpTransport = "streamable_http" | "stdio";

/** 授权对象：所有人 / 某部门 / 某官员（跟人走，调岗不失效）。一个服务器可多选。 */
export type McpTarget = { kind: "all" } | { kind: "dept"; id: string } | { kind: "official"; id: string };

/** stdio 容器网络：bridge = 可访问外网（npx/uvx 首次需下载）；none = 断网 */
export type McpNetwork = "bridge" | "none";

/** 存储形态（hub 表 mcp_servers.data_json；env/headers 为密钥原文，只给 broker） */
export interface McpServerConfig {
  id: string; // slug：^[a-z][a-z0-9_-]{1,23}$，工具名前缀
  name: string;
  description: string;
  transport: McpTransport;
  enabled: boolean;
  targets: McpTarget[];
  /** 只开放这些工具（MCP 原名）；空/缺省 = 全部 */
  tool_allow?: string[];
  /** 单次调用超时（秒），默认 60，上限 600 */
  timeout_seconds?: number;
  // streamable_http
  url?: string;
  headers?: Record<string, string>;
  // stdio（独立 docker 容器）
  image?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  network?: McpNetwork;
  memory_mb?: number;
  cpus?: number;
  // 元数据
  version: number;
  created_at: number;
  updated_at: number;
  updated_by: string; // Address
}

/** 对外视图：密钥只给出键名 */
export type McpServerView = Omit<McpServerConfig, "headers" | "env"> & {
  header_keys: string[];
  env_keys: string[];
};

/**
 * 新建/修改入参。
 * headers/env：键 → 值；值为 null 表示「沿用已存的值」（仅修改时有效）；未出现的键即删除。整个字段缺省 = 不改。
 */
export interface McpServerInput {
  id?: string; // 新建必填；修改时以路径为准
  name?: string;
  description?: string;
  transport?: McpTransport;
  enabled?: boolean;
  targets?: McpTarget[];
  tool_allow?: string[];
  timeout_seconds?: number;
  url?: string;
  headers?: Record<string, string | null>;
  image?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string | null>;
  network?: McpNetwork;
  memory_mb?: number;
  cpus?: number;
}

/** 写请求公共字段（官员调用时用于审批说明与幂等） */
export interface McpWriteMeta {
  idem_key?: string;
  trace_id?: string;
  /** 官员申请时的理由（进皇帝待批） */
  reason?: string;
  expected_version?: number;
}

export type McpWriteRes =
  | { status: "applied"; server: McpServerView }
  | { status: "deleted"; id: string }
  | { status: "pending_approval"; approval_id: string; notification_id: string };

/** 中转站侧的工具描述（broker 已按 tool_allow 过滤） */
export interface McpToolInfo {
  name: string; // MCP 原名
  title?: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type McpConnState = "idle" | "connecting" | "ready" | "error" | "disabled";

export interface McpServerStatus {
  id: string;
  version: number;
  state: McpConnState;
  error?: string;
  tool_count?: number;
  /** stdio：当前容器名 */
  container?: string;
  connected_at?: number;
  last_used_at?: number;
  calls?: number;
  errors?: number;
}

export interface McpTestRes {
  ok: boolean;
  error?: string;
  server_info?: { name: string; version: string };
  tools: McpToolInfo[];
  duration_ms: number;
}

/** broker → 官员：本人可用的服务器与工具 */
export interface McpCatalog {
  /** 授权与配置的版本指纹；不变则无需重建工具 */
  version: string;
  servers: { id: string; name: string; description: string; tools: McpToolInfo[]; error?: string }[];
}

export interface McpCallReq {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  trace_id?: string;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; uri: string; text?: string; mimeType?: string }
  | { type: "other"; summary: string };

export interface McpCallRes {
  content: McpContent[];
  structured?: unknown;
  is_error: boolean;
  duration_ms: number;
}

/** hub → broker 的全量状态（含密钥；仅 broker token 可取） */
export interface McpInternalState {
  version: number; // 配置总版本（任一服务器变化即 +1）
  servers: McpServerConfig[];
  /** 部门 token → 部门 */
  tokens: Record<string, string>;
  /** 职位 → { 部门, 现任官员 } */
  posts: Record<string, { dept: string; official_id?: string }>;
}

/** 某职位可用的 MCP 服务器（hub 侧解析，供 UI 与官员查询） */
export interface McpAccess {
  post_id: string;
  official_id?: string;
  servers: { id: string; name: string; via: McpTarget[] }[];
}

// ───────────────────────── 常量与纯函数（hub/broker/dept/web 共用） ─────────────────────────

export const MCP_LIMITS = {
  maxServers: 64,
  maxTargets: 128,
  maxArgs: 64,
  maxEnv: 64,
  maxHeaders: 32,
  maxToolAllow: 256,
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 600,
  defaultMemoryMb: 512,
  maxMemoryMb: 4096,
  defaultCpus: 1,
  maxCpus: 4,
  /** 每个服务器给每位官员最多装多少工具（防工具清单爆炸） */
  maxToolsPerServer: 64,
} as const;

export const MCP_DEFAULT_IMAGE = "node:24-slim";
/** 常用镜像预设（UI 提示用） */
export const MCP_IMAGE_PRESETS = [
  { image: "node:24-slim", label: "Node（npx）", command: "npx", args: ["-y", "<包名>"] },
  { image: "ghcr.io/astral-sh/uv:python3.12-bookworm-slim", label: "Python（uvx）", command: "uvx", args: ["<包名>"] },
] as const;

export const MCP_ID_RE = /^[a-z][a-z0-9_-]{1,23}$/;
export const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MCP_HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** 官员工具名前缀：mcp__<server>__<tool> */
export const MCP_TOOL_PREFIX = "mcp__";

/** 官员侧工具名（提供商要求 ^[a-zA-Z0-9_-]{1,64}$）；过长时截断并附短哈希保证唯一 */
export function mcpToolName(serverId: string, tool: string): string {
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `${MCP_TOOL_PREFIX}${serverId}__${clean}`;
  if (full.length <= 64 && clean === tool) return full;
  const h = shortHash(tool);
  const head = `${MCP_TOOL_PREFIX}${serverId}__`;
  return `${head}${clean.slice(0, Math.max(1, 64 - head.length - 7))}_${h}`;
}

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(0, 6);
}

/** 授权判定：返回命中的授权项（空 = 无权） */
export function mcpMatchTargets(targets: McpTarget[], who: { dept: string; official_id?: string }): McpTarget[] {
  return targets.filter((t) =>
    t.kind === "all" || (t.kind === "dept" && t.id === who.dept) || (t.kind === "official" && !!who.official_id && t.id === who.official_id));
}

export function mcpTargetKey(t: McpTarget): string {
  return t.kind === "all" ? "all" : `${t.kind}:${t.id}`;
}

export function toMcpServerView(c: McpServerConfig): McpServerView {
  const { headers, env, ...rest } = c;
  return { ...rest, header_keys: Object.keys(headers ?? {}).sort(), env_keys: Object.keys(env ?? {}).sort() };
}

// ───────────────────────── broker 客户端 ─────────────────────────

/** 官员 → broker（部门 token + X-Acting-Post） */
export class McpClient extends HttpClient {
  catalog = () => this.req<McpCatalog>("GET", "/v1/tools");
  call = (r: McpCallReq) => this.req<McpCallRes>("POST", "/v1/call", r);
}

/** hub → broker 管理面（broker token） */
export class McpAdminClient extends HttpClient {
  health = () => this.req<{ ok: boolean; version: number; runner: string }>("GET", "/health");
  reload = () => this.req<{ ok: true; version: number }>("POST", "/admin/reload", {});
  status = () => this.req<McpServerStatus[]>("GET", "/admin/status");
  /** 测试一份配置（可为未保存的草稿）：连上、列工具、断开 */
  test = (config: McpServerConfig) => this.req<McpTestRes>("POST", "/admin/test", { config });
  /** 断开并重连（stdio 即重启容器） */
  restart = (id: string) => this.req<McpServerStatus>("POST", `/admin/servers/${encodeURIComponent(id)}/restart`, {});
}
