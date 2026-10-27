import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Briefing, InboxItem } from "@court/shared";
import { renderBriefing, renderMachineBlock } from "../src/briefing-render.ts";
import { buildCompactedMessages, splitForCompaction } from "../src/compaction.ts";
import { classifyAssistantError, classifyLlmError, turnOrigin } from "../src/official.ts";
import { Semaphore } from "../src/semaphore.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT, SessionStore, repairTranscript } from "../src/session.ts";
import { defaultWaitState, isInterrupt, matchesWaitFilter, shouldWakeFor } from "../src/wake.ts";
import { resolveModel } from "../src/model.ts";
import { FakeHub, POST, errorMsg, makePost, tmpDataDir, toolCallMsg } from "./helpers.ts";

const user = (t: string): AgentMessage => ({ role: "user", content: t, timestamp: 0 });
const result = (id: string): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 });

describe("会话恢复", () => {
  it("补写缺失的工具结果、丢弃孤立结果、按调用顺序归位", () => {
    const msgs: AgentMessage[] = [user("a"), toolCallMsg("x", {}, "c1"), user("b"), result("c1"), result("zz"), toolCallMsg("x", {}, "c2")];
    const { messages, synthesized } = repairTranscript(msgs);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant", "toolResult"]);
    expect((messages[2] as any).toolCallId).toBe("c1");
    expect(synthesized.length).toBe(1);
    expect((synthesized[0] as any).toolCallId).toBe("c2");
    expect(JSON.stringify(synthesized[0])).toContain(INTERRUPTED_TOOL_RESULT_TEXT);
  });

  it("加载 = 最后一次压缩摘要 + 其后消息；running 轮标记 aborted 且补写落盘", () => {
    const dir = tmpDataDir();
    const s = new SessionStore(join(dir, "s.jsonl"));
    s.appendMessage(user("很早的事"));
    s.appendKeptAfterCompaction("摘要一", [user("保留")]);
    s.appendTurn("tn_1", "running");
    s.appendMessage(toolCallMsg("ws_run", { command: "ls" }, "c9"));
    const loaded = s.load();
    expect(loaded.abortedTurnId).toBe("tn_1");
    expect(loaded.synthesizedResults).toBe(1);
    expect(String((loaded.messages[0] as any).content)).toContain("摘要一");
    expect(loaded.messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "toolResult"]);
    // 再次加载：不重复补写，也不再标 aborted
    const again = s.load();
    expect(again.synthesizedResults).toBe(0);
    expect(again.abortedTurnId).toBeUndefined();
    expect(again.messages.length).toBe(4);
  });
});

describe("压缩切分", () => {
  it("只在 user 边界切，保留段 ≤ 上限，调用/结果成对；系统消息在最前", () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) msgs.push(user("简报".repeat(50) + i), toolCallMsg("t", { i }, `c${i}`), result(`c${i}`));
    const { older, kept } = splitForCompaction(msgs, 260);
    expect(kept[0].role).toBe("user");
    expect(older.length + kept.length).toBe(msgs.length);
    expect(kept.length % 3).toBe(0);
    const sys = { role: "system" as const, content: "系统", timestamp: 0 };
    const out = buildCompactedMessages(sys, "摘要", kept);
    expect(out[0]).toBe(sys);
    expect(out[1].role).toBe("user");
  });

  it("mustKeepLastUser：即便超限也保留当轮简报", () => {
    const msgs: AgentMessage[] = [user("a".repeat(4000)), user("b".repeat(4000))];
    expect(splitForCompaction(msgs, 10).kept.length).toBe(0);
    expect(splitForCompaction(msgs, 10, true).kept.length).toBe(1);
  });
});

