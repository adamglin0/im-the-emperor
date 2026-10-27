// /api/stream 与真实 streamProxy 客户端的往返（mock 模式），以及鉴权、预算、记账。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Agent, streamProxy, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { GatewayClient, type GatewayMeta, type PendingItem } from "@court/shared";
import { startGateway, type GatewayHandle } from "../src/server.ts";
import { startFakeHub, waitFor, type FakeHub } from "./fake-hub.ts";

const GATEWAY_TOKEN = "gw_test_token_0123456789";
const DEPT_TOKENS = { menxia: "tok_menxia_abcdef", zhongshu: "tok_zhongshu_abcdef" };
const CONFIG_DIR = join(import.meta.dirname, "../../../config");

const model = {
  id: "deepseek-v4.1-flash",
  name: "client-side copy (untrusted)",
  api: "openai-completions",
  provider: "opencode-go",
  baseUrl: "https://evil.example.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<"openai-completions">;

const meta = (over: Partial<GatewayMeta> = {}): GatewayMeta => ({
  post_id: "menxia.jishizhong_a",
  official_id: "of_1",
  trace_id: "tr_1",
  turn_id: "turn_1",
  call_idx: 0,
  purpose: "turn",
  ...over,
});

function briefing(items: PendingItem[]): string {
  return `<职事清单 json>\n${JSON.stringify(items)}\n</职事清单>`;
}

let hub: FakeHub;
let gw: GatewayHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "gw-test-"));
  hub = await startFakeHub({ gatewayToken: GATEWAY_TOKEN, deptTokens: DEPT_TOKENS });
  gw = await startGateway({ port: 0, hostname: "127.0.0.1", hubUrl: hub.url, dataDir, configDir: CONFIG_DIR, mode: "mock", tokens: { gateway: GATEWAY_TOKEN, depts: DEPT_TOKENS } });
});

afterAll(async () => {
  await gw?.close();
  await hub?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  hub.setBudget(() => ({ allowed: true }));
});

async function collect(s: ReturnType<typeof streamProxy>) {
  const types: string[] = [];
  for await (const ev of s) types.push(ev.type);
  return { types, result: (await s.result()) as AssistantMessage };
}

