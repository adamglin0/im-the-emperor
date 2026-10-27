import { isProductiveTurn } from "../src/official.ts";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { join } from "node:path";
import type { DeptRuntime } from "../src/runtime.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT, SessionStore } from "../src/session.ts";
import {
  FakeHub,
  OFFICIAL_ID,
  abortedMsg,
  POST,
  delay,
  errorMsg,
  lastUserText,
  makeOfficial,
  makePost,
  makeRuntime,
  scriptedModel,
  tmpDataDir,
  toolCallMsg,
  until,
} from "./helpers.ts";

let rt: DeptRuntime | undefined;
afterEach(async () => {
  await rt?.stop(1000);
  rt = undefined;
});

function sessionRecords(dataDir: string): any[] {
  return readFileSync(join(dataDir, "officials", OFFICIAL_ID, "session.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function logRecords(rt: DeptRuntime): any[] {
  return rt.officials.get(POST)!.readLog(undefined, 1000);
}

describe("官员运行时", () => {
  it("默认等待超时且简报为空：不调 LLM，指数退避续睡", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir, makePost({ default_wait_seconds: 0.05 }));
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    const o = rt.officials.get(POST)!;
    await until(() => logRecords(rt!).filter((r) => r.type === "wait" && r.reason === "idle_timeout_no_work").length >= 2);
    expect(model.calls.length).toBe(0);
    expect(o.waitState().idle_backoff).toBeGreaterThanOrEqual(4);
    expect(o.status().state).toBe("idle");
  });

  it("门铃 → 简报 → 一轮 → 结束型工具设定下一次唤醒；cursor 在会话持久化之后才推进", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    const item = hub.addMessage(POST, { from: "emperor", kind: "oral_order", subject: "口谕", body: "速审诏令" });
    model.push(toolCallMsg("send_message", { to: "post:menxia.jishizhong_a", body: "自省" }), toolCallMsg("sleep", { seconds: 600, reason: "歇息" }));
    rt.doorbell([POST]);
    await until(() => hub.acks.length >= 1);
    const o = rt.officials.get(POST)!;
    // 第一轮：两次 LLM 调用（发信 → 睡）
    expect(model.calls.length).toBe(2);
    const text = lastUserText(model.calls[0].ctx);
    expect(text).toContain("<职事清单 json>");
    expect(text).toContain("</职事清单>");
    expect(text).toContain(item.message.id);
    expect(text).toContain("速审诏令");
    // metadata 随调用传给网关
    const meta = model.calls[0].options?.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ post_id: POST, official_id: OFFICIAL_ID, dept: "menxia", purpose: "turn", call_idx: 0, trace_id: item.message.trace_id });
    expect(String(meta.turn_id)).toMatch(/^tn_/);
    expect((model.calls[1].options?.metadata as Record<string, unknown>).call_idx).toBe(1);
    expect(model.calls[0].options?.sessionId).toBe(`ses_${OFFICIAL_ID}`);
    // 系统提示来自 hub 配置
    expect(model.calls[0].ctx.messages[0].role).toBe("system");
    // 睡眠由工具设定
    const w = o.waitState();
    expect(w.mode).toBe("sleep");
    expect(w.agent_set).toBe(true);
    expect(w.next_wake_at).toBeGreaterThan(Date.now() + 590_000);
    // cursor：确认的是该批最新 seq，且确认时会话已写入 done
    expect(hub.acks[0].seq).toBe(item.delivery.seq);
    expect(hub.acks[0].sessionHadDoneTurn).toBe(true);
    expect(w.acked_seq).toBe(item.delivery.seq);
    // 发信带幂等键 post:turn:toolCall
    expect(hub.sent[0].req.idem_key).toMatch(new RegExp(`^${POST}:tn_`));
    expect(hub.sent[0].headers["x-acting-post"]).toBe(POST);
    // 事件：turn.start/turn.end（span）、llm.call、tool.call
    await until(() => hub.events.some((e) => e.type === "turn.end"));
    const types = hub.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["turn.start", "turn.end", "llm.call", "tool.call"]));
    const end = hub.events.find((e) => e.type === "turn.end")!;
    expect(end.span?.kind).toBe("turn");
    expect(end.data?.tool_calls).toBe(2);
    // 轮次 span 挂在触发它的来信 span 下，并带 message_ids
    const start = hub.events.find((e) => e.type === "turn.start")!;
    expect(start.span?.parent_span_id).toBe(item.message.span_id);
    expect(start.span?.attrs?.message_ids).toEqual([item.message.id]);
    // 日志
    const logTypes = logRecords(rt).map((r) => r.type);
    expect(logTypes).toEqual(expect.arrayContaining(["turn_start", "llm_end", "tool_call", "tool_result", "message_out", "turn_end"]));
    // 会话：turn running → done
    const turns = sessionRecords(dir).filter((r) => r.type === "turn");
    expect(turns.map((t) => t.status)).toEqual(["running", "done"]);
  });

  it("wait_for 过滤：不匹配的新信不唤醒（留待下次），皇帝来信打断", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "post:zhongshu.sheren_a", subject: "请审", body: "草稿一" });
    model.push(toolCallMsg("wait_for", { from: ["post:shangshu.zuocheng"], timeout_seconds: 600 }));
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 1);
    expect(model.calls.length).toBe(1);
    expect(rt.officials.get(POST)!.status().state).toBe("waiting");

    const other = hub.addMessage(POST, { from: "post:zhongshu.sheren_a", subject: "再催", body: "催审" });
    rt.doorbell([POST]);
    await delay(150);
    expect(model.calls.length).toBe(1); // 未唤醒

    const emp = hub.addMessage(POST, { from: "emperor", kind: "oral_order", subject: "口谕", body: "即刻回奏" });
    model.push(toolCallMsg("end_turn", { note: "已处理" }));
    rt.doorbell([POST]);
    await until(() => model.calls.length === 2 && hub.acks.length === 2);
    const text = lastUserText(model.calls[1].ctx);
    expect(text).toContain(other.message.id); // 被搁置的信此时一并呈上
    expect(text).toContain(emp.message.id);
    expect(hub.acks[1].seq).toBe(emp.delivery.seq);
  });

  it("预算超额：停俸（suspended），不推进 cursor", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "emperor", kind: "oral_order", body: "审" });
    model.push(errorMsg("Proxy error: BUDGET_EXCEEDED: 今日预算已用尽"));
    rt.doorbell([POST]);
    const o = rt.officials.get(POST)!;
    await until(() => o.status().state === "suspended");
    expect(hub.acks.length).toBe(0);
    expect(o.waitState().acked_seq).toBe(0);
    await until(() => hub.events.some((e) => e.type === "budget_block"));
    expect(model.calls.length).toBe(1);
  });

  it("停俸后增拨：宣召立即复查预算并复职（不等 10 分钟）", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "emperor", kind: "oral_order", body: "审" });
    model.push(errorMsg("Proxy error: BUDGET_EXCEEDED: 今日预算已用尽"));
    rt.doorbell([POST]);
    const o = rt.officials.get(POST)!;
    await until(() => o.status().state === "suspended");
    // 预算未增拨时宣召：复查仍超额，继续停俸
    o.wakeManual("试唤");
    await new Promise((r) => setTimeout(r, 100));
    expect(o.status().state).toBe("suspended");
    expect(model.calls.length).toBe(1);
    // 增拨后宣召：立即复职并重新办理
    hub.budgetAllowed = true;
    model.push(toolCallMsg("end_turn", { note: "已审" }));
    o.wakeManual("增拨后宣召");
    await until(() => model.calls.length === 2 && hub.acks.length === 1);
    expect(o.status().state).not.toBe("suspended");
  });

  it("停俸后预算变更：控制面通知即复查并复职", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "emperor", kind: "oral_order", body: "审" });
    model.push(errorMsg("Proxy error: BUDGET_EXCEEDED: 今日预算已用尽"));
    rt.doorbell([POST]);
    const o = rt.officials.get(POST)!;
    await until(() => o.status().state === "suspended");
    hub.budgetAllowed = true;
    model.push(toolCallMsg("end_turn", { note: "已审" }));
    rt.recheckBudget();
    await until(() => model.calls.length === 2 && hub.acks.length === 1);
    expect(o.status().state).not.toBe("suspended");
  });

  it("模型服务故障：抱恙（sick）退避，不推进 cursor", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "审" });
    model.push(errorMsg("Proxy error: CIRCUIT_OPEN 提供商熔断"));
    rt.doorbell([POST]);
    const o = rt.officials.get(POST)!;
    await until(() => o.status().state === "sick");
    expect(hub.acks.length).toBe(0);
    expect(o.status().next_wake_at).toBeGreaterThan(Date.now() + 30_000);
  });

  it("崩溃恢复：running 轮不重放，补写中断结果；cursor 未推进 → 消息重现", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const item = hub.addMessage(POST, { from: "emperor", body: "旧旨" });
    // 模拟上次进程在工具执行中被杀：会话里有 running 轮与无结果的工具调用，cursor 未推进
    const store = new SessionStore(join(dir, "officials", OFFICIAL_ID, "session.jsonl"));
    store.appendTurn("tn_old", "running");
    store.appendMessage({ role: "user", content: "【醒来简报】旧", timestamp: Date.now() });
    store.appendMessage(toolCallMsg("send_message", { to: "post:zhongshu.sheren_a", body: "x" }, "call_crash"));

    const model = scriptedModel();
    model.push(toolCallMsg("end_turn", { note: "查明后再办" }));
    rt = makeRuntime(hub, model);
    await rt.start();
    await until(() => model.calls.length === 1 && hub.acks.length === 1);
    const ctx = model.calls[0].ctx;
    const idx = ctx.messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === "call_crash");
    expect(idx).toBeGreaterThan(0);
    expect(ctx.messages[idx - 1].role).toBe("assistant");
    expect(JSON.stringify(ctx.messages[idx])).toContain(INTERRUPTED_TOOL_RESULT_TEXT);
    expect(lastUserText(ctx)).toContain(item.message.id); // 旧消息重现
    const turns = sessionRecords(dir).filter((r) => r.type === "turn");
    expect(turns.map((t) => t.status)).toEqual(["running", "aborted", "running", "done"]);
  });

  it("压缩：保留系统消息，摘要在前，保留段从 user 开始且工具调用/结果成对", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model, { limits: { compactKeepRecentTokens: 1000 }, overrides: { zhongshu: "http://127.0.0.1:9" } });
    await rt.start();
    for (let i = 0; i < 4; i++) {
      hub.addMessage(POST, { from: "emperor", body: `第${i}道旨意：` + "长".repeat(300) });
      model.push(toolCallMsg("send_message", { to: "post:zhongshu.sheren_a", body: "回" + i }), toolCallMsg("end_turn", { note: "毕" }));
      rt.doorbell([POST]);
      await until(() => hub.acks.length === i + 1);
    }
    expect(rt.compact(POST)).toBe(true);
    const o = rt.officials.get(POST)!;
    await until(() => logRecords(rt!).some((r) => r.type === "compact"));
    const msgs = o.contextView().messages as any[];
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("给事中");
    expect(msgs[1].role).toBe("user");
    expect(String(msgs[1].content)).toContain("【摘要】");
    expect(msgs.length).toBeGreaterThan(2);
    expect(msgs[2].role).toBe("user");
    // 每个工具调用都紧跟其结果
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== "assistant") continue;
      const calls = msgs[i].content.filter((b: any) => b.type === "toolCall");
      calls.forEach((c: any, k: number) => {
        expect(msgs[i + 1 + k].role).toBe("toolResult");
        expect(msgs[i + 1 + k].toolCallId).toBe(c.id);
      });
    }
    expect(hub.completeCalls.length).toBe(1);
    expect((hub.completeCalls[0] as any).metadata.purpose).toBe("compaction");
    // 会话文件：加载 = 摘要 + 其后消息
    const compRec = sessionRecords(dir).find((r) => r.type === "compaction");
    expect(compRec.tokens_after).toBeLessThan(compRec.tokens_before);
  });

  it("自我整理（compact_memory 摘要由官员自写）在本轮后执行，不调网关", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "整理一下" });
    model.push(toolCallMsg("compact_memory", { summary: "我自己写的摘要" }), toolCallMsg("end_turn", { note: "毕" }));
    rt.doorbell([POST]);
    await until(() => logRecords(rt!).some((r) => r.type === "compact"));
    const msgs = rt.officials.get(POST)!.contextView().messages as any[];
    expect(msgs[0].role).toBe("system");
    expect(String(msgs[1].content)).toContain("我自己写的摘要");
    expect(hub.completeCalls.length).toBe(0);
  });

  it("投递：对方官署不可达时回退直投 hub（同一幂等键）", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model, { overrides: { zhongshu: "http://127.0.0.1:9" } });
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "转告中书" });
    model.push(toolCallMsg("send_message", { to: "post:zhongshu.sheren_a", body: "请改稿" }, "call_x"), toolCallMsg("end_turn", { note: "毕" }));
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 1, 5000);
    expect(hub.sent.length).toBe(1);
    expect(hub.sent[0].req.to).toBe("post:zhongshu.sheren_a");
    expect(hub.sent[0].req.idem_key).toMatch(/^menxia\.jishizhong_a:tn_.+:call_x$/);
  });

  it("名册换人：旧官员停，新官员起", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    expect(rt.officials.get(POST)!.officialId).toBe(OFFICIAL_ID);
    hub.registry = {
      ...hub.registry,
      version: 2,
      officials: [...hub.registry.officials, makeOfficial({ official_id: "of_new", name: "房玄成" })],
      appointments: [{ post_id: POST, official_id: "of_new", since: Date.now() }],
    };
    await until(() => rt!.officials.get(POST)?.officialId === "of_new");
  });

  it("轮中皇帝来信：steer 注入，并随本轮一并确认", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    const first = hub.addMessage(POST, { from: "post:zhongshu.sheren_a", body: "请审草稿" });
    let emp: ReturnType<FakeHub["addMessage"]> | undefined;
    model.push(
      () => {
        emp = hub.addMessage(POST, { from: "emperor", kind: "oral_order", body: "且慢，先回朕话" });
        rt!.doorbell([POST]);
        return toolCallMsg("slow", { ms: 150 });
      },
      toolCallMsg("end_turn", { note: "毕" }),
    );
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 1);
    expect(model.calls.length).toBe(2);
    const text = JSON.stringify(model.calls[1].ctx.messages);
    expect(text).toContain("陛下有新旨");
    expect(text).toContain(emp!.message.id);
    expect(hub.acks[0].seq).toBe(emp!.delivery.seq);
    expect(first.delivery.seq).toBeLessThan(emp!.delivery.seq);
    await delay(100);
    expect(model.calls.length).toBe(2); // 已处理，不再另起一轮
  });

  it("每小时空转轮次上限：超出强制休息（suspended）并上报 turn.capped", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model, { limits: { maxTurnsPerHour: 1 } });
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "一" });
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 1);
    hub.addMessage(POST, { from: "emperor", body: "二" });
    rt.doorbell([POST]);
    await until(() => hub.events.some((e) => e.type === "turn.capped"));
    expect(model.calls.length).toBe(1);
    expect(rt.officials.get(POST)!.status().state).toBe("suspended");
  });

  it("有实效的轮次不计入空转上限", () => {
    expect(isProductiveTurn(["edict_get", "edict_dispatch", "end_turn"])).toBe(true);
    expect(isProductiveTurn(["task_verify", "end_turn"])).toBe(true);
    expect(isProductiveTurn(["send_message", "wait_for"])).toBe(true);
    expect(isProductiveTurn(["read_inbox", "get_message", "end_turn"])).toBe(false);
    expect(isProductiveTurn(["edict_get", "task_list", "whats_happening", "sleep"])).toBe(false);
    expect(isProductiveTurn([])).toBe(false);
  });

  it("罢朝：暂停", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.registry.halted = true;
    await until(() => rt!.officials.get(POST)!.status().state === "paused");
    hub.addMessage(POST, { from: "emperor", body: "x" });
    rt.doorbell([POST]);
    await delay(100);
    expect(model.calls.length).toBe(0);
    hub.registry.halted = false;
    model.push(toolCallMsg("end_turn", { note: "毕" }));
    await until(() => model.calls.length === 1);
  });
});

