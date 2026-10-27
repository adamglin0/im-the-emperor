// 重试、熔断、鉴权错误、上下文过长（real 模式 + faux 提供商，不调用真实 LLM）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { streamProxy } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage, type FauxProviderHandle } from "@earendil-works/pi-ai";
import type { GatewayMeta } from "@court/shared";
import { pickClientOptions } from "../src/pipeline.ts";
import { CircuitBreaker, classifyError, parseRetryAfterMs, Semaphore } from "../src/resilience.ts";
import { startGateway, type GatewayHandle } from "../src/server.ts";
import { startFakeHub, waitFor, type FakeHub } from "./fake-hub.ts";

const GATEWAY_TOKEN = "gw_test_token_resilience";
const DEPT_TOKENS = { bingbu: "tok_bingbu_abcdef" };

describe("CircuitBreaker", () => {
  it("连续 5 次失败打开，60s 后半开只放一个探测，成功则关闭", () => {
    let now = 0;
    const b = new CircuitBreaker(5, 60_000, () => now);
    for (let i = 0; i < 4; i++) b.onFailure();
    expect(b.state).toBe("closed");
    b.onFailure();
    expect(b.state).toBe("open");
    expect(b.tryPass()).toBe(false);
    now += 60_000;
    expect(b.state).toBe("half_open");
    expect(b.tryPass()).toBe("probe");
    expect(b.tryPass()).toBe(false); // 只放一个探测
    b.onSuccess();
    expect(b.state).toBe("closed");
  });

  it("半开探测失败立即重新打开", () => {
    let now = 0;
    const b = new CircuitBreaker(2, 1000, () => now);
    b.onFailure();
    b.onFailure();
    now += 1000;
    expect(b.tryPass()).toBe("probe");
    b.onFailure();
    expect(b.state).toBe("open");
    expect(b.retryInMs()).toBe(1000);
  });
});

describe("Semaphore", () => {
  it("超过上限排队，先进先出，可取消", async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    const order: number[] = [];
    const p3 = s.acquire().then((r) => (order.push(3), r));
    const ac = new AbortController();
    const p4 = s.acquire(ac.signal);
    const p5 = s.acquire().then((r) => (order.push(5), r));
    expect(s.queued).toBe(3);
    ac.abort();
    await expect(p4).rejects.toThrow();
    r1();
    const r3 = await p3;
    r2();
    await p5;
    expect(order).toEqual([3, 5]);
    expect(s.inFlight).toBe(2);
    r3();
  });
});

describe("错误分类", () => {
  const err = (errorMessage: string) => ({ stopReason: "error", errorMessage, content: [], usage: { input: 0 } }) as unknown as AssistantMessage;
  it("区分限流、临时、鉴权、上下文过长", () => {
    expect(classifyError(err("429 Too Many Requests"))).toBe("rate_limit");
    expect(classifyError(err("503 Service Unavailable"))).toBe("transient");
    expect(classifyError(err("fetch failed"))).toBe("transient");
    expect(classifyError(err("401 Unauthorized: invalid api key"))).toBe("auth");
    expect(classifyError(err("This model's maximum context length is 1000 tokens"))).toBe("context");
    expect(classifyError(err("400 bad request: invalid tool schema"))).toBe("fatal");
    expect(classifyError(err("429 GoUsageLimitError: Monthly usage limit reached"))).toBe("fatal");
  });
  it("解析 retry-after", () => {
    expect(parseRetryAfterMs("rate limited, retry-after: 3")).toBe(3000);
    expect(parseRetryAfterMs("Please try again in 250ms")).toBe(250);
    expect(parseRetryAfterMs("nothing")).toBeUndefined();
  });
});

