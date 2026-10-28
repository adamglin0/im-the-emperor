// 单个 MCP 服务器（某一配置版本）的连接：懒连接、工具清单缓存、调用、闲置关闭、失败退避、意外断开处理。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode as McpErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { MCP_LIMITS, type McpCallRes, type McpConnState, type McpServerConfig, type McpServerStatus, type McpToolInfo } from "@court/shared";
import { filterAllowedTools, toCallOutcome, toMcpToolInfo } from "./convert.ts";
import { BrokerError, errorMessage, redactSecrets } from "./errors.ts";
import { logEvent } from "./log.ts";
import { openTransport, type OpenedTransport, type TransportOptions } from "./transports.ts";

const CLIENT_INFO = { name: "court-mcp-broker", version: "1.0.0" };
/** docker 首次启动可能要拉镜像，初始化握手给足时间 */
const DOCKER_CONNECT_TIMEOUT_MS = 300_000;
const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TOOLS_TIMEOUT_MS = 30_000;
const MAX_TOOL_PAGES = 20;
/** 退避：10s → 20s → … → 5 分钟 */
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;
/** 连上后不到这么久就断开，视为崩溃循环，计入退避 */
const CRASH_LOOP_WINDOW_MS = 30_000;
/** 错误信息里附带的 stderr 末尾长度 */
const STDERR_IN_ERROR_CHARS = 1000;

export type ConnectionOptions = Omit<TransportOptions, "purpose"> & {
  purpose: TransportOptions["purpose"];
  /** stdio 闲置多久无调用即关闭（0 = 不关闭） */
  idleMs: number;
};

