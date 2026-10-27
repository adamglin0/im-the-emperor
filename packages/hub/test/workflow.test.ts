// 议事 → 颁旨 → 起草/复署 → 封驳/重拟 → 审核 → 分派 → 执行/核验 → 复奏 → 御览（服务层，内存 ctx）。
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, SLA, type Span } from "@court/shared";
import { createFakeCtx, type FakeCtx } from "./fakes-b.ts";
import type { FlowActor } from "../src/services/workflow-tasks.ts";
import { createAssets } from "../src/services/assets.ts";

const A = (post: string): FlowActor => ({ addr: `post:${post}`, post });
const EMP: FlowActor = { addr: "emperor" };
const CHAIR = "zhengshitang.zhongshuling";
const MEMBERS = [CHAIR, "zhengshitang.shizhong", "zhengshitang.zuopuye", "zhengshitang.tongsanpin"];
const DRAFTER = "zhongshu.sheren_a";
const ZS_HEAD = "zhongshu.shilang";
const REVIEWER = "menxia.jishizhong_a";
const DISPATCHER = "shangshu.youpuye";

function draft(extra: Record<string, unknown> = {}) {
  return {
    title: "修长安东门",
    objective: "三日内修好长安城东门",
    constraints: "不得扰民",
    acceptance: "城门可正常开合",
    deadline_text: "三日",
    suggested_depts: ["gongbu" as const],
    text: "诏曰：东门损坏，着工部修缮。",
    responses: [] as { issue_id: string; response: string }[],
    ...extra,
  };
}

/** 提交草稿并由侍郎复署，进入审核 */
function submitAndSign(ctx: FakeCtx, id: string, responses: { issue_id: string; response: string }[] = []) {
  ctx.wf.edicts.submitDraft(id, draft({ responses }), A(ctx.wf.edicts.getEdictOrNull(id)!.drafter_post!));
  return ctx.wf.edicts.countersign(id, { approve: true, comment: "可" }, A(ZS_HEAD));
}

const blocking = (clause: string) => ({ severity: "blocking" as const, clause, reason: "缺验收标准" as const, required_change: "补充验收标准" });

let saved: string | undefined;
afterEach(() => {
  if (saved === undefined) delete process.env.REQUIRE_FINAL_SIGN;
  else process.env.REQUIRE_FINAL_SIGN = saved;
});