describe("/api/stream 与 streamProxy 往返（mock）", () => {
  it("工具调用逐事件重建，参数完整，usage 正确", async () => {
    const item: PendingItem = { type: "edict_review", edict_id: "ed_1", title: "测封驳之诏", draft_no: 1, prior_issue_ids: [] };
    const s = streamProxy(
      model,
      { systemPrompt: "你是给事中", messages: [{ role: "user", content: briefing([item]), timestamp: Date.now() }], tools: [{ name: "edict_review", description: "审核", parameters: Type.Object({}) }] },
      { proxyUrl: gw.url, authToken: DEPT_TOKENS.menxia, sessionId: "ses_x", metadata: meta() as never },
    );
    const { types, result } = await collect(s);
    expect(types[0]).toBe("start");
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_delta");
    expect(types.at(-1)).toBe("done");
    expect(result.stopReason).toBe("toolUse");
    const call = result.content.find((b) => b.type === "toolCall");
    expect(call).toMatchObject({ name: "edict_review", arguments: { edict_id: "ed_1", decision: "reject" } });
    expect(result.usage.output).toBe(50);
    expect(result.usage.input).toBeGreaterThan(0);
  });

  it("文本回复（无工具）以 text_* 事件流式到达", async () => {
    const s = streamProxy(model, { messages: [{ role: "user", content: "无事", timestamp: 1 }] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.menxia, metadata: meta() as never });
    const { types, result } = await collect(s);
    expect(types).toEqual(expect.arrayContaining(["start", "text_start", "text_delta", "text_end", "done"]));
    expect(result.content[0]).toMatchObject({ type: "text", text: "无职事清单，本轮无事" });
  });

  it("记账：每次调用一条 LedgerEntry 送达 hub（idem_key = turn:call_idx:purpose）", async () => {
    const before = hub.ledger.length;
    const s = streamProxy(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, {
      proxyUrl: gw.url,
      authToken: DEPT_TOKENS.menxia,
      metadata: meta({ turn_id: "turn_ledger", call_idx: 3 }) as never,
    });
    await collect(s);
    const entry = await waitFor(() => hub.ledger.slice(before).find((e) => e.turn_id === "turn_ledger"));
    expect(entry).toMatchObject({
      idem_key: "turn_ledger:3:turn",
      post_id: "menxia.jishizhong_a",
      official_id: "of_1",
      dept: "menxia",
      trace_id: "tr_1",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      ok: true,
      output: 50,
      cost: 0,
    });
  });

  it("元数据也可经 x-court-meta 头传入", async () => {
    const res = await fetch(`${gw.url}/api/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${DEPT_TOKENS.menxia}`, "content-type": "application/json", "x-court-meta": JSON.stringify(meta({ turn_id: "turn_hdr" })) },
      body: JSON.stringify({ model, context: { messages: [{ role: "user", content: "x", timestamp: 1 }] }, options: {} }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(JSON.parse(lines.at(-1)!.slice(6))).toMatchObject({ type: "done" });
    await waitFor(() => hub.ledger.find((e) => e.turn_id === "turn_hdr"));
  });

  it("pi Agent 经 streamProxy 走完整轮：按清单调工具直到 end_turn", async () => {
    const executed: string[] = [];
    const mkTool = (name: string, terminate = false): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (_id, params) => {
        executed.push(`${name}:${JSON.stringify(params)}`);
        return { content: [{ type: "text", text: "ok" }], details: {}, terminate };
      },
    });
    const items: PendingItem[] = [
      { type: "message", message_id: "m1", from: "emperor", kind: "chat", subject: "修渠", requires_reply: true, trace_id: "t" },
      { type: "edict_countersign", edict_id: "ed_9", title: "t", draft_no: 1 },
    ];
    const agent = new Agent({
      initialState: { systemPrompt: "你是中书侍郎", model, thinkingLevel: "off", tools: [mkTool("reply_message"), mkTool("edict_countersign"), mkTool("end_turn", true)] },
      streamFn: (m, ctx, o) =>
        streamProxy(m, ctx, { ...o, proxyUrl: gw.url, authToken: DEPT_TOKENS.zhongshu, metadata: meta({ post_id: "zhongshu.shilang", turn_id: "turn_agent" }) as never }),
      sessionId: "ses_agent",
    });
    await agent.prompt(briefing(items));
    expect(executed.map((e) => e.split(":")[0])).toEqual(["reply_message", "edict_countersign", "end_turn"]);
    expect(executed[0]).toContain("臣谨奏");
    // 每次 LLM 调用一条账（3 次）
    await waitFor(() => hub.ledger.filter((e) => e.turn_id === "turn_agent").length === 3);
  });
});

describe("鉴权与元数据校验", () => {
  it("无/错 token → 401；streamProxy 得到 error 事件", async () => {
    const s = streamProxy(model, { messages: [] }, { proxyUrl: gw.url, authToken: "wrong", metadata: meta() as never });
    const { result } = await collect(s);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("鉴权失败");
  });

  it("post_id 不属于本部门 → 403", async () => {
    const s = streamProxy(model, { messages: [] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.menxia, metadata: meta({ post_id: "zhongshu.shilang" }) as never });
    const { result } = await collect(s);
    expect(result.errorMessage).toContain("不属于部门 menxia");
  });

  it("缺少 metadata → 400", async () => {
    const s = streamProxy(model, { messages: [] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.menxia });
    const { result } = await collect(s);
    expect(result.errorMessage).toContain("metadata");
  });

  it("网关 token 可用 system.* 职位", async () => {
    const client = new GatewayClient({ baseUrl: gw.url, token: GATEWAY_TOKEN });
    const res = await client.complete({ model_key: "opencode-go/deepseek-v4.1-flash", context: { messages: [{ role: "user", content: "请阅卷", timestamp: 1 }] }, metadata: { post_id: "system.kaochang", purpose: "grading" }, skip_budget: true });
    expect(res.message.stopReason).toBe("stop");
    expect(res.message.content[0]).toMatchObject({ type: "text", text: `{"score": 75, "comment": "mock"}` });
  });

  it("未知模型 → MODEL_NOT_FOUND（mock 模式也接受目录外模型，故改用 /api/models 校验列表）", async () => {
    const client = new GatewayClient({ baseUrl: gw.url, token: DEPT_TOKENS.menxia });
    const list = await client.models();
    expect(list.find((m) => m.key === "opencode-go/deepseek-v4.1-flash")).toMatchObject({ provider: "opencode-go", available: true, api: "openai-completions" });
  });
});