export class ServerConnection {
  private state: McpConnState = "idle";
  private lastError?: string;
  private client?: Client;
  private opened?: OpenedTransport;
  private connecting?: Promise<Client>;
  /** 按白名单过滤并截断后的工具（官员可见） */
  private allowedTools?: McpToolInfo[];
  /** 服务器公布的全部工具（测试用，截到 maxToolAllow） */
  private discoveredTools?: McpToolInfo[];
  private serverInfo?: { name: string; version: string };
  private failures = 0;
  private retryAt = 0;
  private connectedAt?: number;
  private lastUsedAt?: number;
  private calls = 0;
  private errors = 0;
  private inFlight = 0;
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    readonly config: McpServerConfig,
    private opts: ConnectionOptions,
  ) {}

  get key(): string {
    return connectionKey(this.config);
  }

  get id(): string {
    return this.config.id;
  }

  getStatus(): McpServerStatus {
    const c = this.config;
    return {
      id: c.id,
      version: c.version,
      state: c.enabled ? this.state : "disabled",
      ...(this.state === "error" && this.lastError ? { error: this.lastError } : {}),
      ...(this.allowedTools ? { tool_count: this.allowedTools.length } : {}),
      ...(this.opened?.containerName ? { container: this.opened.containerName } : {}),
      ...(this.connectedAt ? { connected_at: this.connectedAt } : {}),
      ...(this.lastUsedAt ? { last_used_at: this.lastUsedAt } : {}),
      calls: this.calls,
      errors: this.errors,
    };
  }

  getServerInfoOrNull(): { name: string; version: string } | null {
    return this.serverInfo ?? null;
  }

  /** 已缓存的工具清单（闲置关闭后仍保留）；未连过则为 null */
  getCachedToolsOrNull(): McpToolInfo[] | null {
    return this.allowedTools ?? null;
  }

  /** 官员可见的工具：有缓存直接给，否则连接后列出 */
  async listAllowedTools(): Promise<McpToolInfo[]> {
    if (this.allowedTools) return this.allowedTools;
    await this.ensureConnected(false);
    this.armIdleTimer();
    return this.allowedTools ?? [];
  }

  /** 服务器公布的全部工具（不受白名单限制），供测试接口返回 */
  async listDiscoveredTools(): Promise<McpToolInfo[]> {
    await this.ensureConnected(true);
    return this.discoveredTools ?? [];
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpCallRes> {
    const t0 = Date.now();
    const timeoutSeconds = Math.min(this.config.timeout_seconds ?? MCP_LIMITS.defaultTimeoutSeconds, MCP_LIMITS.maxTimeoutSeconds);
    this.inFlight++;
    this.lastUsedAt = t0;
    this.clearIdleTimer();
    try {
      let client = await this.ensureConnected(false);
      if (!this.allowedTools?.some((t) => t.name === tool)) {
        throw new BrokerError(404, "not_found", `MCP 服务器 ${this.config.id} 没有可用工具 ${tool}（先刷新工具清单再试）`);
      }
      let result: Record<string, unknown>;
      try {
        result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutSeconds * 1000 });
      } catch (e) {
        if (!isConnectionLost(e) || this.disposed) throw e;
        logEvent("warn", "mcp.call_reconnect", { server: this.config.id, version: this.config.version, tool });
        // 只关自己用过的那个 client：若断开回调已清理、别的调用已在重连，不能把新连接（新容器）一起关掉
        if (this.client === client) await this.closeClient("reconnect");
        client = await this.ensureConnected(true);
        result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutSeconds * 1000 });
      }
      const outcome = toCallOutcome(result);
      this.calls++;
      if (outcome.is_error) this.errors++;
      return { ...outcome, duration_ms: Date.now() - t0 };
    } catch (e) {
      this.errors++;
      if (e instanceof BrokerError) throw e;
      if (e instanceof McpError && e.code === McpErrorCode.RequestTimeout) {
        throw new BrokerError(504, "unavailable", `MCP 工具 ${this.config.id}/${tool} 调用超时（${timeoutSeconds} 秒）`);
      }
      if (e instanceof McpError && e.code !== McpErrorCode.ConnectionClosed) {
        // 协议层错误（参数不合法等）交给模型自行纠正
        this.calls++;
        return { content: [{ type: "text", text: `MCP 服务器报错（${e.code}）：${this.redact(e.message)}` }], is_error: true, duration_ms: Date.now() - t0 };
      }
      throw new BrokerError(503, "unavailable", `MCP 服务器 ${this.config.id} 连接中断：${this.redact(errorMessage(e))}`);
    } finally {
      this.inFlight--;
      this.lastUsedAt = Date.now();
      this.armIdleTimer();
    }
  }

  /** 关闭连接并作废本对象（配置变更/删除/重启/中转站退出） */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    await this.closeClient("closed");
  }

  /**
   * 确保已连接，返回就绪的 Client。并发调用共享同一次连接尝试。
   * ignoreBackoff：用户显式操作（调用时断线重连、测试）不受退避限制。
   */
  private ensureConnected(ignoreBackoff: boolean): Promise<Client> {
    if (this.disposed) return Promise.reject(new BrokerError(503, "unavailable", `MCP 服务器 ${this.config.id} 的连接已关闭（配置已变更），请重试`));
    if (this.client && this.state === "ready") return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    if (!ignoreBackoff && Date.now() < this.retryAt) {
      const secs = Math.ceil((this.retryAt - Date.now()) / 1000);
      return Promise.reject(new BrokerError(503, "unavailable", `${this.lastError ?? "连接失败"}（${secs} 秒后才会重试）`));
    }
    this.state = "connecting";
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<Client> {
    const c = this.config;
    const t0 = Date.now();
    let opened: OpenedTransport | undefined;
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      opened = openTransport(c, this.opts);
      this.opened = opened;
      logEvent("info", "mcp.connecting", { server: c.id, version: c.version, transport: c.transport, purpose: this.opts.purpose, ...(opened.containerName ? { container: opened.containerName } : {}) });
      client.onclose = () => this.handleClientClosed(client);
      client.onerror = (err) => logEvent("warn", "mcp.transport_error", { server: c.id, version: c.version, error: this.redact(errorMessage(err)) });
      const isDocker = c.transport === "stdio" && this.opts.runner === "docker";
      await client.connect(opened.transport, { timeout: isDocker ? DOCKER_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS });
      const discovered = await listAllTools(client);
      if (this.disposed) throw new BrokerError(503, "unavailable", `MCP 服务器 ${c.id} 的连接已关闭（配置已变更），请重试`);
      this.discoveredTools = discovered.slice(0, MCP_LIMITS.maxToolAllow);
      this.allowedTools = filterAllowedTools(discovered, c.tool_allow, MCP_LIMITS.maxToolsPerServer);
      const info = client.getServerVersion();
      this.serverInfo = info ? { name: String(info.name ?? ""), version: String(info.version ?? "") } : undefined;
      this.client = client;
      this.state = "ready";
      this.lastError = undefined;
      // failures 不在此清零：连上即崩的循环要靠它逐级加长退避；连接存活够久后才清零
      this.retryAt = 0;
      this.connectedAt = Date.now();
      logEvent("info", "mcp.connected", { server: c.id, version: c.version, tools: this.allowedTools.length, ms: Date.now() - t0 });
      return client;
    } catch (e) {
      const tail = this.formatStderrTail(opened?.readStderrTail() ?? "");
      if (this.opened === opened) this.opened = undefined;
      await client.close().catch(() => undefined);
      await opened?.transport.close().catch(() => undefined);
      await opened?.afterClose().catch(() => undefined);
      if (e instanceof BrokerError && (e.status === 400 || e.status === 403)) {
        // 配置本身不可用：不退避（改配置会换新连接对象）
        this.state = "error";
        this.lastError = e.message;
        throw e;
      }
      const reason = describeConnectError(e, tail);
      this.recordFailure(this.redact(reason));
      logEvent("warn", "mcp.connect_failed", { server: c.id, version: c.version, error: this.lastError, failures: this.failures, retry_in_s: Math.round((this.retryAt - Date.now()) / 1000) });
      throw new BrokerError(503, "unavailable", this.lastError ?? "连接失败");
    }
  }

  private recordFailure(message: string): void {
    this.failures++;
    this.state = "error";
    this.lastError = `MCP 服务器 ${this.config.id} 连接失败：${message}`;
    this.retryAt = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
  }

  /** client 关闭回调：只处理当前活动 client 的意外断开（主动关闭时 this.client 已先置空） */
  private handleClientClosed(client: Client): void {
    if (client !== this.client) return;
    const opened = this.opened;
    const tail = this.formatStderrTail(opened?.readStderrTail() ?? "");
    this.client = undefined;
    this.opened = undefined;
    this.clearIdleTimer();
    void opened?.afterClose().catch(() => undefined);
    const lived = Date.now() - (this.connectedAt ?? 0);
    if (lived < CRASH_LOOP_WINDOW_MS) {
      this.recordFailure(`连上后 ${Math.round(lived / 1000)} 秒即断开${tail ? `；stderr：${tail}` : ""}`);
    } else {
      this.failures = 0;
      this.state = "idle";
    }
    logEvent("warn", "mcp.disconnected", { server: this.config.id, version: this.config.version, lived_s: Math.round(lived / 1000), state: this.state });
  }

  private async closeClient(reason: "idle" | "closed" | "reconnect"): Promise<void> {
    const client = this.client;
    const opened = this.opened;
    this.client = undefined;
    this.opened = undefined;
    if (this.state === "ready" || this.state === "connecting") this.state = "idle";
    if (client && this.connectedAt && Date.now() - this.connectedAt >= CRASH_LOOP_WINDOW_MS) this.failures = 0;
    if (!client && !opened) return;
    try {
      await opened?.beforeClose().catch(() => undefined);
      if (client) await client.close().catch(() => undefined);
      else await opened?.transport.close().catch(() => undefined);
    } finally {
      await opened?.afterClose().catch(() => undefined);
    }
    logEvent("info", "mcp.closed", { server: this.config.id, version: this.config.version, reason });
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.client || this.config.transport !== "stdio" || this.opts.idleMs <= 0 || this.inFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.inFlight === 0 && !this.disposed) void this.closeClient("idle");
    }, this.opts.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private redact(text: string): string {
    return redactSecrets(text, this.config);
  }

  /** 先抹密钥再截断：若先截断，被截成半截的密钥就匹配不上、会原样漏出 */
  private formatStderrTail(tail: string): string {
    return this.redact(tail).slice(-STDERR_IN_ERROR_CHARS);
  }
}

