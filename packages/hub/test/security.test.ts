import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "@court/shared";
import { startHub, expectStatus, raw, type TestHub } from "./helpers.ts";
import { EMPEROR_MSG_PER_HOUR } from "../src/services/messages.ts";
import type { ScheduleServiceExt } from "../src/services/schedules.ts";

describe("权限与防护（复审修复）", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("他部来往信件不可读；网关不可读信", async () => {
    const a = hub.as("zhongshu.sheren_a");
    const r = await a.sendMessage({ from: "post:zhongshu.sheren_a", to: "post:menxia.jishizhong_a", kind: "chat", subject: "密函", body: "仅限中书门下知悉的内容" });
    expect((await hub.as("menxia.shilang").getMessage(r.message.id)).id).toBe(r.message.id);
    await expectStatus(hub.as("hubu.shangshu").getMessage(r.message.id), 403);
    expect(await hub.as("hubu.shangshu").thread(r.message.thread_id)).toEqual([]);
    expect((await hub.as("hubu.shangshu").searchMessages({ post: "zhongshu.sheren_a" })).some((m) => m.id === r.message.id)).toBe(false);
    await expectStatus(hub.gateway.getMessage(r.message.id), 403);
    await expectStatus(hub.as("hubu.shangshu").emperorInbox(), 403);
    expect((await raw(hub, "GET", "/api/live/zhongshu.sheren_a/context", { token: hub.ctx.registry.deptToken("zhongshu"), post: "zhongshu.shilang" })).status).toBe(403);
  });

  it("官员不能发系统类消息、不能借 parent_hop 重置跳数、致陛下限流", async () => {
    const a = hub.as("bingbu.zhifang_langzhong");
    await expectStatus(a.sendMessage({ from: "post:bingbu.zhifang_langzhong", to: "post:bingbu.shangshu", kind: "notification_reply", subject: "x", body: "伪造的批复内容" }), 400);
    await expectStatus(a.sendMessage({ from: "post:bingbu.zhifang_langzhong", to: "post:bingbu.shangshu", kind: "audit", subject: "x", body: "伪造的稽查内容" }), 400);

    // 构造一条 hop 已到上限的信，回复时声称 parent_hop=0 也无效
    const deep = hub.ctx.messages.send({ from: "system:hub", to: "post:bingbu.zhifang_langzhong", kind: "chat", subject: "深链", body: "深链消息", parent_hop: LIMITS.maxHopCount - 1 });
    expect(deep.message.hop_count).toBe(LIMITS.maxHopCount);
    await expectStatus(a.sendMessage({ from: "post:bingbu.zhifang_langzhong", to: "post:bingbu.shangshu", kind: "chat", subject: "x", body: "试图重置跳数", reply_to: deep.message.id, parent_hop: 0 }), 429);

    const b = hub.as("bingbu.shilang");
    for (let i = 0; i < EMPEROR_MSG_PER_HOUR; i++) await b.sendMessage({ from: "post:bingbu.shilang", to: "emperor", kind: "chat", subject: `奏${i}`, body: `臣有本奏第 ${i} 件事` });
    await expectStatus(b.sendMessage({ from: "post:bingbu.shilang", to: "emperor", kind: "chat", subject: "再奏", body: "臣还有一件事要奏" }), 429);
    // 回复陛下来信不受限
    const q = await hub.emperor.emperorOral({ to: "post:bingbu.shilang", content: "兵械清点如何？", requires_reply: true });
    await b.sendMessage({ from: "post:bingbu.shilang", to: "emperor", kind: "chat", subject: "回禀", body: "已清点完毕，并无短缺。", reply_to: q.message.id });
  });

  it("事件上报：不得冒用他部 actor、不得覆盖他部 span；预算检查官员不可调", async () => {
    const tok = hub.ctx.registry.deptToken("gongbu")!;
    const ev = { uid: "g:1", ts: hub.clock.t, type: "approval.approved", actor: "emperor", summary: "伪造" };
    expect((await raw(hub, "POST", "/api/events", { token: tok, body: { events: [ev] } })).status).toBe(403);
    hub.ctx.events.span({ span_id: "sp_hub1", trace_id: "tr_h", kind: "edict", name: "诏令", actor: "system:hub" });
    const ev2 = { uid: "g:2", ts: hub.clock.t, type: "turn.start", actor: "post:gongbu.langzhong", summary: "x", span: { span_id: "sp_hub1", trace_id: "tr_h", kind: "turn", name: "篡改", actor: "post:gongbu.langzhong", status: "ok", started_at: 1 } };
    expect((await raw(hub, "POST", "/api/events", { token: tok, body: { events: [ev2] } })).status).toBe(403);
    await expectStatus(hub.as("gongbu.langzhong").budgetCheck({ post_id: "gongbu.langzhong", estimate_tokens: 1 }), 403);
  });

  it("审批：撤下视同驳回；驳回的定时任务作废；只调成本的上调不会取消 token 限额", async () => {
    const a = hub.as("gongbu.langzhong");
    const s = await a.createSchedule({ actor: "post:gongbu.langzhong", owner: "post:gongbu.langzhong", title: "高频", spec: { every_seconds: 600 }, payload: "x" });
    const ap = (await hub.emperor.approvals("pending")).find((x) => x.payload.schedule_id === s.id)!;
    await hub.emperor.resolveNotification(ap.notification_id, { option: "dismiss" });
    expect((await hub.emperor.approvals("rejected")).some((x) => x.id === ap.id)).toBe(true);
    expect((hub.ctx.schedules as ScheduleServiceExt).get(s.id)!.status).toBe("expired");

    await hub.emperor.setBudget({ actor: "emperor", scope: "dept:gongbu", daily_tokens: 1000, daily_cost: 1 });
    const res = await hub.as("hubu.duzhi_langzhong").setBudget({ actor: "post:hubu.duzhi_langzhong", scope: "dept:gongbu", daily_cost: 5 });
    const ap2 = (await hub.emperor.approvals("pending")).find((x) => x.id === (res as { approval_id: string }).approval_id)!;
    await hub.emperor.resolveNotification(ap2.notification_id, { option: "approve" });
    const b = (await hub.emperor.budgetStatus()).budgets.find((x) => x.scope === "dept:gongbu")!;
    expect(b).toMatchObject({ daily_tokens: 1000, daily_cost: 5 });
  });

  it("幂等键按调用方隔离", async () => {
    const r1 = await hub.as("libu_rites.langzhong").sendMessage({ from: "post:libu_rites.langzhong", to: "post:libu_rites.shangshu", kind: "chat", subject: "x", body: "同一个键第一封", idem_key: "same" });
    const r2 = await hub.as("xingbu.langzhong").sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shangshu", kind: "chat", subject: "x", body: "同一个键第二封", idem_key: "same" });
    expect(r2.message.id).not.toBe(r1.message.id);
  });
});
