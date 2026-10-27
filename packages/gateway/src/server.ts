// LLM 网关 HTTP 服务：/api/stream（streamProxy 兼容）、/api/complete、/api/models、/health。
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono, type Context as HonoContext } from "hono";
import type { Context, MutableModels } from "@earendil-works/pi-ai";
import { bodyLimit } from "hono/body-limit";
import { API_VERSION, GATEWAY_PORT, HubClient, redact, type CustomProviderSpec, type GatewayCompleteReq, type GatewayCompleteRes, type GatewayMeta, type ModelCheckRes, type ProviderAuthType, type ProviderTestRes } from "@court/shared";
import { TokenRegistry, type Caller } from "./auth.ts";
import { BudgetGate } from "./budget.ts";
import { GatewayRecorder } from "./ledger.ts";
import { LoginError, LoginManager } from "./logins.ts";
import { CatalogError, createModelCatalog, CUSTOM_PROVIDER, type ModelCatalog } from "./models.ts";
import { CallPipeline, pickClientOptions, zeroUsage, type PipelineOptions, type ProxyEvent } from "./pipeline.ts";

export interface StartGatewayOptions {
  port?: number;
  hostname?: string;
  hubUrl?: string;
  dataDir: string;
  configDir?: string;
  mode?: "real" | "mock";
  /** admin：管理接口专用 token（hub 持有，不下发部门）；缺省时退回网关 token */
  tokens: { gateway: string; depts?: Record<string, string>; admin?: string };
  /** 测试注入：替换模型集合（如 fauxProvider） */
  models?: MutableModels;
  /** 测试注入：provider → API 密钥 */
  apiKeys?: Record<string, string>;
  /** 测试注入：管线参数覆盖 */
  pipeline?: Partial<Omit<PipelineOptions, "mode" | "catalog" | "budget" | "recorder">>;
  /** 测试注入：本地限额 */
  budget?: { cacheMs?: number; failOpenTokens?: number; failOpenWindowMs?: number };
  tokenRefreshMs?: number;
}

export interface GatewayHandle {
  url: string;
  port: number;
  close(): Promise<void>;
  /** 测试用：内部组件 */
  pipeline: CallPipeline;
  catalog: ModelCatalog;
  logins: LoginManager;
  recorder: GatewayRecorder;
  tokens: TokenRegistry;
}

const PURPOSES = new Set<GatewayMeta["purpose"]>(["turn", "compaction", "exam", "grading", "other"]);

/** 解析并校验元数据；返回错误文本或规范化后的 meta。 */
export function authorizeMeta(caller: Caller, raw: unknown): GatewayMeta | string {
  if (!raw || typeof raw !== "object") return "缺少 metadata（GatewayMeta：post_id、purpose 等）";
  const m = raw as Record<string, unknown>;
  if (typeof m.post_id !== "string" || !m.post_id) return "metadata.post_id 必填";
  const purpose = (typeof m.purpose === "string" && PURPOSES.has(m.purpose as GatewayMeta["purpose"]) ? m.purpose : "turn") as GatewayMeta["purpose"];
  const meta: GatewayMeta = {
    post_id: m.post_id,
    official_id: typeof m.official_id === "string" ? m.official_id : undefined,
    dept: typeof m.dept === "string" ? m.dept : undefined,
    trace_id: typeof m.trace_id === "string" ? m.trace_id : undefined,
    turn_id: typeof m.turn_id === "string" ? m.turn_id : undefined,
    call_idx: typeof m.call_idx === "number" ? m.call_idx : undefined,
    purpose,
  };
  if (caller.kind === "dept") {
    if (!meta.post_id.startsWith(`${caller.dept}.`)) return `职位 ${meta.post_id} 不属于部门 ${caller.dept}`;
    meta.dept = caller.dept;
  } else {
    meta.dept ??= meta.post_id.startsWith("system.") ? "system" : meta.post_id.split(".")[0];
  }
  return meta;
}

function parseHeaderMeta(header: string | undefined): unknown {
  if (!header) return undefined;
  try {
    return JSON.parse(header);
  } catch {
    try {
      return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  }
}

function bearerEquals(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 本网关安装的稳定设备 ID（部分 OAuth 登录需要，如 ChatGPT 登录）；存 DATA_DIR/gateway/device-id */
function gatewayDeviceId(dataDir: string): string {
  const file = join(dataDir, "gateway", "device-id");
  try {
    const v = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(v)) return v;
  } catch {
    /* 首次生成 */
  }
  const id = randomUUID();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, id, { mode: 0o600 });
  return id;
}