describe("政事堂议事", () => {
  it("按序发言、主持定夺、总结后皇帝照准颁旨", () => {
    const ctx = createFakeCtx();
    const d = ctx.wf.emperorSpeaks("朕欲修长安东门，诸卿以为如何？");
    expect(d.chair_post).toBe(CHAIR);
    expect(d.speaker_queue).toEqual(MEMBERS);
    expect(d.current_speaker).toBe(CHAIR);
    expect(ctx.inboxOf(CHAIR).at(-1)?.kind).toBe("council");

    expect(() => ctx.wf.council.speak(d.id, "zhengshitang.shizhong", "support", "可")).toThrow(/尚未轮到你发言/);
    for (const p of MEMBERS) ctx.wf.council.speak(d.id, p, p === "zhengshitang.zuopuye" ? "reserve" : "support", `${p} 以为可`);
    // 宰相发言只唤醒下一位
    expect(ctx.inboxOf("zhengshitang.zuopuye").filter((m) => m.kind === "council")).toHaveLength(1);

    let det = ctx.wf.council.detail(d.id);
    expect(det.deliberation.current_speaker).toBeUndefined();
    expect(ctx.briefing.pendingItems(CHAIR)).toContainEqual({ type: "council_chair", deliberation_id: d.id, round: 1, all_spoken: true, topic: d.topic });

    expect(() => ctx.wf.council.nextRound(d.id, "zhengshitang.shizhong")).toThrow(/只有主持人/);
    ctx.wf.council.nextRound(d.id, CHAIR, "再议细节");
    for (const p of MEMBERS) ctx.wf.council.speak(d.id, p, "support", "附议");
    expect(() => ctx.wf.council.nextRound(d.id, CHAIR)).toThrow(/已达最大轮次/);

    ctx.wf.council.conclude(d.id, CHAIR, { summary: "宜修", dissent: "左仆射虑工期", proposed_edict: { title: "修东门", intent: "三日内修好东门" }, confidence: 0.8 });
    det = ctx.wf.council.detail(d.id);
    expect(det.deliberation.state).toBe("concluded");
    expect(ctx.inboxOf("zhengshitang.tanghouguan").at(-1)?.subject).toMatch(/纪要/);

    const n = ctx.notificationsList("council_conclusion")[0];
    expect(n.options.map((o) => o.id)).toEqual(["approve", "reconvene", "shelve"]);
    ctx.notifications.resolve(n.id, "approve", "务必坚固");
    const e = ctx.wf.edicts.listEdicts(undefined, 10)[0];
    expect(e).toMatchObject({ state: "drafting", drafter_post: DRAFTER, deliberation_id: d.id });
    expect(e.intent).toContain("【朕批】务必坚固");
    expect(ctx.wf.council.detail(d.id).deliberation.state).toBe("closed");
    // 主持人收到批复回写
    expect(ctx.inboxOf(CHAIR).at(-1)?.kind).toBe("notification_reply");
  });

  it("再议开启新场次；发言超时由看门狗视为弃权", () => {
    const ctx = createFakeCtx();
    const d = ctx.wf.emperorSpeaks("议事");
    ctx.wf.council.conclude(d.id, CHAIR, { summary: "无结论", dissent: "", confidence: 0.3 });
    const n = ctx.notificationsList("council_conclusion")[0];
    expect(n.options.map((o) => o.id)).toEqual(["reconvene", "shelve"]);
    ctx.notifications.resolve(n.id, "reconvene", "");
    const re = ctx.wf.council.detail(d.id).deliberation;
    expect(re).toMatchObject({ state: "open", session_no: 2, round: 1, current_speaker: CHAIR });

    ctx.advance(SLA.council_turn * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    const after = ctx.wf.council.detail(d.id);
    expect(after.deliberation.current_speaker).toBe("zhengshitang.shizhong");
    expect(after.entries.at(-1)).toMatchObject({ stance: "pass", content: "（超时未发言，视为弃权）" });
  });
});

describe("诏令全流程", () => {
  it("起草→复署→封驳→逐条回应→审核→分派→核验→复奏→御览", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "修东门", intent: "三日内修好东门", actor: "emperor" });
    expect(e).toMatchObject({ state: "drafting", drafter_post: DRAFTER, draft_no: 0 });
    expect(ctx.inboxOf(DRAFTER).at(-1)).toMatchObject({ kind: "edict_notice", trace_id: e.id });

    expect(() => ctx.wf.edicts.submitDraft(e.id, draft(), A("zhongshu.sheren_b"))).toThrow(/起草人/);
    expect(() => ctx.wf.edicts.submitDraft(e.id, { ...draft(), expected_version: 99 }, A(DRAFTER))).toThrow(/版本冲突/);
    let det = ctx.wf.edicts.submitDraft(e.id, draft(), A(DRAFTER));
    expect(det.edict).toMatchObject({ state: "drafting", draft_no: 1, awaiting_countersign: true });
    expect(ctx.briefing.pendingItems(ZS_HEAD)).toContainEqual({ type: "edict_countersign", edict_id: e.id, title: "修东门", draft_no: 1 });
    expect(ctx.briefing.pendingItems(DRAFTER)).toEqual([]);

    det = ctx.wf.edicts.countersign(e.id, { approve: true, comment: "" }, A(ZS_HEAD));
    expect(det.edict).toMatchObject({ state: "reviewing", reviewer_post: REVIEWER });
    expect(det.drafts[0].countersigned_by).toBe(ZS_HEAD);

    expect(() => ctx.wf.edicts.review(e.id, { decision: "reject", issues: [], opinion: "不可" }, A(REVIEWER))).toThrow(/至少需要 1 条/);
    det = ctx.wf.edicts.review(e.id, { decision: "reject", issues: [blocking("第三条"), { ...blocking("措辞"), severity: "advisory" }], opinion: "缺验收" }, A(REVIEWER));
    expect(det.edict).toMatchObject({ state: "drafting", reject_count: 1 });
    const issueId = det.reviews[0].issues[0].id;
    expect(issueId).toMatch(/^iss_/);
    expect(ctx.briefing.pendingItems(DRAFTER)).toEqual([{ type: "edict_draft", edict_id: e.id, title: "修东门", draft_no_next: 2, rejected: true, open_issue_ids: [issueId] }]);

    expect(() => ctx.wf.edicts.submitDraft(e.id, draft(), A(DRAFTER))).toThrow(new RegExp(`尚缺：${issueId}`));
    submitAndSign(ctx, e.id, [{ issue_id: issueId, response: "已补验收标准" }]);
    expect(ctx.briefing.pendingItems(REVIEWER)[0]).toMatchObject({ type: "edict_review", draft_no: 2 });

    expect(() => ctx.wf.edicts.review(e.id, { decision: "reject", issues: [blocking("新问题")], opinion: "又有问题" }, A(REVIEWER))).toThrow(/第2次及以后审核不得新增 blocking/);
    det = ctx.wf.edicts.review(e.id, { decision: "approve", issues: [], opinion: "准" }, A(REVIEWER));
    expect(det.edict).toMatchObject({ state: "approved", dispatcher_post: DISPATCHER });
    expect(ctx.briefing.pendingItems(DISPATCHER)).toEqual([{ type: "edict_dispatch", edict_id: e.id, title: "修东门", suggested_depts: ["gongbu"] }]);

    det = ctx.wf.edicts.dispatch(
      e.id,
      {
        tasks: [
          { dept: "gongbu", title: "修门", instructions: "修好东门", acceptance: "可开合" },
          { dept: "libu_rites", title: "写告示", instructions: "告示百姓", acceptance: "通顺", verify_by: "self" },
        ],
      },
      A(DISPATCHER),
    );
    expect(det.edict.state).toBe("executing");
    const [t1, t2] = det.tasks;
    expect(t1).toMatchObject({ assignee_post: "gongbu.shangshu", state: "assigned", trace_id: e.id, edict_id: e.id });
    expect(ctx.briefing.pendingItems("gongbu.shangshu")).toContainEqual({ type: "task_assigned", task_id: t1.id, title: "修门", state: "assigned", is_head: true });
    expect(() => ctx.wf.edicts.report(e.id, { summary: "完" }, A(DISPATCHER))).toThrow(/尚有 2 项任务未终结/);

    // 工部尚书转交郎中 → 郎中办理 → 分派人核验
    ctx.wf.tasks.taskAction(t1.id, { action: "assign", post: "gongbu.shangshu", assignee_post: "gongbu.langzhong" }, A("gongbu.shangshu"));
    expect(() => ctx.wf.tasks.taskAction(t1.id, { action: "start", post: "gongbu.shangshu" }, A("gongbu.shangshu"))).toThrow(/只有承办人/);
    ctx.wf.tasks.taskAction(t1.id, { action: "start", post: "gongbu.langzhong" }, A("gongbu.langzhong"));
    let td = ctx.wf.tasks.taskAction(t1.id, { action: "submit", post: "gongbu.langzhong", result: "东门已修好，开合顺畅" }, A("gongbu.langzhong"));
    expect(td.task).toMatchObject({ state: "submitted", verifier_post: DISPATCHER });
    expect(ctx.briefing.pendingItems(DISPATCHER)).toContainEqual({ type: "task_verify", task_id: t1.id, title: "修门" });
    td = ctx.wf.tasks.taskAction(t1.id, { action: "verify", post: DISPATCHER, pass: true, comment: "合格" }, A(DISPATCHER));
    expect(td.task.state).toBe("done");

    ctx.wf.tasks.taskAction(t2.id, { action: "submit", post: "libu_rites.shangshu", result: "告示已张贴于各坊" }, A("libu_rites.shangshu"));
    expect(ctx.inboxOf(DISPATCHER).at(-1)?.subject).toMatch(/全部终结/);
    expect(ctx.briefing.pendingItems(DISPATCHER)).toContainEqual({ type: "edict_report", edict_id: e.id, title: "修东门", tasks_total: 2, tasks_open: 0 });

    det = ctx.wf.edicts.report(e.id, { summary: "东门修好，告示已发", failures: "" }, A(DISPATCHER));
    expect(det.edict.state).toBe("reported");
    const rep = ctx.notificationsList("report")[0];
    ctx.notifications.resolve(rep.id, "accept", "善");
    det = ctx.wf.edicts.detail(e.id);
    expect(det.edict.state).toBe("completed");
    expect(det.transitions.map((t) => t.to_state)).toEqual(
      expect.arrayContaining(["drafting", "reviewing", "approved", "executing", "reported", "completed"]),
    );
    const root = ctx.db.getJson<Span>("SELECT data_json FROM spans WHERE span_id = ?", `sp_${e.id}`)!;
    expect(root).toMatchObject({ kind: "edict", status: "ok" });
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM spans WHERE trace_id = ? AND kind IN ('draft','review','dispatch','task','report')", e.id)!.n).toBeGreaterThanOrEqual(8);
  });

  it("封驳超过上限 → 奏请圣裁；朕意修改后重置计数", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "测封驳", intent: "测试", actor: "emperor" });
    let open: string[] = [];
    for (let i = 1; i <= LIMITS.maxRejects + 1; i++) {
      submitAndSign(ctx, e.id, open.map((id) => ({ issue_id: id, response: "已改" })));
      const clause = i === 1 ? "第一条" : `复核 ${open[0]}`;
      const det = ctx.wf.edicts.review(e.id, { decision: "reject", issues: [blocking(clause)], opinion: "不可" }, A(REVIEWER));
      open = [det.reviews.at(-1)!.issues[0].id];
    }
    const ed = ctx.wf.edicts.detail(e.id).edict;
    expect(ed).toMatchObject({ state: "escalated", reject_count: LIMITS.maxRejects + 1 });
    const n = ctx.notificationsList("escalation")[0];
    expect(n.options.map((o) => o.id)).toEqual(["force_approve", "withdraw", "revise"]);
    ctx.notifications.resolve(n.id, "revise", "改为五日内完成");
    const after = ctx.wf.edicts.detail(e.id).edict;
    expect(after).toMatchObject({ state: "drafting", reject_count: 0 });
    expect(after.intent).toContain("【朕批】改为五日内完成");
    // 改旨后不再要求回应旧问题，审核也可重新提出 blocking
    submitAndSign(ctx, e.id);
    const det = ctx.wf.edicts.review(e.id, { decision: "reject", issues: [blocking("新的第一条")], opinion: "再议" }, A(REVIEWER));
    expect(det.edict.state).toBe("drafting");
  });

  it("谏诤：一版一次；坚持原旨恢复原状态；采纳修改回起草", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "大兴土木", intent: "建宫殿", actor: "emperor" });
    expect(() => ctx.wf.edicts.remonstrate(e.id, { risk: "劳民", alternative: "缓建" }, A(DRAFTER))).toThrow(/只有谏官/);
    let det = ctx.wf.edicts.remonstrate(e.id, { risk: "劳民伤财", alternative: "缓建" }, A("zhongshu.you_sanqi"));
    expect(det.edict.state).toBe("remonstrated");
    const n = ctx.notificationsList("remonstrance")[0];
    ctx.notifications.resolve(n.id, "insist", "朕意已决");
    det = ctx.wf.edicts.detail(e.id);
    expect(det.edict.state).toBe("drafting");
    expect(() => ctx.wf.edicts.remonstrate(e.id, { risk: "再谏", alternative: "无" }, A("menxia.zuo_sanqi"))).toThrow(/同一版只能谏一次/);

    submitAndSign(ctx, e.id);
    det = ctx.wf.edicts.remonstrate(e.id, { risk: "仍劳民", alternative: "减半" }, A("menxia.zuo_sanqi"));
    expect(det.edict.state).toBe("remonstrated");
    // 皇帝直接在诏令上操作：待办随之撤下
    det = ctx.wf.emperorEdictAction(e.id, "revise", "规模减半");
    expect(det.edict.state).toBe("drafting");
    expect(det.edict.intent).toContain("【朕批】规模减半");
    expect(ctx.notificationsList("remonstrance", "pending")).toHaveLength(0);
  });

  it("墨敕照准抄送御史台；撤回级联取消任务", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "急务", intent: "立办", actor: "emperor" });
    let det = ctx.wf.emperorEdictAction(e.id, "force_approve", "");
    expect(det.edict).toMatchObject({ state: "approved", skip_review: true });
    expect(ctx.inboxOf("yushitai.dafu").at(-1)?.subject).toMatch(/墨敕/);
    det = ctx.wf.edicts.dispatch(e.id, { tasks: [{ dept: "bingbu", title: "执行", instructions: "做", acceptance: "成" }] }, A("shangshu.zuocheng"));
    expect(det.edict.dispatcher_post).toBe("shangshu.zuocheng");
    det = ctx.wf.emperorEdictAction(e.id, "withdraw", "不办了");
    expect(det.edict.state).toBe("withdrawn");
    expect(det.tasks.every((t) => t.state === "cancelled")).toBe(true);
    expect(() => ctx.wf.emperorEdictAction(e.id, "withdraw", "")).toThrow(/已终结/);
  });

  it("墨敕颁旨：草稿复署后跳过门下", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "墨敕", intent: "速办", skip_review: true, actor: "emperor" });
    const det = submitAndSign(ctx, e.id);
    expect(det.edict.state).toBe("approved");
    expect(det.reviews).toHaveLength(0);
  });

  it("覆奏画可（REQUIRE_FINAL_SIGN=1）", () => {
    saved = process.env.REQUIRE_FINAL_SIGN;
    process.env.REQUIRE_FINAL_SIGN = "1";
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "画可", intent: "x", actor: "emperor" });
    submitAndSign(ctx, e.id);
    let det = ctx.wf.edicts.review(e.id, { decision: "approve", issues: [], opinion: "准" }, A(REVIEWER));
    expect(det.edict.state).toBe("awaiting_sign");
    const n = ctx.notificationsList("report")[0];
    expect(n.options.map((o) => o.id)).toEqual(["sign", "withdraw"]);
    ctx.notifications.resolve(n.id, "sign", "");
    det = ctx.wf.edicts.detail(e.id);
    expect(det.edict.state).toBe("approved");
  });

  it("拟旨奏请：照准即颁旨", () => {
    const ctx = createFakeCtx();
    const n = ctx.wf.edicts.proposeEdict({ title: "减赋", intent: "减免关中赋税一年", rationale: "旱灾" }, A(CHAIR));
    expect(n.category).toBe("edict_proposal");
    ctx.notifications.resolve(n.id, "approve", "");
    expect(ctx.wf.edicts.listEdicts("drafting", 10)[0]).toMatchObject({ title: "减赋" });
  });

  it("复奏发回重办 → 可追加分派", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "重办", intent: "x", actor: "emperor" });
    ctx.wf.emperorEdictAction(e.id, "force_approve", "");
    const det = ctx.wf.edicts.dispatch(e.id, { tasks: [{ dept: "gongbu", title: "t", instructions: "i", acceptance: "a", verify_by: "self" }] }, A(DISPATCHER));
    ctx.wf.tasks.taskAction(det.tasks[0].id, { action: "submit", post: "gongbu.shangshu", result: "做完了，详见资产" }, A("gongbu.shangshu"));
    ctx.wf.edicts.report(e.id, { summary: "完" }, A(DISPATCHER));
    ctx.notifications.resolve(ctx.notificationsList("report")[0].id, "reopen", "再加一件");
    expect(ctx.wf.edicts.detail(e.id).edict.state).toBe("executing");
    const more = ctx.wf.edicts.dispatch(e.id, { tasks: [{ dept: "xingbu", title: "复核", instructions: "查", acceptance: "无误" }] }, A(DISPATCHER));
    expect(more.tasks).toHaveLength(2);
  });
});