describe("预算", () => {
  it("hub 拒绝 → error 事件以 BUDGET_EXCEEDED: 开头；不记账", async () => {
    hub.setBudget((r) => (r.post_id === "menxia.jishizhong_b" ? { allowed: false, reason: "门下省今日 token 已用尽", scope: "dept:menxia" } : { allowed: true }));
    const before = hub.ledger.length;
    const s = streamProxy(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.menxia, metadata: meta({ post_id: "menxia.jishizhong_b" }) as never });
    const { types, result } = await collect(s);
    expect(types).toEqual(["error"]);
    expect(result.errorMessage?.startsWith("BUDGET_EXCEEDED: ")).toBe(true);
    expect(result.errorMessage).toContain("门下省今日");
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.ledger.length).toBe(before);
    expect(hub.budgetCalls.at(-1)).toMatchObject({ post_id: "menxia.jishizhong_b", trace_id: "tr_1" });
  });

  it("罢朝 → HALTED: 前缀", async () => {
    hub.setBudget(() => ({ status: 403, code: "halted", error: "罢朝中，暂停一切 LLM 调用" }));
    const s = streamProxy(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.menxia, metadata: meta({ post_id: "menxia.zuo_sanqi" }) as never });
    const { result } = await collect(s);
    expect(result.errorMessage?.startsWith("HALTED: ")).toBe(true);
  });

  it("决策按职位缓存（10s 内不再问 hub）", async () => {
    const post = "menxia.shilang";
    const count = () => hub.budgetCalls.filter((c) => c.post_id === post).length;
    for (let i = 0; i < 3; i++) {
      await collect(streamProxy(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { proxyUrl: gw.url, authToken: DEPT_TOKENS.menxia, metadata: meta({ post_id: post }) as never }));
    }
    expect(count()).toBe(1);
  });

  it("skip_budget 仅对网关 token 生效", async () => {
    hub.setBudget(() => ({ allowed: false, reason: "无余额" }));
    const deptClient = new GatewayClient({ baseUrl: gw.url, token: DEPT_TOKENS.menxia });
    const r1 = await deptClient.complete({ model_key: "opencode-go/deepseek-v4.1-flash", context: { messages: [] }, metadata: { post_id: "menxia.x_skip", purpose: "turn" }, skip_budget: true });
    expect(r1.message.errorMessage?.startsWith("BUDGET_EXCEEDED")).toBe(true);
    const gwClient = new GatewayClient({ baseUrl: gw.url, token: GATEWAY_TOKEN });
    const r2 = await gwClient.complete({ model_key: "opencode-go/deepseek-v4.1-flash", context: { messages: [] }, metadata: { post_id: "system.kaochang_skip", purpose: "exam" }, skip_budget: true });
    expect(r2.message.stopReason).toBe("stop");
  });
});

describe("客户端断开", () => {
  it("中止 streamProxy → 网关停止上游并记账 aborted", async () => {
    const slow = await startGateway({
      port: 0,
      hostname: "127.0.0.1",
      hubUrl: hub.url,
      dataDir,
      mode: "mock",
      tokens: { gateway: GATEWAY_TOKEN, depts: DEPT_TOKENS },
      pipeline: { mockEventDelayMs: 150 },
    });
    try {
      const ac = new AbortController();
      const s = streamProxy(model, { messages: [{ role: "user", content: "无事", timestamp: 1 }] }, {
        proxyUrl: slow.url,
        authToken: DEPT_TOKENS.menxia,
        metadata: meta({ turn_id: "turn_abort" }) as never,
        signal: ac.signal,
      });
      for await (const ev of s) if (ev.type === "start") ac.abort();
      expect((await s.result()).stopReason).toBe("aborted");
      const entry = await waitFor(() => hub.ledger.find((e) => e.turn_id === "turn_abort"));
      expect(entry).toMatchObject({ ok: false, error: "aborted" });
    } finally {
      await slow.close();
    }
  });
});
