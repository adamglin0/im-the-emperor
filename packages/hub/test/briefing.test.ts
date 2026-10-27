// 醒来简报：优先级、结构化消息去重、上限与计数。
import { describe, expect, it } from "vitest";
import { LIMITS } from "@court/shared";
import { createFakeCtx } from "./fakes-b.ts";

const POST = "gongbu.shangshu";

describe("醒来简报", () => {
  it("陛下批复与来信优先，其次职事，最后普通来信；结构化通知不重复列出", () => {
    const ctx = createFakeCtx();
    ctx.messages.send({ from: "post:bingbu.shangshu", to: `post:${POST}`, kind: "chat", subject: "借工匠", body: "可否借调工匠", requires_reply: true });
    const t = ctx.wf.tasks.createTask({ creator: { addr: "post:shangshu.youpuye", post: "shangshu.youpuye" }, dept: "gongbu", title: "修桥", instructions: "修", acceptance: "成" });
    ctx.messages.notifyPost(POST, "schedule", "每日巡检", "巡检工地", { meta: { schedule_id: "sch_1" } });
    ctx.messages.send({ from: "emperor", to: `post:${POST}`, kind: "oral_order", subject: "口谕", body: "速修" });
    ctx.messages.notifyPost(POST, "notification_reply", "陛下批复", "准", { from: "emperor", meta: { notification_id: "nt_1", option: "approve", comment: "准奏" } });

    const b = ctx.briefing.build(POST, 0, "doorbell");
    expect(b.items.map((i) => i.type)).toEqual(["notification_reply", "message", "task_assigned", "schedule", "message"]);
    expect(b.items[0]).toEqual({ type: "notification_reply", notification_id: "nt_1", option: "approve", comment: "准奏" });
    expect(b.items[1]).toMatchObject({ type: "message", from: "emperor", kind: "oral_order" });
    expect(b.items[2]).toEqual({ type: "task_assigned", task_id: t.id, title: "修桥", state: "assigned", is_head: true });
    expect(b.items[3]).toEqual({ type: "schedule", schedule_id: "sch_1", title: "每日巡检", payload: "巡检工地" });
    expect(b.items[4]).toMatchObject({ type: "message", from: "post:bingbu.shangshu", requires_reply: true });
    expect(b.latest_seq).toBe(ctx.messages.latestSeq(POST));
    expect(b.more).toBe(0);

    // after 之后无新信：只剩结构化职事
    const b2 = ctx.briefing.build(POST, b.latest_seq, "timeout");
    expect(b2.items.map((i) => i.type)).toEqual(["task_assigned"]);
    expect(ctx.briefing.pendingItems(POST)).toEqual([b.items[2]]);
  });

  it("超过上限只列前 K 条并计数", () => {
    const ctx = createFakeCtx();
    for (let i = 0; i < LIMITS.briefingMaxItems + 3; i++) {
      ctx.wf.tasks.createTask({ creator: { addr: "post:shangshu.youpuye", post: "shangshu.youpuye" }, dept: "gongbu", title: `任务${i}`, instructions: "做", acceptance: "成" });
    }
    const b = ctx.briefing.build(POST, 0, "x");
    expect(b.items).toHaveLength(LIMITS.briefingMaxItems);
    // 3 条结构化职事未列出 + 扫描窗口（K 封）之外的 3 封新信
    expect(b.more).toBe(3 + 3);
    expect(b.latest_seq).toBe(LIMITS.briefingMaxItems);
  });

  it("转交下属后长官不再标 is_head；未知职位 404", () => {
    const ctx = createFakeCtx();
    const head = { addr: `post:${POST}`, post: POST };
    const t = ctx.wf.tasks.createTask({ creator: { addr: "post:shangshu.youpuye", post: "shangshu.youpuye" }, dept: "gongbu", title: "修", instructions: "修", acceptance: "成" });
    ctx.wf.tasks.taskAction(t.id, { action: "assign", post: POST, assignee_post: "gongbu.langzhong" }, head);
    expect(ctx.briefing.pendingItems(POST)).toEqual([]);
    expect(ctx.briefing.pendingItems("gongbu.langzhong")).toEqual([{ type: "task_assigned", task_id: t.id, title: "修", state: "assigned", is_head: false }]);
    expect(() => ctx.briefing.build("nobody.x", 0, "")).toThrow(/不存在/);
  });

  it("来信类职事不被结构化职事挤掉：扫描窗口与 runtime 一致，游标只推进到窗口末尾", () => {
    const ctx = createFakeCtx();
    const K = LIMITS.briefingMaxItems;
    for (let i = 0; i < K; i++) ctx.messages.send({ from: "post:bingbu.shangshu", to: `post:${POST}`, kind: "chat", subject: `问${i}`, body: "请复", requires_reply: true });
    for (let i = 0; i < 6; i++) ctx.wf.tasks.createTask({ creator: { addr: "post:shangshu.youpuye", post: "shangshu.youpuye" }, dept: "gongbu", title: `任务${i}`, instructions: "做", acceptance: "成" });
    const b = ctx.briefing.build(POST, 0, "doorbell");
    const msgs = b.items.filter((i) => i.type === "message");
    expect(msgs).toHaveLength(K);
    expect(b.items.filter((i) => i.type === "task_assigned")).toHaveLength(4);
    expect(b.latest_seq).toBe(K);
    // 下一轮：剩余结构化职事全部列出，已确认的来信不重复
    const b2 = ctx.briefing.build(POST, b.latest_seq, "doorbell");
    expect(b2.items.map((i) => i.type)).toEqual(Array(6).fill("task_assigned"));
  });

  it("中书复署职事只给有复署权且持工具者；考卷职事不含作废场次", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "复署", intent: "x", actor: "emperor" });
    ctx.wf.edicts.submitDraft(e.id, { title: "t", objective: "o", constraints: "c", acceptance: "a", deadline_text: "d", suggested_depts: ["gongbu"], text: "x", responses: [] }, { addr: "post:zhongshu.sheren_a", post: "zhongshu.sheren_a" });
    expect(ctx.briefing.pendingItems("zhongshu.shilang")).toEqual([{ type: "edict_countersign", edict_id: e.id, title: "复署", draft_no: 1 }]);
    expect(ctx.briefing.pendingItems("zhongshu.sheren_b")).toEqual([]);

    ctx.db.run("INSERT INTO exam_sessions (id, model_key, state, created_at, data_json) VALUES ('ex_f', 'x/y', 'failed', 0, '{}')");
    ctx.db.run("INSERT INTO exam_answers (id, session_id, question_id, state, data_json) VALUES ('ans_f', 'ex_f', 'q', 'needs_grading', '{}')");
    expect(ctx.briefing.pendingItems("libu.kaogong_langzhong")).toEqual([]);
  });
});