describe("网关管线（faux 提供商）", () => {
  let hub: FakeHub;
  let gw: GatewayHandle;
  let faux: FauxProviderHandle;
  let dataDir: string;
  const sleeps: number[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "gw-res-"));
    hub = await startFakeHub({ gatewayToken: GATEWAY_TOKEN, deptTokens: DEPT_TOKENS });
    faux = fauxProvider({ provider: "faux", models: [{ id: "m1", contextWindow: 1000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    gw = await startGateway({
      port: 0,
      hostname: "127.0.0.1",
      hubUrl: hub.url,
      dataDir,
      mode: "real",
      tokens: { gateway: GATEWAY_TOKEN, depts: DEPT_TOKENS },
      models,
      apiKeys: { faux: "fake-key" },
      pipeline: {
        upstreamIdleMs: 300,
        breakerThreshold: 5,
        breakerOpenMs: 60_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
  });

  afterAll(async () => {
    await gw?.close();
    await hub?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    sleeps.length = 0;
    gw.pipeline.breaker("faux").onSuccess();
  });

  const model = faux_model();
  function faux_model() {
    return { id: "m1", name: "m1", api: "faux", provider: "faux", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as never;
  }
  const meta = (turn: string): GatewayMeta => ({ post_id: "bingbu.shangshu", turn_id: turn, call_idx: 0, purpose: "turn" });
  async function call(turn: string): Promise<{ types: string[]; result: AssistantMessage }> {
    const s = streamProxy(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.bingbu, metadata: meta(turn) as never });
    const types: string[] = [];
    for await (const ev of s) types.push(ev.type);
    return { types, result: await s.result() };
  }
  const fail = (msg: string) => fauxAssistantMessage([], { stopReason: "error", errorMessage: msg });

  it("429 在未写出任何字节前重试，随后成功；客户端只看到一次干净的流", async () => {
    faux.setResponses([fail("429 Too Many Requests, retry-after: 2"), fail("503 Service Unavailable"), fauxAssistantMessage("pong")]);
    const { types, result } = await call("turn_retry");
    expect(result.stopReason).toBe("stop");
    expect(result.content[0]).toMatchObject({ type: "text", text: "pong" });
    expect(types.filter((t) => t === "start")).toHaveLength(1);
    expect(types).not.toContain("error");
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000); // 遵循 retry-after
    const entry = await waitFor(() => hub.ledger.find((e) => e.turn_id === "turn_retry"));
    expect(entry.ok).toBe(true);
  });

  it("重试 4 次仍失败 → 返回错误并记账 ok=false", async () => {
    faux.setResponses(Array.from({ length: 5 }, () => fail("502 Bad Gateway")));
    const { result } = await call("turn_exhaust");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/^UPSTREAM_ERROR: /);
    expect(sleeps.length).toBe(4);
    const entry = await waitFor(() => hub.ledger.find((e) => e.turn_id === "turn_exhaust"));
    expect(entry).toMatchObject({ ok: false, provider: "faux", model: "m1" });
  });

  it("连续 5 个请求失败（按请求计，重试不重复计数）触发熔断 → CIRCUIT_OPEN，且不再调用提供商", async () => {
    faux.setResponses(Array.from({ length: 30 }, () => fail("503 Service Unavailable")));
    for (let i = 0; i < 4; i++) {
      const r = await call(`turn_cb_pre${i}`); // 每个请求 1 次 + 4 次重试
      expect(r.result.errorMessage).toMatch(/^UPSTREAM_ERROR: /);
      expect(gw.pipeline.breaker("faux").state).toBe("closed");
    }
    const r1 = await call("turn_cb1");
    expect(r1.result.errorMessage).toMatch(/^UPSTREAM_ERROR: /);
    expect(gw.pipeline.breaker("faux").state).toBe("open");
    const pendingBefore = faux.getPendingResponseCount();
    const r2 = await call("turn_cb2");
    expect(r2.result.errorMessage).toMatch(/^CIRCUIT_OPEN: /);
    expect(faux.getPendingResponseCount()).toBe(pendingBefore);
    faux.setResponses([]);
  });

  it("鉴权错误不重试 → AUTH_ERROR，并向 hub 报一次 gateway.auth_error", async () => {
    faux.setResponses([fail("401 Unauthorized: invalid api key"), fail("401 Unauthorized: invalid api key")]);
    const r = await call("turn_auth");
    expect(r.result.errorMessage).toMatch(/^AUTH_ERROR: /);
    expect(sleeps.length).toBe(0);
    await call("turn_auth2");
    await waitFor(() => hub.events.find((e) => e.type === "gateway.auth_error"));
    await new Promise((res) => setTimeout(res, 1200));
    expect(hub.events.filter((e) => e.type === "gateway.auth_error")).toHaveLength(1);
  });

  it("上下文过长 → CONTEXT_TOO_LONG，不重试、不计入熔断", async () => {
    faux.setResponses([fail("This model's maximum context length is 1000 tokens, however you requested 5000")]);
    const r = await call("turn_ctx");
    expect(r.result.errorMessage).toMatch(/^CONTEXT_TOO_LONG: /);
    expect(sleeps.length).toBe(0);
    expect(gw.pipeline.breaker("faux").snapshot().failures).toBe(0);
  });

  it("目录外模型 → MODEL_NOT_FOUND", async () => {
    const s = streamProxy({ ...(model as object), id: "nope" } as never, { messages: [] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.bingbu, metadata: meta("t") as never });
    for await (const _ of s) void _;
    expect((await s.result()).errorMessage).toMatch(/^MODEL_NOT_FOUND: /);
  });

  it("上游空闲超时 → 中止该次尝试并按临时错误重试", async () => {
    faux.setResponses([() => new Promise((r) => setTimeout(() => r(fauxAssistantMessage("late")), 1500)), fauxAssistantMessage("pong")]);
    const { result } = await call("turn_idle");
    expect(result.content[0]).toMatchObject({ type: "text", text: "pong" });
    expect(sleeps.length).toBe(1);
  });
});

describe("调用方选项白名单", () => {
  it("samplingParams 只放行数值采样参数，丢弃 model/stream 等覆盖字段与 headers/metadata", () => {
    const o = pickClientOptions({
      temperature: 0.3,
      maxTokens: 512.7,
      reasoning: "low",
      samplingParams: { model: "expensive", stream: false, n: 50, top_p: 0.9, seed: 7 },
      headers: { authorization: "x" },
      metadata: { post_id: "x" },
      apiKey: "steal",
      sessionId: "ses_1",
    });
    expect(o).toEqual({ temperature: 0.3, maxTokens: 512, reasoning: "low", samplingParams: { top_p: 0.9, seed: 7 }, sessionId: "ses_1" });
    expect(pickClientOptions({ reasoning: "ultra", temperature: 9 })).toEqual({});
  });
});