describe("任务", () => {
  it("未结上限、转派上限自动上报都事、退回超限判失败", () => {
    const ctx = createFakeCtx();
    const head = A("gongbu.shangshu");
    const mk = (assignee: string) => ctx.wf.tasks.createTask({ creator: head, dept: "gongbu", assignee_post: assignee, title: "活", instructions: "做", acceptance: "成" });
    for (let i = 0; i < LIMITS.maxOpenTasksPerPost; i++) mk("gongbu.langzhong");
    expect(() => mk("gongbu.langzhong")).toThrow(/未结任务已有 8 件/);

    const t = mk("gongbu.shilang");
    ctx.wf.tasks.taskAction(t.id, { action: "reassign", post: head.post!, assignee_post: "gongbu.shangshu", reason: "调整" }, head);
    ctx.wf.tasks.taskAction(t.id, { action: "reassign", post: head.post!, assignee_post: "gongbu.shilang", reason: "再调" }, head);
    expect(() => ctx.wf.tasks.taskAction(t.id, { action: "reassign", post: head.post!, assignee_post: "gongbu.shangshu", reason: "三调" }, head)).toThrow(/已自动上报尚书都事/);
    expect(ctx.inboxOf("shangshu.dushi").at(-1)?.subject).toMatch(/转派超限/);

    // 跨部门指定承办人：按部门路由
    const x = ctx.wf.tasks.createTask({ creator: head, dept: "xingbu", assignee_post: "xingbu.langzhong", title: "核", instructions: "查", acceptance: "无误", verify_by: "self" });
    expect(x.assignee_post).toBe("xingbu.shangshu");
    expect(ctx.wf.tasks.getTaskDetail(x.id).comments[0].content).toMatch(/跨部门/);

    const r = ctx.wf.tasks.createTask({ creator: head, dept: "gongbu", assignee_post: "gongbu.shilang", title: "返工", instructions: "做", acceptance: "成" });
    for (let i = 0; i <= LIMITS.maxReturns; i++) {
      ctx.wf.tasks.taskAction(r.id, { action: "submit", post: "gongbu.shilang", result: `第 ${i} 次提交` }, A("gongbu.shilang"));
      ctx.wf.tasks.taskAction(r.id, { action: "verify", post: head.post!, pass: false, comment: "不合格" }, head);
    }
    const final = ctx.wf.tasks.getTaskDetail(r.id).task;
    expect(final).toMatchObject({ state: "failed", return_count: LIMITS.maxReturns + 1 });
  });

  it("子任务全部终结唤醒父任务承办人；受阻知会管理者", () => {
    const ctx = createFakeCtx();
    const head = A("gongbu.shangshu");
    const parent = ctx.wf.tasks.createTask({ creator: A(DISPATCHER), dept: "gongbu", title: "总", instructions: "总", acceptance: "成" });
    expect(parent.assignee_post).toBe("gongbu.shangshu");
    const child = ctx.wf.tasks.createTask({ creator: head, dept: "gongbu", parent_id: parent.id, assignee_post: "gongbu.langzhong", title: "子", instructions: "子", acceptance: "成", verify_by: "self" });
    expect(child.trace_id).toBe(parent.trace_id);
    ctx.wf.tasks.taskAction(child.id, { action: "block", post: "gongbu.langzhong", reason: "缺料" }, A("gongbu.langzhong"));
    expect(ctx.inboxOf("gongbu.shangshu").at(-1)?.subject).toMatch(/受阻/);
    ctx.wf.tasks.taskAction(child.id, { action: "unblock", post: "gongbu.shangshu", note: "料到" }, head);
    ctx.wf.tasks.taskAction(child.id, { action: "submit", post: "gongbu.langzhong", result: "子任务完成" }, A("gongbu.langzhong"));
    expect(ctx.inboxOf("gongbu.shangshu").at(-1)?.subject).toMatch(/子任务已全部终结/);
  });
});