describe("等待过滤与打断", () => {
  const post = makePost();
  const hub = new FakeHub(tmpDataDir());
  const item = (from: string, extra: Record<string, unknown> = {}, wakes = true): InboxItem => hub.addMessage(POST, { from, ...extra }, wakes);

  it("wait_for 条件全部满足才命中", () => {
    const m = item("post:a.b", { kind: "chat", reply_to: "msg_1" }).message;
    expect(matchesWaitFilter({ from: ["post:a.b"] }, m)).toBe(true);
    expect(matchesWaitFilter({ from: ["post:a.b"], kinds: ["task_notice"] }, m)).toBe(false);
    expect(matchesWaitFilter({ reply_to: "msg_1" }, m)).toBe(true);
    expect(matchesWaitFilter({ reply_to: "msg_2" }, m)).toBe(false);
  });

  it("睡眠只被打断唤醒；默认等待按 wakes；皇帝/诏令/urgent 为打断", () => {
    const sleep = { ...defaultWaitState(post), mode: "sleep" as const, agent_set: true };
    expect(shouldWakeFor(sleep, post, item("post:a.b"))).toBe(false);
    expect(shouldWakeFor(sleep, post, item("emperor"))).toBe(true);
    expect(shouldWakeFor(sleep, post, item("system:watchdog", { priority: "urgent" }))).toBe(true);
    expect(isInterrupt(post, item("system:workflow", { kind: "edict_notice" }).message)).toBe(true);
    const dflt = defaultWaitState(post);
    expect(shouldWakeFor(dflt, post, item("post:a.b", {}, false))).toBe(false);
    expect(shouldWakeFor(dflt, post, item("post:a.b", {}, true))).toBe(true);
  });
});

describe("简报渲染", () => {
  it("包含机器可读块、新来信、备忘与名下事务", () => {
    const hub = new FakeHub(tmpDataDir());
    const it1 = hub.addMessage(POST, { from: "emperor", subject: "口谕", body: "x".repeat(2000) });
    const b: Briefing = {
      post_id: POST,
      generated_at: 0,
      wake_reason: "doorbell",
      latest_seq: 1,
      more: 2,
      items: [{ type: "edict_review", edict_id: "ed_1", title: "修渠", draft_no: 1, prior_issue_ids: [] }],
    };
    const text = renderBriefing({ wakeReason: "doorbell", now: Date.now(), briefing: b, newMessages: [it1.message], memory: "记住：魏公严谨" });
    expect(text).toContain(renderMachineBlock(b.items));
    expect(text).toMatch(/<职事清单 json>\n\[\n\{"type":"edict_review".*\}\n\]\n<\/职事清单>/);
    expect(text).toContain("more: 2");
    expect(text).toContain("记住：魏公严谨");
    expect(text).toContain("诏令 ed_1「修渠」第 1 稿待你审核");
    expect(text).toContain("已截断");
    expect(text).toContain(`message_id=${it1.message.id}`);
    const block = text.slice(text.indexOf("<职事清单 json>") + "<职事清单 json>".length, text.indexOf("</职事清单>"));
    expect(JSON.parse(block)).toEqual(b.items);
  });
});

describe("杂项", () => {
  it("LLM 错误分类", () => {
    expect(classifyLlmError("Proxy error: BUDGET_EXCEEDED: 超额")).toBe("budget");
    expect(classifyLlmError("BUDGET_EXCEEDED")).toBe("budget");
    expect(classifyLlmError("HALTED: 罢朝")).toBe("halted");
    expect(classifyLlmError("CIRCUIT_OPEN")).toBe("sick");
    expect(classifyLlmError("Proxy error: 503 Service Unavailable")).toBe("sick");
    expect(classifyLlmError("fetch failed")).toBe("sick");
    expect(classifyLlmError("CONTEXT_TOO_LONG")).toBe("overflow");
    expect(classifyLlmError("invalid tool schema")).toBe("other");
    expect(classifyLlmError("Proxy error: UPSTREAM_ERROR: Connection error.")).toBe("sick");
    expect(classifyLlmError("Proxy error: RATE_LIMITED: Too many tokens, please wait")).toBe("sick");
  });

  it("网关错误码优先于 pi-ai 的溢出启发式", () => {
    expect(classifyAssistantError(errorMsg("Proxy error: RATE_LIMITED: ThrottlingException: Too many tokens, please wait"), 128_000)).toBe("sick");
    expect(classifyAssistantError(errorMsg("Proxy error: BUDGET_EXCEEDED: token limit exceeded（dept）"), 128_000)).toBe("budget");
    expect(classifyAssistantError(errorMsg("Proxy error: CONTEXT_TOO_LONG: prompt is too long"), 128_000)).toBe("overflow");
    expect(classifyAssistantError(errorMsg("prompt is too long: 213462 tokens > 200000 maximum"), 128_000)).toBe("overflow");
  });

  it("信号量：释放时名额直接移交排队者，不被新来者插队超额", async () => {
    const s = new Semaphore(1);
    const ra = await s.acquire();
    let gotC = false;
    const pb = s.acquire();
    ra();
    const pc = s.acquire().then((r) => {
      gotC = true;
      return r;
    });
    const rb = await pb;
    await Promise.resolve();
    expect(gotC).toBe(false);
    expect(s.inUse).toBe(1);
    rb();
    const rc = await pc;
    expect(s.inUse).toBe(1);
    rc();
    expect(s.inUse).toBe(0);
  });

  it("模型解析：目录内取目录定义，未知模型合成", () => {
    const m = resolveModel("opencode-go/deepseek-v4.1-flash");
    expect(m.provider).toBe("opencode-go");
    expect(m.id).toBe("deepseek-v4.1-flash");
    const u = resolveModel("custom/my-llm", { key: "custom/my-llm", provider: "custom", model_id: "my-llm", name: "x", context_window: 32000, status: "candidate", added_at: 0 });
    expect(u).toMatchObject({ id: "my-llm", provider: "custom", api: "openai-completions", contextWindow: 32000, maxTokens: 8192 });
  });
});

