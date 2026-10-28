// MCP 中转站（broker）HTTP 服务：官员 /v1/*（部门 token + X-Acting-Post）、hub /admin/*（broker token）。
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HubClient, MCP_ID_RE, MCP_PORT, type McpCallReq, type McpServerConfig } from "@court/shared";
import { McpBroker } from "./broker.ts";
import { DEFAULT_CONTAINER_OWNER, removeStaleContainers } from "./docker.ts";
import { BrokerError, errorMessage } from "./errors.ts";
import { HubStateStore, type CallerIdentity } from "./hub-state.ts";
import { logEvent } from "./log.ts";
import type { StdioRunner } from "./transports.ts";

export interface StartMcpOptions {
  port?: number;
  hostname?: string;
  hubUrl: string;
  /** broker token：hub ↔ broker 双向共用 */
  token: string;
  runner: StdioRunner;
  /** 禁止经 HTTP 传输访问的主机名（大小写不敏感，精确匹配） */
  blockedHosts?: string[];
  dockerBin?: string;
  /** 容器归属标签值，默认 "court"；同一宿主上的多个中转站（如测试）须各用不同值，启动清理只删本归属的遗留容器 */
  containerOwner?: string;
  /** 轮询 hub 状态间隔，默认 30s */
  pollMs?: number;
  /** stdio 闲置关闭时间，默认 10 分钟 */
  idleMs?: number;
}

export interface McpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const HUB_TIMEOUT_MS = 10_000;

type Env = { Variables: { caller: CallerIdentity } };

export async function startMcp(opts: StartMcpOptions): Promise<McpHandle> {
  if (!opts.token) throw new Error("MCP 中转站必须配置 broker token（MCP_TOKEN）");
  if (opts.runner !== "docker" && opts.runner !== "local") throw new Error(`MCP_STDIO_RUNNER 只能是 docker 或 local，收到 ${String(opts.runner)}`);
  const dockerBin = opts.dockerBin || "docker";
  const containerOwner = opts.containerOwner || DEFAULT_CONTAINER_OWNER;
  const blockedHosts = new Set((opts.blockedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));

  if (opts.runner === "local") logEvent("warn", "runner.local", { message: "stdio MCP 服务器将直接在本进程宿主上运行（无容器隔离），仅限测试/开发" });
  else {
    try {
      const removed = await removeStaleContainers(dockerBin, containerOwner);
      if (removed) logEvent("info", "docker.stale_removed", { count: removed });
    } catch (e) {
      logEvent("warn", "docker.unavailable", { error: errorMessage(e) });
    }
  }

  const hub = new HubClient({ baseUrl: opts.hubUrl, token: opts.token, timeoutMs: HUB_TIMEOUT_MS });
  // 回调只在 store.start() 之后触发，此时 broker 已初始化
  const store = new HubStateStore(hub, opts.pollMs ?? DEFAULT_POLL_MS, () => broker.reconcile());
  const broker = new McpBroker(store, { runner: opts.runner, dockerBin, containerOwner, blockedHosts, idleMs: opts.idleMs ?? DEFAULT_IDLE_MS });
  const app = buildApp({ store, broker, token: opts.token, runner: opts.runner });

  store.start();
  const server = serve({ fetch: app.fetch, port: opts.port ?? MCP_PORT, hostname: opts.hostname ?? "0.0.0.0" });
  await new Promise<void>((res, rej) => {
    server.once("listening", () => res());
    server.once("error", rej);
  });
  const port = (server.address() as AddressInfo).port;
  logEvent("info", "started", { port, runner: opts.runner, hub: opts.hubUrl, blocked_hosts: blockedHosts.size });
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      (closing ??= (async () => {
        store.stop();
        const closed = new Promise<void>((r) => server.close(() => r()));
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        await broker.closeAll();
        await closed;
        logEvent("info", "stopped", { port });
      })()),
  };
}