describe("官员运行时（复审修复回归）", () => {
  it("简报截断留下的积压：轮后重新评估，积压中的皇帝来信即刻打断睡眠", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model, { limits: { briefingMaxItems: 2 } });
    await rt.start();
    hub.addMessage(POST, { from: "post:zhongshu.sheren_a", body: "一" });
    hub.addMessage(POST, { from: "post:zhongshu.sheren_a", body: "二" });
    const emp = hub.addMessage(POST, { from: "emperor", kind: "oral_order", body: "三：速来" });
    model.push(toolCallMsg("sleep", { seconds: 3600, reason: "歇息" }), toolCallMsg("end_turn", { note: "毕" }));
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 2, 2000);
    expect(hub.acks.map((a) => a.seq)).toEqual([2, emp.delivery.seq]);
    expect(lastUserText(model.calls[1].ctx)).toContain(emp.message.id);
  });

  it("轮中注入的皇帝来信与已确认段不相连：下轮不再重复呈上，并随下轮确认", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "post:zhongshu.sheren_a", body: "请审草稿" });
    let peer: ReturnType<FakeHub["addMessage"]> | undefined;
    let emp: ReturnType<FakeHub["addMessage"]> | undefined;
    model.push(
      () => {
        peer = hub.addMessage(POST, { from: "post:zhongshu.sheren_a", body: "补充一句" });
        emp = hub.addMessage(POST, { from: "emperor", kind: "oral_order", body: "且慢，先回朕话" });
        rt!.doorbell([POST]);
        return toolCallMsg("slow", { ms: 150 });
      },
      toolCallMsg("end_turn", { note: "已回陛下" }),
      toolCallMsg("end_turn", { note: "补充已阅" }),
    );
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 2, 3000);
    expect(JSON.stringify(model.calls[1].ctx.messages)).toContain(emp!.message.id); // 轮中已注入
    expect(hub.acks[0].seq).toBe(1); // 不相连：本轮不越过补充信
    const third = lastUserText(model.calls[2].ctx);
    expect(third).toContain(peer!.message.id);
    expect(third).not.toContain(emp!.message.id); // 不再重复呈上（新来信与职事清单都没有）
    expect(hub.acks[1].seq).toBe(emp!.delivery.seq);
    await delay(100);
    expect(model.calls.length).toBe(3);
  });

  it("抱恙恢复后退避计数归零：下次抱恙仍从 1 分钟起", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    const o = rt.officials.get(POST)!;
    hub.addMessage(POST, { from: "emperor", body: "审" });
    model.push(errorMsg("Proxy error: CIRCUIT_OPEN 提供商熔断"), toolCallMsg("end_turn", { note: "毕" }));
    rt.doorbell([POST]);
    await until(() => o.status().state === "sick");
    o.wakeManual("重试");
    await until(() => hub.acks.length === 1);
    hub.addMessage(POST, { from: "emperor", body: "再审" });
    model.push(errorMsg("Proxy error: CIRCUIT_OPEN 提供商熔断"));
    rt.doorbell([POST]);
    await until(() => o.status().state === "sick");
    expect(o.status().next_wake_at!).toBeLessThan(Date.now() + 90_000);
  });

  it("开轮时拉简报失败：人工唤醒不丢，退避后重试", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.briefingFailures = 1;
    model.push(toolCallMsg("end_turn", { note: "毕" }));
    rt.wake(POST, "陛下召见");
    await until(() => model.calls.length === 1, 5000);
    expect(lastUserText(model.calls[0].ctx)).toContain("人工唤醒");
  });

  it("停机强行中止当前轮：不推进 cursor（下次启动消息重现）", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "长差事" });
    model.push(toolCallMsg("slow", { ms: 300 }), abortedMsg());
    rt.doorbell([POST]);
    const o = rt.officials.get(POST)!;
    await until(() => o.inTurn);
    await rt.stop(50);
    rt = undefined;
    expect(hub.acks.length).toBe(0);
    expect(o.waitState().acked_seq).toBe(0);
    const turns = sessionRecords(dir).filter((r) => r.type === "turn");
    expect(turns.map((t) => t.status)).toEqual(["running", "aborted"]);
  });

  it("本地游标领先 hub（上次确认失败）：启动后补报", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    mkdirSync(join(dir, "officials", OFFICIAL_ID), { recursive: true });
    writeFileSync(
      join(dir, "officials", OFFICIAL_ID, "state.json"),
      JSON.stringify({ next_wake_at: Date.now() + 3600_000, mode: "wait", agent_set: false, idle_backoff: 1, acked_seq: 5, post_id: POST }),
    );
    rt = makeRuntime(hub, scriptedModel());
    await rt.start();
    await until(() => hub.acks.some((a) => a.seq === 5));
  });

  it("重启沿用本地等待条件与游标（sleep 不因重启丢失）", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    const item = hub.addMessage(POST, { from: "emperor", body: "审" });
    model.push(toolCallMsg("sleep", { seconds: 3600, reason: "歇息" }));
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 1);
    const before = rt.officials.get(POST)!.waitState();
    await rt.stop(100);
    hub.acked.set(POST, 0); // 模拟 hub 侧确认未落库
    rt = makeRuntime(hub, scriptedModel());
    await rt.start();
    const w = rt.officials.get(POST)!.waitState();
    expect(w.mode).toBe("sleep");
    expect(w.agent_set).toBe(true);
    expect(w.next_wake_at).toBe(before.next_wake_at);
    expect(w.acked_seq).toBe(item.delivery.seq);
    await until(() => (hub.acked.get(POST) ?? 0) === item.delivery.seq); // 补报 hub
  });

  it("去抖等待不在长寿 abort signal 上累积监听器", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    rt = makeRuntime(hub, scriptedModel());
    await rt.start();
    const o = rt.officials.get(POST)!;
    for (let i = 0; i < 20; i++) {
      o.kick("poll");
      await delay(15);
    }
    await delay(30);
    const signal = (o as unknown as { stopController: AbortController }).stopController.signal;
    expect(getEventListeners(signal, "abort").length).toBeLessThanOrEqual(1);
  });

  it("官员目录锁：他部门尚在收尾时不接任，锁释放后自动接任；停止时删锁", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const lock = join(dir, "officials", OFFICIAL_ID, "runtime.lock");
    mkdirSync(join(dir, "officials", OFFICIAL_ID), { recursive: true });
    writeFileSync(lock, JSON.stringify({ dept: "zhongshu", post_id: "zhongshu.sheren_a", at: Date.now() }));
    rt = makeRuntime(hub, scriptedModel());
    await rt.start();
    expect(rt.officials.has(POST)).toBe(false);
    rmSync(lock);
    await until(() => rt!.officials.has(POST), 8000);
    expect(JSON.parse(readFileSync(lock, "utf8")).dept).toBe("menxia");
    await rt.stop(100);
    rt = undefined;
    expect(existsSync(lock)).toBe(false);
  }, 15_000);

  it("名册刷新不拖住心跳（离任官员收尾期间心跳照常）", async () => {
    const dir = tmpDataDir();
    const hub = new FakeHub(dir);
    const model = scriptedModel();
    rt = makeRuntime(hub, model);
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "长差事" });
    model.push(toolCallMsg("slow", { ms: 800 }), toolCallMsg("end_turn", { note: "毕" }));
    rt.doorbell([POST]);
    await until(() => rt!.officials.get(POST)!.inTurn);
    hub.registry = {
      ...hub.registry,
      version: 2,
      officials: [...hub.registry.officials, makeOfficial({ official_id: "of_new", name: "房玄成" })],
      appointments: [{ post_id: POST, official_id: "of_new", since: Date.now() }],
    };
    await delay(150);
    const before = hub.heartbeats;
    await delay(400);
    expect(hub.heartbeats - before).toBeGreaterThanOrEqual(3);
    await until(() => rt!.officials.get(POST)?.officialId === "of_new", 3000);
  });

  it("状态变化即提前心跳：不等满心跳周期", async () => {
    const hub = new FakeHub(tmpDataDir());
    const model = scriptedModel();
    rt = makeRuntime(hub, model, { limits: { heartbeatMs: 60_000 } });
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "长差事" });
    model.push(toolCallMsg("slow", { ms: 800 }), toolCallMsg("end_turn", { note: "毕" }));
    rt.doorbell([POST]);
    await until(() => hub.heartbeatStates.some((s) => s === `${POST}:thinking` || s === `${POST}:tool`), 2000);
    await until(() => !rt!.officials.get(POST)!.inTurn, 5000);
  });
});