describe("服务调用", () => {
  it("部门路由、结果回传、越权回报、未知服务", () => {
    const ctx = createFakeCtx();
    const r = ctx.wf.services.call({ caller: "post:gongbu.langzhong", target: "dept:libu_rites", service: "polish", input: { text: "文稿" } });
    expect(r).toMatchObject({ state: "pending", routed_to: "libu_rites.shilang" });
    const req = ctx.inboxOf("libu_rites.shilang").at(-1)!;
    expect(req).toMatchObject({ kind: "service_request", meta: { request_id: r.id, service: "polish" } });
    expect(ctx.briefing.pendingItems("libu_rites.shilang")).toContainEqual({ type: "service_request", request_id: r.id, service: "polish", caller: "post:gongbu.langzhong" });
    expect(() => ctx.wf.services.respond(r.id, "libu_rites.langzhong", true, "x")).toThrow(/由 libu_rites.shilang 承办/);
    const done = ctx.wf.services.respond(r.id, "libu_rites.shilang", true, "润色稿");
    expect(done.state).toBe("done");
    expect(ctx.inboxOf("gongbu.langzhong").at(-1)).toMatchObject({ kind: "service_result", reply_to: req.id });

    expect(() => ctx.wf.services.call({ caller: "post:gongbu.langzhong", target: "dept:libu_rites", service: "fly", input: null })).toThrow(/polish, translate, format/);
    expect(() => ctx.wf.services.call({ caller: "post:gongbu.langzhong", target: "post:xingbu.langzhong", service: "audit_accounts", input: null })).toThrow(/可提供：verify, test/);
    const direct = ctx.wf.services.call({ caller: "emperor", target: "post:xingbu.langzhong", service: "verify", input: "查" });
    expect(direct.routed_to).toBe("xingbu.langzhong");
  });

  it("超时作废并知会请求者", () => {
    const ctx = createFakeCtx();
    const r = ctx.wf.services.call({ caller: "post:gongbu.langzhong", target: "dept:bingbu", service: "run", input: "ls" });
    ctx.advance(1800 * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.wf.services.getServiceRequestOrNull(r.id)?.state).toBe("expired");
    expect(ctx.inboxOf("gongbu.langzhong").at(-1)?.subject).toMatch(/服务超时/);
  });
});