describe("轮次触发源（turn span 父子关系）", () => {
  const msg = (id: string, trace: string, meta?: Record<string, unknown>) =>
    ({ id, trace_id: trace, span_id: `sp_m_${id}`, from: "emperor", to: "post:x.y", cc: [], kind: "oral_order", subject: "s", body: "b", requires_reply: false, thread_id: id, priority: "normal", hop_count: 0, created_at: 0, meta }) as InboxItem["message"];
  const brief = (items: Briefing["items"]): Briefing => ({ post_id: "x.y", generated_at: 0, wake_reason: "", items, more: 0, latest_seq: 0 });

  it("首个职事为来信：父 = 该消息 span；带 message_ids 与 meta 中的 edict_id", () => {
    const m = msg("m1", "tr_a", { edict_id: "ed_1" });
    const o = turnOrigin([m], brief([{ type: "message", message_id: "m1", from: "emperor", kind: "oral_order", subject: "s", requires_reply: false, trace_id: "tr_a" }]), "tr_a");
    expect(o.parent_span_id).toBe("sp_m_m1");
    expect(o.attrs).toEqual({ message_ids: ["m1"], edict_id: "ed_1" });
  });

  it("首个职事为任务/服务/议事：父 = hub 对象 span；诏令类职事不指向根", () => {
    expect(turnOrigin([], brief([{ type: "task_assigned", task_id: "tk_1", title: "t", state: "assigned", is_head: true }]), "tr").parent_span_id).toBe("sp_tk_1");
    expect(turnOrigin([], brief([{ type: "service_request", request_id: "svc_1", service: "polish", caller: "post:a.b" }]), "tr").parent_span_id).toBe("sp_svc_1");
    expect(turnOrigin([], brief([{ type: "council_turn", deliberation_id: "dl_1", round: 1, topic: "x" }]), "tr").parent_span_id).toBe("sp_dl_1");
    const ed = turnOrigin([], brief([{ type: "edict_review", edict_id: "ed_9", title: "t", draft_no: 1, prior_issue_ids: [] }]), "ed_9");
    expect(ed.parent_span_id).toBeUndefined();
    expect(ed.attrs.edict_id).toBe("ed_9");
    // 诏令职事 + 同 trace 来信：挂到来信
    const m = msg("m2", "ed_9");
    expect(turnOrigin([m], brief([{ type: "edict_review", edict_id: "ed_9", title: "t", draft_no: 1, prior_issue_ids: [] }]), "ed_9").parent_span_id).toBe("sp_m_m2");
  });

  it("他 trace 的来信不作父", () => {
    const o = turnOrigin([msg("m3", "tr_other")], brief([]), "tr_mine");
    expect(o.parent_span_id).toBeUndefined();
  });
});
