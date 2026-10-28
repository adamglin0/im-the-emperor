// 中转站业务：按授权给出工具目录、代调工具、管理连接（随配置版本换新、重启、测试）。与 HTTP 层无关。
import { mcpMatchTargets, type McpCallReq, type McpCallRes, type McpCatalog, type McpServerConfig, type McpServerStatus, type McpTestRes } from "@court/shared";
import { connectionKey, ServerConnection, type ConnectionOptions } from "./connection.ts";
import { hashTools, isToolAllowed } from "./convert.ts";
import { BrokerError, errorMessage, redactSecrets } from "./errors.ts";
import type { CallerIdentity, HubStateStore } from "./hub-state.ts";
import { logEvent } from "./log.ts";

/** 目录请求中单个服务器列工具的等待上限；超时后后台继续连接 */
const CATALOG_WAIT_MS = 20_000;
/** 测试连接总时限：stdio 首次启动需拉镜像并下载包（npx/uvx），实测冷启动 1–2 分钟；hub 侧等待 330 秒 */
const TEST_TIMEOUT_MS = 300_000;
/** 重启接口等待重连的上限 */
const RESTART_WAIT_MS = 20_000;

export type BrokerOptions = Omit<ConnectionOptions, "purpose">;

export class McpBroker {
  private connections = new Map<string, ServerConnection>();
  private closed = false;

  constructor(
    private store: HubStateStore,
    private opts: BrokerOptions,
  ) {}

  /** hub 状态变化后：关闭已删除/停用/版本变化的服务器连接 */
  reconcile(): void {
    for (const [id, conn] of this.connections) {
      const config = this.store.getServerConfigOrNull(id);
      if (!config || !config.enabled || connectionKey(config) !== conn.key) {
        this.connections.delete(id);
        logEvent("info", "mcp.retire", { server: id, version: conn.config.version, reason: !config ? "deleted" : !config.enabled ? "disabled" : "version_changed" });
        void conn.close();
      }
    }
  }

  async getCatalog(who: CallerIdentity): Promise<McpCatalog> {
    const state = this.store.current;
    const servers = state.servers
      .filter((s) => s.enabled && mcpMatchTargets(s.targets ?? [], who).length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    const entries = await Promise.all(
      servers.map(async (s) => {
        try {
          const tools = await withTimeout(this.getConnection(s).listAllowedTools(), CATALOG_WAIT_MS, () =>
            new BrokerError(504, "unavailable", `MCP 服务器 ${s.id} 正在启动（首次可能需要拉取镜像或下载依赖），稍后再试`));
          return { id: s.id, name: s.name, description: s.description, tools };
        } catch (e) {
          return { id: s.id, name: s.name, description: s.description, tools: [], error: redactSecrets(errorMessage(e), s) };
        }
      }),
    );
    const fingerprint = entries.map((e) => `${e.id}=${e.error ? "err" : hashTools(e.tools)}`).join(",");
    const version = `${state.version}:${servers.map((s) => connectionKey(s)).join(",")}:${fingerprint}`;
    return { version, servers: entries };
  }

  async callTool(who: CallerIdentity, req: McpCallReq): Promise<McpCallRes> {
    const config = this.getAuthorizedConfig(who, req.server);
    if (!isToolAllowed(req.tool, config.tool_allow)) throw new BrokerError(403, "forbidden", `工具 ${req.tool} 不在 MCP 服务器 ${config.id} 的白名单内`);
    const res = await this.getConnection(config).callTool(req.tool, req.arguments);
    logEvent("info", "mcp.call", { server: config.id, tool: req.tool, post: who.post, is_error: res.is_error, ms: res.duration_ms, ...(req.trace_id ? { trace_id: req.trace_id } : {}) });
    return res;
  }

  listStatuses(): McpServerStatus[] {
    return this.store
      .listServerConfigs()
      .map((s) => {
        const conn = this.connections.get(s.id);
        if (conn && conn.key === connectionKey(s)) return conn.getStatus();
        return { id: s.id, version: s.version, state: s.enabled ? "idle" : "disabled", calls: 0, errors: 0 } satisfies McpServerStatus;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 断开并重连（stdio 即重启容器）；清掉退避与工具缓存 */
  async restartServer(id: string): Promise<McpServerStatus> {
    const config = this.store.getServerConfigOrNull(id);
    if (!config) throw new BrokerError(404, "not_found", `没有 MCP 服务器 ${id}（若刚新建，请稍后重试）`);
    const old = this.connections.get(id);
    this.connections.delete(id);
    await old?.close();
    if (!config.enabled) return { id, version: config.version, state: "disabled", calls: 0, errors: 0 };
    const conn = this.getConnection(config);
    await withTimeout(conn.listAllowedTools(), RESTART_WAIT_MS, () => new BrokerError(504, "unavailable", "仍在启动")).catch(() => undefined);
    logEvent("info", "mcp.restarted", { server: id, version: config.version, state: conn.getStatus().state });
    return conn.getStatus();
  }

  /** 临时连接测试一份配置（可为未保存草稿）：连上、列全部工具、断开 */
  async testConfig(config: McpServerConfig): Promise<McpTestRes> {
    const t0 = Date.now();
    const conn = new ServerConnection({ ...config, enabled: true }, { ...this.opts, purpose: "test", idleMs: 0 });
    try {
      const tools = await withTimeout(conn.listDiscoveredTools(), TEST_TIMEOUT_MS, () => new BrokerError(504, "unavailable", `测试超时（${TEST_TIMEOUT_MS / 1000} 秒）`));
      const info = conn.getServerInfoOrNull();
      return { ok: true, ...(info ? { server_info: info } : {}), tools, duration_ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: redactSecrets(errorMessage(e), config), tools: [], duration_ms: Date.now() - t0 };
    } finally {
      await conn.close();
    }
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(all.map((c) => c.close()));
  }

  private getAuthorizedConfig(who: CallerIdentity, serverId: string): McpServerConfig {
    const config = this.store.getServerConfigOrNull(serverId);
    if (!config || mcpMatchTargets(config.targets ?? [], who).length === 0) {
      throw new BrokerError(404, "not_found", `没有你可用的 MCP 服务器 ${serverId}（未授权或已删除；请刷新工具清单）`);
    }
    if (!config.enabled) throw new BrokerError(409, "invalid_state", `MCP 服务器 ${serverId} 已停用`);
    return config;
  }

  /** 当前配置版本的连接；版本变了就换新（旧连接关闭） */
  private getConnection(config: McpServerConfig): ServerConnection {
    if (this.closed) throw new BrokerError(503, "unavailable", "MCP 中转站正在关闭");
    const existing = this.connections.get(config.id);
    if (existing && existing.key === connectionKey(config)) return existing;
    if (existing) void existing.close();
    const conn = new ServerConnection(config, { ...this.opts, purpose: "serve" });
    this.connections.set(config.id, conn);
    return conn;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