describe("看门狗", () => {
  it("租约过期改派、忙碌者续租、SLA 逐级上报不重复", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "催办", intent: "x", actor: "emperor" });
    ctx.advance(SLA.lease * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    let ed = ctx.wf.edicts.getEdictOrNull(e.id)!;
    expect(ed.drafter_post).toBe("zhongshu.sheren_b");
    expect(ctx.inboxOf("zhongshu.sheren_b").at(-1)?.subject).toMatch(/改派/);

    ctx.statusList = [{ post_id: "zhongshu.sheren_b", dept: "zhongshu", state: "thinking", current_trace_id: e.id, last_progress_at: 0, turns_last_hour: 0, tokens_today: 0, updated_at: 0 }];
    ctx.advance(SLA.lease * 1000 + 1000); // 已超 drafting SLA（20 分钟）
    ctx.wf.watchdogTick(ctx.now());
    ed = ctx.wf.edicts.getEdictOrNull(e.id)!;
    expect(ed.drafter_post).toBe("zhongshu.sheren_b");
    const urged = ctx.inboxOf("zhongshu.sheren_b").filter((m) => m.subject.startsWith("【催办】"));
    expect(urged).toHaveLength(1);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.inboxOf("zhongshu.sheren_b").filter((m) => m.subject.startsWith("【催办】"))).toHaveLength(1);

    ctx.advance(SLA.edict_drafting * 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.inboxOf(ZS_HEAD).some((m) => m.subject.startsWith("【督办】"))).toBe(true);
    ctx.advance(SLA.edict_drafting * 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.inboxOf(CHAIR).some((m) => m.subject.startsWith("【上报】"))).toBe(true);
    ctx.advance(SLA.edict_drafting * 1000);
    ctx.wf.watchdogTick(ctx.now());
    const esc = ctx.notificationsList("escalation", "pending");
    expect(esc).toHaveLength(1);
    ctx.notifications.resolve(esc[0].id, "urge", "速办");
    expect(ctx.inboxOf("zhongshu.sheren_b").at(-1)).toMatchObject({ priority: "urgent", from: "emperor" });
  });

  it("复奏逾 24 小时自动结案；未开工任务租约过期部门内改派", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "自动结案", intent: "x", actor: "emperor" });
    ctx.wf.emperorEdictAction(e.id, "force_approve", "");
    const det = ctx.wf.edicts.dispatch(e.id, { tasks: [{ dept: "bingbu", title: "t", instructions: "i", acceptance: "a" }] }, A(DISPATCHER));
    const t = det.tasks[0];
    expect(t.assignee_post).toBe("bingbu.shangshu");
    ctx.advance(SLA.lease * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.wf.getTask(t.id)?.assignee_post).toBe("bingbu.shilang");

    ctx.wf.tasks.taskAction(t.id, { action: "cancel", post: DISPATCHER, reason: "不必" }, A(DISPATCHER));
    ctx.wf.edicts.report(e.id, { summary: "取消" }, A(DISPATCHER));
    ctx.advance(24 * 3600_000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.wf.getEdict(e.id)?.state).toBe("completed");
    expect(ctx.notificationsList("report", "pending")).toHaveLength(0);
  });
});