export function connectionKey(c: Pick<McpServerConfig, "id" | "version">): string {
  return `${c.id}@${c.version}`;
}

async function listAllTools(client: Client): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TOOLS_TIMEOUT_MS });
    for (const t of res.tools) out.push(toMcpToolInfo(t));
    cursor = res.nextCursor;
    if (!cursor || out.length >= MCP_LIMITS.maxToolAllow) break;
  }
  return out;
}

/** 连接已不可用、应重连一次再试：传输关闭，或 streamable HTTP 会话失效（服务端重启后对旧会话回 404，协议要求客户端开新会话） */
function isConnectionLost(e: unknown): boolean {
  if (e instanceof McpError) return e.code === McpErrorCode.ConnectionClosed;
  if (e instanceof StreamableHTTPError) return e.code === 404;
  return /not connected/i.test(errorMessage(e));
}

/** stderrTail 须已抹密钥、已截断（formatStderrTail） */
function describeConnectError(e: unknown, stderrTail: string): string {
  let msg = errorMessage(e);
  if (e instanceof McpError && e.code === McpErrorCode.RequestTimeout) msg = "初始化握手超时（stdio 首次启动可能在拉取镜像或下载依赖）";
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") msg = `找不到可执行文件（${msg}）`;
  return stderrTail ? `${msg}；stderr：${stderrTail}` : msg;
}