function jsonError(c: HonoContext, status: 400 | 401 | 403 | 404 | 409 | 429 | 500, code: string, error: string) {
  return c.json({ error, code }, status);
}

export async function startGateway(opts: StartGatewayOptions): Promise<GatewayHandle> {
  const mode = opts.mode ?? "real";
  const hub = opts.hubUrl ? new HubClient({ baseUrl: opts.hubUrl, token: opts.tokens.gateway, timeoutMs: 5000 }) : undefined;
  const tokens = new TokenRegistry({
    gatewayToken: opts.tokens.gateway,
    initialDepts: opts.tokens.depts,
    dataDir: opts.dataDir,
    hub,
    refreshMs: opts.tokenRefreshMs,
  });
  tokens.start();
  const catalog: ModelCatalog = createModelCatalog({ configDir: opts.configDir, dataDir: opts.dataDir, models: opts.models, apiKeys: opts.apiKeys });
  for (const e of catalog.loadErrors()) console.error(`[gateway] ${e}`);
  const budget = new BudgetGate({ hub, ...opts.budget });
  const recorder = new GatewayRecorder(opts.dataDir, hub);
  recorder.start();
  const pipeline = new CallPipeline({
    mode,
    catalog,
    budget,
    recorder,
    maxConcurrency: Number(process.env.GATEWAY_MAX_CONCURRENCY) || 6,
    mockEventDelayMs: Number(process.env.MOCK_EVENT_DELAY_MS) || 0,
    ...opts.pipeline,
  });

  const logins = new LoginManager(catalog.models, {
    loginOptions: { getDeviceId: () => gatewayDeviceId(opts.dataDir) },
    onDone: async (provider) => {
      pipeline.resetProvider(provider);
      const p = catalog.models.getProvider(provider);
      if (p?.refreshModels) await catalog.models.refresh({ providers: [provider], allowNetwork: true, force: true });
    },
  });

  const app = new Hono();

  // 请求体上限（上下文很长时也远小于此；防止单请求耗尽内存）
  const maxBody = Number(process.env.GATEWAY_MAX_BODY_BYTES) || 32 * 1024 * 1024;
  app.use("/api/*", bodyLimit({ maxSize: maxBody, onError: (c) => jsonError(c, 413 as 400, "bad_request", `请求体超过 ${maxBody} 字节`) }));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      role: "gateway",
      version: API_VERSION,
      details: {
        mode,
        dept_tokens: tokens.deptCount,
        token_refresh_error: tokens.lastRefreshError,
        hub_reachable: budget.hubReachable,
        ledger_backlog: recorder.ledger.size,
        ledger_error: recorder.ledger.lastError,
        events_backlog: recorder.events.size,
        providers: pipeline.stats(),
        catalog_errors: catalog.loadErrors(),
      },
    }),
  );

  app.get("/api/models", async (c) => {
    if (!tokens.identify(c.req.header("authorization"))) return jsonError(c, 401, "unauthorized", "网关鉴权失败：需要部门或网关 token");
    const list = (await catalog.list()).map((m) => (mode === "mock" ? { ...m, available: true } : m));
    return c.json(list);
  });

  app.post("/api/stream", async (c) => {
    const caller = await tokens.identifyFresh(c.req.header("authorization"));
    if (!caller) return jsonError(c, 401, "unauthorized", "网关鉴权失败：需要部门或网关 token");
    let body: { model?: { provider?: string; id?: string; api?: string }; context?: Context; options?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "bad_request", "请求体不是合法 JSON");
    }
    if (!body?.model?.provider || !body.model.id) return jsonError(c, 400, "bad_request", "model.provider 与 model.id 必填");
    if (!body.context || !Array.isArray(body.context.messages)) return jsonError(c, 400, "bad_request", "context.messages 必须是数组");
    const meta = authorizeMeta(caller, body.options?.metadata ?? parseHeaderMeta(c.req.header("x-court-meta")));
    if (typeof meta === "string") return jsonError(c, caller.kind === "dept" && meta.includes("不属于") ? 403 : 400, "forbidden", meta);

    const abort = new AbortController();
    const reqSignal = c.req.raw.signal;
    reqSignal?.addEventListener("abort", () => abort.abort(), { once: true });
    const encoder = new TextEncoder();
    const input = {
      caller,
      model: { provider: body.model.provider, id: body.model.id, api: body.model.api },
      context: body.context,
      options: pickClientOptions(body.options),
      meta,
      skipBudget: false,
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const emit = (e: ProxyEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
          } catch {
            closed = true;
          }
        };
        pipeline
          .run(input, emit, abort.signal)
          .catch((err) => emit({ type: "error", reason: "error", errorMessage: redact(`网关内部错误：${(err as Error).message}`), usage: zeroUsage() }))
          .finally(() => {
            closed = true;
            try {
              controller.close();
            } catch {
              /* 客户端已断开 */
            }
          });
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  });

  app.post("/api/complete", async (c) => {
    const caller = await tokens.identifyFresh(c.req.header("authorization"));
    if (!caller) return jsonError(c, 401, "unauthorized", "网关鉴权失败：需要部门或网关 token");
    let body: GatewayCompleteReq;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "bad_request", "请求体不是合法 JSON");
    }
    const slash = body?.model_key?.indexOf("/") ?? -1;
    if (slash <= 0) return jsonError(c, 400, "bad_request", "model_key 应为 provider/model_id");
    if (!body.context || !Array.isArray(body.context.messages)) return jsonError(c, 400, "bad_request", "context.messages 必须是数组");
    const meta = authorizeMeta(caller, body.metadata);
    if (typeof meta === "string") return jsonError(c, meta.includes("不属于") ? 403 : 400, "forbidden", meta);
    const abort = new AbortController();
    c.req.raw.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const msg = await pipeline.run(
      {
        caller,
        model: { provider: body.model_key.slice(0, slash), id: body.model_key.slice(slash + 1) },
        context: body.context as unknown as Context,
        options: pickClientOptions(body.options),
        meta,
        skipBudget: caller.kind === "gateway" && !!body.skip_budget,
      },
      () => {},
      abort.signal,
    );
    const res: GatewayCompleteRes = {
      message: {
        role: "assistant",
        content: msg.content.map((b) =>
          b.type === "text"
            ? { type: "text" as const, text: b.text }
            : b.type === "thinking"
              ? { type: "thinking" as const, thinking: b.thinking }
              : { type: "toolCall" as const, id: b.id, name: b.name, arguments: b.arguments as Record<string, unknown> },
        ),
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage,
        usage: msg.usage,
        durationMs: msg.durationMs,
      },
    };
    return c.json(res);
  });

  // ── 管理接口：模型提供商（仅网关 token，即 hub 代皇帝调用；任何响应都不含密钥本体） ──
  const admin = new Hono();
  admin.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => jsonError(c, 413 as 400, "bad_request", "请求体过大") }));
  admin.use("*", async (c, next) => {
    const adminToken = opts.tokens.admin;
    const ok = adminToken
      ? bearerEquals(c.req.header("authorization"), adminToken)
      : tokens.identify(c.req.header("authorization"))?.kind === "gateway";
    if (!ok) return jsonError(c, 403, "forbidden", "管理接口仅限 hub（管理 token）");
    await next();
  });
  admin.onError((err, c) => {
    if (err instanceof CatalogError || err instanceof LoginError) return jsonError(c, err.status, err.status === 404 ? "not_found" : "bad_request", err.message);
    return jsonError(c, 500, "internal", redact(`网关内部错误：${err.message}`));
  });
  const readBody = async <T>(c: HonoContext): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new CatalogError(400, "请求体不是合法 JSON");
    }
  };
  const providerOr404 = async (id: string) => {
    const info = await catalog.provider(id);
    if (!info) throw new CatalogError(404, `没有提供商 ${id}`);
    return info;
  };

  admin.get("/providers", async (c) => c.json(await catalog.providers()));
  admin.get("/providers/:id/models", async (c) => {
    const list = catalog.providerModels(c.req.param("id"));
    if (!list) throw new CatalogError(404, `没有提供商 ${c.req.param("id")}`);
    return c.json(list);
  });
  admin.post("/providers", async (c) => {
    const info = await catalog.saveCustom(await readBody<CustomProviderSpec>(c));
    pipeline.resetProvider(info.id);
    return c.json(info);
  });
  admin.delete("/providers/:id", async (c) => {
    await catalog.deleteCustom(c.req.param("id"));
    pipeline.resetProvider(c.req.param("id"));
    return c.json({ ok: true as const });
  });
  admin.delete("/providers/:id/credential", async (c) => {
    const id = c.req.param("id");
    await catalog.logout(id);
    pipeline.resetProvider(id);
    return c.json(await providerOr404(id));
  });
  admin.post("/providers/:id/login", async (c) => {
    const body = await readBody<{ type?: ProviderAuthType }>(c);
    const type: ProviderAuthType = body?.type === "oauth" ? "oauth" : "api_key";
    // 旧式 custom 的密钥只认 models.yaml 的 key_env（每次请求显式传入），存进凭据库也不会生效
    if (c.req.param("id") === CUSTOM_PROVIDER) throw new CatalogError(400, "models.yaml 的 custom 模型请用 key_env 环境变量配置密钥");
    return c.json(logins.start(c.req.param("id"), type));
  });
  admin.get("/logins/:sid", (c) => c.json(logins.get(c.req.param("sid"))));
  admin.post("/logins/:sid/answer", async (c) => {
    const body = await readBody<{ seq?: number; value?: string }>(c);
    return c.json(logins.answer(c.req.param("sid"), Number(body?.seq), String(body?.value ?? "")));
  });
  admin.delete("/logins/:sid", (c) => c.json(logins.cancel(c.req.param("sid"))));
  admin.get("/providers/:id/check", async (c) => {
    const provider = c.req.param("id");
    const modelId = (c.req.query("model_id") ?? "").trim();
    if (!catalog.models.getProvider(provider)) return c.json({ ok: false, reason: `网关没有提供商 ${provider}（请先在设置中添加）` } satisfies ModelCheckRes);
    const m = modelId ? catalog.resolve(provider, modelId) : undefined;
    if (!m) return c.json({ ok: false, reason: `提供商 ${provider} 的目录中没有 ${modelId || "（空）"}，且不允许目录外模型` } satisfies ModelCheckRes);
    const auth = await catalog.authFor(m);
    const listed = catalog.isListed(provider, modelId);
    const info = catalog.providerModels(provider)?.find((x) => x.id === modelId);
    return c.json({
      ok: true,
      listed,
      configured: mode === "mock" || auth.ok,
      model: info ?? { id: m.id, name: m.name, api: m.api, context_window: m.contextWindow, max_tokens: m.maxTokens, reasoning: !!m.reasoning, input: [...m.input], cost: { ...m.cost } },
      ...(auth.ok || mode === "mock" ? {} : { reason: `提供商 ${provider} 尚未配置凭据` }),
    } satisfies ModelCheckRes);
  });
  admin.post("/providers/:id/test", async (c) => {
    const provider = c.req.param("id");
    const body = await readBody<{ model_id?: string }>(c).catch(() => ({}) as { model_id?: string });
    const info = await providerOr404(provider);
    const modelId = (body?.model_id ?? "").trim() || catalog.providerModels(provider)?.[0]?.id;
    if (!modelId) throw new CatalogError(400, `${info.name} 没有目录模型，请指定 model_id`);
    const started = Date.now();
    const msg = await pipeline.run(
      {
        caller: { kind: "gateway" },
        model: { provider, id: modelId },
        context: { messages: [{ role: "user", content: "连通测试：请只回复一个字「可」。", timestamp: started }] } as Context,
        options: pickClientOptions({ maxTokens: 1024 }),
        meta: { post_id: "system.settings", dept: "system", purpose: "other", trace_id: `provider-test:${provider}` },
        skipBudget: true,
      },
      () => {},
      AbortSignal.timeout(120_000),
    );
    const ok = msg.stopReason !== "error" && msg.stopReason !== "aborted";
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    const res: ProviderTestRes = { ok, model: `${provider}/${modelId}`, latency_ms: Date.now() - started };
    if (ok) res.text = (text || "（模型未输出正文，仅有思考或工具调用）").slice(0, 200);
    else res.error = redact(msg.errorMessage ?? "未知错误").slice(0, 600);
    return c.json(res);
  });
  app.route("/admin", admin);

  app.notFound((c) => jsonError(c, 404, "not_found", `网关没有接口 ${c.req.method} ${c.req.path}`));
  app.onError((err, c) => jsonError(c, 500, "internal", redact(`网关内部错误：${err.message}`)));

  const server = serve({ fetch: app.fetch, port: opts.port ?? GATEWAY_PORT, hostname: opts.hostname ?? "0.0.0.0" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    pipeline,
    catalog,
    logins,
    recorder,
    tokens,
    close: async () => {
      tokens.stop();
      logins.closeAll();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closed;
      await recorder.stop();
    },
  };
}