describe("24/7 鲁棒性（复审修复）", () => {
  it("中书侍郎缺位：提交即免复署送门下；待复署期间缺位由看门狗送门下；响应带 note", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "缺位", intent: "x", actor: "emperor" });
    const det = ctx.wf.edicts.submitDraft(e.id, draft(), A(DRAFTER));
    expect(det.edict.awaiting_countersign).toBe(true);
    expect(det.note).toMatch(/已自动通知中书侍郎 zhongshu.shilang ?复署/);
    ctx.vacant.add(ZS_HEAD);
    ctx.advance(SLA.lease * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.wf.getEdict(e.id)).toMatchObject({ state: "reviewing", awaiting_countersign: false, reviewer_post: REVIEWER });

    const e2 = ctx.wf.issueEdict({ title: "缺位二", intent: "x", actor: "emperor" });
    const d2 = ctx.wf.edicts.submitDraft(e2.id, draft(), A(ctx.wf.getEdict(e2.id)!.drafter_post!));
    expect(d2.edict.state).toBe("reviewing");
    expect(d2.note).toMatch(/已自动送门下/);
  });

  it("任务终结级联取消全部子孙任务（含孙任务）", () => {
    const ctx = createFakeCtx();
    const head = A("gongbu.shangshu");
    const root = ctx.wf.tasks.createTask({ creator: A(DISPATCHER), dept: "gongbu", title: "总", instructions: "总", acceptance: "成" });
    const child = ctx.wf.tasks.createTask({ creator: head, dept: "gongbu", parent_id: root.id, assignee_post: "gongbu.langzhong", title: "子", instructions: "子", acceptance: "成" });
    const grand = ctx.wf.tasks.createTask({ creator: A("gongbu.langzhong"), dept: "xingbu", parent_id: child.id, title: "孙", instructions: "孙", acceptance: "成" });
    ctx.wf.tasks.taskAction(root.id, { action: "cancel", post: DISPATCHER, reason: "不必" }, A(DISPATCHER));
    expect(ctx.wf.getTask(child.id)?.state).toBe("cancelled");
    expect(ctx.wf.getTask(grand.id)?.state).toBe("cancelled");

    // 父任务办结时仍未结的子任务也随之取消（否则看门狗会一路督办到陛下）
    const r2 = ctx.wf.tasks.createTask({ creator: A(DISPATCHER), dept: "gongbu", title: "总2", instructions: "总", acceptance: "成", verify_by: "self" });
    const c2 = ctx.wf.tasks.createTask({ creator: head, dept: "gongbu", parent_id: r2.id, assignee_post: "gongbu.shilang", title: "子2", instructions: "子", acceptance: "成" });
    ctx.wf.tasks.taskAction(r2.id, { action: "submit", post: "gongbu.shangshu", result: "总任务已办结" }, head);
    expect(ctx.wf.getTask(c2.id)?.state).toBe("cancelled");
    expect(ctx.briefing.pendingItems("gongbu.shilang")).toEqual([]);
  });

  it("核验人缺位：提交时跳过缺位者；待核验中缺位由看门狗改派", () => {
    const ctx = createFakeCtx();
    const t = ctx.wf.tasks.createTask({ creator: A(DISPATCHER), dept: "gongbu", assignee_post: undefined, title: "修", instructions: "修", acceptance: "成" });
    const assignee = t.assignee_post!;
    let d = ctx.wf.tasks.taskAction(t.id, { action: "submit", post: assignee, result: "已修好东门" }, A(assignee));
    expect(d.task.verifier_post).toBe(DISPATCHER);
    expect((d as { note?: string }).note).toMatch(/已自动通知核验人 shangshu.youpuye/);
    ctx.vacant.add(DISPATCHER);
    ctx.advance(SLA.lease * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    d = ctx.wf.tasks.getTaskDetail(t.id);
    expect(d.task.verifier_post).not.toBe(DISPATCHER);
    const v = d.task.verifier_post!;
    expect(ctx.registry.hasTool(v, "task_verify")).toBe(true);
    expect(ctx.briefing.pendingItems(v)).toContainEqual({ type: "task_verify", task_id: t.id, title: "修" });

    const t2 = ctx.wf.tasks.createTask({ creator: A(DISPATCHER), dept: "gongbu", title: "修2", instructions: "修", acceptance: "成" });
    const d2 = ctx.wf.tasks.taskAction(t2.id, { action: "submit", post: t2.assignee_post!, result: "已修好西门" }, A(t2.assignee_post!));
    expect(d2.task.verifier_post).not.toBe(DISPATCHER);
  });

  it("停机恢复后超期事项逐级上报（每周期升一级），不一次跳到陛下；阶段变化后旧上报作废", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "停机", intent: "x", actor: "emperor" });
    ctx.advance(6 * 3600_000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.notificationsList("escalation")).toHaveLength(0);
    const drafter = ctx.wf.getEdict(e.id)!.drafter_post!;
    expect(ctx.inboxOf(drafter).filter((m) => m.subject.startsWith("【催办】"))).toHaveLength(1);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.inboxOf(ZS_HEAD).some((m) => m.subject.startsWith("【督办】"))).toBe(false);
    for (let i = 0; i < 3; i++) {
      ctx.advance(SLA.edict_drafting * 1000);
      ctx.wf.watchdogTick(ctx.now());
    }
    expect(ctx.notificationsList("escalation", "pending")).toHaveLength(1);
    // 起草人终于提交 → 超期上报作废
    ctx.wf.edicts.submitDraft(e.id, draft(), A(ctx.wf.getEdict(e.id)!.drafter_post!));
    ctx.wf.edicts.countersign(e.id, { approve: true, comment: "" }, A(ZS_HEAD));
    expect(ctx.notificationsList("escalation", "pending")).toHaveLength(0);
  });

  it("议事：缺位宰相不入发言序；主持逾时先提醒、再由系统代奏；续议作废旧议决", () => {
    const ctx = createFakeCtx();
    ctx.vacant.add("zhengshitang.tongsanpin");
    const d = ctx.wf.emperorSpeaks("议一事");
    expect(d.speaker_queue).toEqual(MEMBERS.filter((m) => m !== "zhengshitang.tongsanpin"));
    for (const p of d.speaker_queue) ctx.wf.council.speak(d.id, p, "support", "可");
    const before = ctx.inboxOf(CHAIR).length;
    ctx.advance(SLA.council_turn * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.inboxOf(CHAIR).length).toBe(before + 1);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.wf.council.detail(d.id).deliberation.state).toBe("open");
    ctx.advance(SLA.council_turn * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    expect(ctx.wf.council.detail(d.id).deliberation.state).toBe("concluded");
    const n = ctx.notificationsList("council_conclusion", "pending")[0];
    expect(n.options.map((o) => o.id)).toEqual(["reconvene", "shelve"]);

    // 陛下另行续议 → 旧议决待办作废
    ctx.wf.emperorSpeaks("再议", d.id);
    expect(ctx.notificationsList("council_conclusion", "pending")).toHaveLength(0);

    // 主持人缺位 → 改由其他宰相主持
    ctx.vacant.add(CHAIR);
    for (const p of ctx.wf.council.detail(d.id).deliberation.speaker_queue) ctx.wf.council.speak(d.id, p, "support", "可");
    ctx.advance(SLA.council_turn * 1000 + 1000);
    ctx.wf.watchdogTick(ctx.now());
    const cur = ctx.wf.council.detail(d.id).deliberation;
    expect(cur.chair_post).not.toBe(CHAIR);
    expect(ctx.briefing.pendingItems(cur.chair_post)).toContainEqual(expect.objectContaining({ type: "council_chair", deliberation_id: d.id }));
  });

  it("发回重办给分派人 edict_dispatch 职事；执行中分派人缺位改派他人督办复奏", () => {
    const ctx = createFakeCtx();
    const e = ctx.wf.issueEdict({ title: "重办", intent: "x", actor: "emperor" });
    ctx.wf.emperorEdictAction(e.id, "force_approve", "");
    const det = ctx.wf.edicts.dispatch(e.id, { tasks: [{ dept: "gongbu", title: "t", instructions: "i", acceptance: "a", verify_by: "self" }] }, A(DISPATCHER));
    expect(det.note).toMatch(/gongbu→gongbu.shangshu/);
    ctx.wf.tasks.taskAction(det.tasks[0].id, { action: "submit", post: "gongbu.shangshu", result: "做完了，详见资产" }, A("gongbu.shangshu"));
    ctx.wf.edicts.report(e.id, { summary: "完" }, A(DISPATCHER));
    ctx.notifications.resolve(ctx.notificationsList("report")[0].id, "reopen", "再加一件");
    expect(ctx.briefing.pendingItems(DISPATCHER).map((i) => i.type)).toEqual(["edict_dispatch"]);
    ctx.wf.edicts.dispatch(e.id, { tasks: [{ dept: "gongbu", title: "t2", instructions: "i", acceptance: "a", verify_by: "self" }] }, A(DISPATCHER));
    expect(ctx.briefing.pendingItems(DISPATCHER).map((i) => i.type)).toEqual([]);

    ctx.vacant.add(DISPATCHER);
    ctx.wf.watchdogTick(ctx.now());
    const ed = ctx.wf.getEdict(e.id)!;
    expect(ed.dispatcher_post).not.toBe(DISPATCHER);
    const t2 = ctx.wf.edicts.detail(e.id).tasks.find((t) => t.title === "t2")!;
    ctx.wf.tasks.taskAction(t2.id, { action: "submit", post: t2.assignee_post!, result: "又做完了一件" }, A(t2.assignee_post!));
    expect(ctx.briefing.pendingItems(ed.dispatcher_post!)).toContainEqual(expect.objectContaining({ type: "edict_report", edict_id: e.id }));
  });

  it("提交附件资产自动分享给核验人/创建者/分派人；非本人资产与不存在的跳过并告警", () => {
    const ctx = createFakeCtx();
    ctx.assets = createAssets(ctx);
    const put = (id: string, owner: string, official?: string) =>
      ctx.db.run(
        "INSERT INTO assets (id, owner, owner_official, path, visibility, updated_at, data_json) VALUES (?, ?, ?, ?, 'private', 0, ?)",
        id,
        owner,
        official ?? null,
        `${id}.md`,
        JSON.stringify({ id, owner, owner_official: official, path: `${id}.md`, visibility: "private", shared_with: [], mime: "text/markdown", size: 1, sha256: "x", latest_version: 1, created_at: 0, updated_at: 0 }),
      );
    put("as_mine", "post:gongbu.langzhong", "of_gongbu.langzhong");
    put("as_dept", "dept:gongbu");
    put("as_other", "post:bingbu.shangshu", "of_bingbu.shangshu");
    const e = ctx.wf.issueEdict({ title: "附件", intent: "x", actor: "emperor" });
    ctx.wf.emperorEdictAction(e.id, "force_approve", "");
    const t = ctx.wf.edicts.dispatch(e.id, { tasks: [{ dept: "gongbu", title: "修", instructions: "i", acceptance: "a" }] }, A(DISPATCHER)).tasks[0];
    ctx.wf.tasks.taskAction(t.id, { action: "assign", post: "gongbu.shangshu", assignee_post: "gongbu.langzhong" }, A("gongbu.shangshu"));
    const d = ctx.wf.tasks.taskAction(
      t.id,
      { action: "submit", post: "gongbu.langzhong", result: "已修好，见附件", asset_ids: ["as_mine", "as_dept", "as_other", "as_none"] },
      A("gongbu.langzhong"),
    ) as ReturnType<typeof ctx.wf.tasks.taskAction> & { note?: string; warnings?: string[] };
    expect(d.task.result_assets).toEqual(["as_mine", "as_dept"]);
    expect(d.warnings).toHaveLength(2);
    expect(d.note).toMatch(/附件 as_mine、as_dept 已自动分享/);
    const assets = ctx.assets as ReturnType<typeof createAssets>;
    for (const id of ["as_mine", "as_dept"]) {
      const a = assets.get(id)!;
      expect(a.shared_with).toContain(`post:${DISPATCHER}`);
      expect(assets.canRead(a, `post:${DISPATCHER}`)).toBe(true);
    }
    expect(assets.get("as_other")!.shared_with).toEqual([]);
  });
});