function buildApp(deps: { store: HubStateStore; broker: McpBroker; token: string; runner: StdioRunner }): Hono<Env> {
  const { store, broker } = deps;
  const app = new Hono<Env>();
  const wantAdmin = Buffer.from(`Bearer ${deps.token}`);

  app.onError((e, c) => fail(c, e));
  app.notFound((c) => c.json({ error: `MCP 中转站没有接口 ${c.req.method} ${c.req.path}`, code: "not_found" }, 404));

  app.get("/health", (c) => c.json({ ok: true, role: "mcp", version: store.current.version, runner: deps.runner, hub_ok: store.isLoaded && !store.lastError }));

  app.use("*", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: "请求体超过 4MB", code: "too_large" }, 413) }));

  // ── 管理面：hub 持 broker token ──
  app.use("/admin/*", async (c, next) => {
    const auth = Buffer.from(c.req.header("authorization") ?? "");
    if (auth.length !== wantAdmin.length || !timingSafeEqual(auth, wantAdmin)) return c.json({ error: "MCP 中转站管理接口鉴权失败", code: "unauthorized" }, 401);
    await next();
  });

  app.post("/admin/reload", async (c) => {
    try {
      const state = await store.refresh();
      return c.json({ ok: true as const, version: state.version });
    } catch (e) {
      throw new BrokerError(503, "unavailable", `无法从 hub 拉取 MCP 配置：${errorMessage(e)}`);
    }
  });
  app.get("/admin/status", (c) => c.json(broker.listStatuses()));
  app.post("/admin/test", async (c) => {
    const body = await readJsonObject(c);
    return c.json(await broker.testConfig(parseTestConfig(body.config)));
  });
  app.post("/admin/servers/:id/restart", async (c) => c.json(await broker.restartServer(c.req.param("id"))));

  // ── 官员面：部门 token + X-Acting-Post ──
  app.use("/v1/*", async (c, next) => {
    c.set("caller", await identifyCaller(store, c.req.header("authorization"), c.req.header("x-acting-post")));
    await next();
  });

  app.get("/v1/tools", async (c) => c.json(await broker.getCatalog(c.get("caller"))));
  app.post("/v1/call", async (c) => c.json(await broker.callTool(c.get("caller"), parseCallReq(await readJsonObject(c)))));

  return app;
}

async function identifyCaller(store: HubStateStore, authHeader: string | undefined, actingPost: string | undefined): Promise<CallerIdentity> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader ?? "");
  if (!m) throw new BrokerError(401, "unauthorized", "缺少部门 token（Authorization: Bearer …）");
  const token = m[1];
  let dept = store.getDeptByTokenOrNull(token);
  if (!dept && (await store.refreshIfStale())) dept = store.getDeptByTokenOrNull(token);
  if (!dept) throw new BrokerError(401, "unauthorized", "部门 token 无效");
  const post = (actingPost ?? "").trim();
  if (!post) throw new BrokerError(400, "bad_request", "缺少 X-Acting-Post 头（代哪个职位调用）");
  let info = store.getPostOrNull(post);
  if (!info && (await store.refreshIfStale())) info = store.getPostOrNull(post);
  if (!info || info.dept !== dept) throw new BrokerError(403, "forbidden", `职位 ${post} 不属于部门 ${dept}`);
  return { dept, post, ...(info.official_id ? { official_id: info.official_id } : {}) };
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BrokerError(400, "bad_request", "请求体不是合法 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BrokerError(400, "bad_request", "请求体应为 JSON 对象");
  return body as Record<string, unknown>;
}

function parseCallReq(body: Record<string, unknown>): McpCallReq {
  const { server, tool, arguments: args, trace_id } = body;
  if (typeof server !== "string" || !server) throw new BrokerError(400, "bad_request", "缺少 server（MCP 服务器 id）");
  if (typeof tool !== "string" || !tool) throw new BrokerError(400, "bad_request", "缺少 tool（MCP 工具原名）");
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) throw new BrokerError(400, "bad_request", "arguments 应为 JSON 对象");
  return { server, tool, arguments: (args as Record<string, unknown>) ?? {}, ...(typeof trace_id === "string" ? { trace_id } : {}) };
}

/** /admin/test 的配置：hub 已做完整校验，这里只防住会让 broker 出错的形状问题 */
function parseTestConfig(raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BrokerError(400, "bad_request", "缺少 config（待测试的 MCP 服务器配置）");
  const c = raw as McpServerConfig;
  if (typeof c.id !== "string" || !MCP_ID_RE.test(c.id)) throw new BrokerError(400, "bad_request", "config.id 不合法（应匹配 ^[a-z][a-z0-9_-]{1,23}$）");
  if (c.transport !== "stdio" && c.transport !== "streamable_http") throw new BrokerError(400, "bad_request", "config.transport 只能是 streamable_http 或 stdio");
  for (const field of ["env", "headers"] as const) {
    const v = c[field];
    if (v !== undefined && (v === null || typeof v !== "object" || Object.values(v).some((x) => typeof x !== "string"))) {
      throw new BrokerError(400, "bad_request", `config.${field} 应为 字符串→字符串 的对象`);
    }
  }
  if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some((a) => typeof a !== "string"))) throw new BrokerError(400, "bad_request", "config.args 应为字符串数组");
  return { ...c, version: Number(c.version) || 0, targets: Array.isArray(c.targets) ? c.targets : [], enabled: true };
}

function fail(c: Context, e: unknown) {
  if (e instanceof BrokerError) return c.json({ error: e.message, code: e.code }, e.status);
  logEvent("error", "internal_error", { path: c.req.path, error: errorMessage(e) });
  return c.json({ error: `MCP 中转站内部错误：${errorMessage(e)}`, code: "internal" }, 500);
}
