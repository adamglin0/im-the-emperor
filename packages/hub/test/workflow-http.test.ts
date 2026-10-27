// B 组路由经 HTTP（真实 hub：鉴权、工具 ACL、幂等、错误映射）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubmitDraftReq } from "@court/shared";
import { expectStatus, startHub, type TestHub } from "./helpers.ts";

let hub: TestHub;
beforeAll(async () => {
  hub = await startHub();
});
afterAll(async () => {
  await hub?.dispose();
});

const CHAIR = "zhengshitang.zhongshuling";
const DRAFTER = "zhongshu.sheren_a";
const REVIEWER = "menxia.jishizhong_a";
const DISPATCHER = "shangshu.youpuye";

function draftReq(extra: Partial<SubmitDraftReq> = {}): SubmitDraftReq {
  return {
    post: DRAFTER,
    title: "修东门",
    objective: "修好东门",
    constraints: "不扰民",
    acceptance: "城门可开合",
    deadline_text: "三日",
    suggested_depts: ["gongbu"],
    text: "诏曰：修东门。",
    ...extra,
  };
}

describe("B 组 HTTP 接口", () => {
  it("议事：皇帝开议、按序发言、工具 ACL", async () => {
    const det = await hub.emperor.emperorCouncil({ content: "议修东门" });
    const id = det.deliberation.id;
    expect(det.entries[0]).toMatchObject({ author: "emperor", content: "议修东门" });
    await expectStatus(hub.as("zhengshitang.shizhong").councilSpeak(id, { post: "zhengshitang.shizhong", stance: "support", content: "可" }), 409);
    const e = await expectStatus(hub.as("bingbu.shangshu").councilSpeak(id, { post: "bingbu.shangshu", stance: "support", content: "可" }), 403);
    expect(e.message).toMatch(/没有 council_speak 的权限/);
    await expectStatus(hub.as(CHAIR).councilSpeak(id, { post: CHAIR, stance: "maybe" as never, content: "可" }), 400);
    const after = await hub.as(CHAIR).councilSpeak(id, { post: CHAIR, stance: "support", content: "臣以为可" });
    expect(after.deliberation.current_speaker).toBe("zhengshitang.shizhong");
    expect((await hub.emperor.deliberations("open")).some((d) => d.id === id)).toBe(true);
  });

  it("诏令：颁旨→起草（幂等）→复署→封驳→重拟→准→分派→办结→复奏→御览；追踪图", async () => {
    const edict = await hub.emperor.emperorEdict({ title: "修东门", intent: "三日内修好东门" });
    expect(edict).toMatchObject({ state: "drafting", drafter_post: DRAFTER });
    const drafter = hub.as(DRAFTER);

    const b = await drafter.briefing(DRAFTER, 0, "doorbell");
    expect(b.items).toContainEqual({ type: "edict_draft", edict_id: edict.id, title: "修东门", draft_no_next: 1, rejected: false, open_issue_ids: [] });
    await expectStatus(hub.as("menxia.shilang").briefing(DRAFTER, 0, "x"), 403);

    const first = await drafter.submitDraft(edict.id, draftReq({ idem_key: "k-draft-1", parent_span_id: "sp_turn_drafter" }));
    // 草稿 span 记下产生它的轮次（Web 据此把轮次归到草稿节点）
    expect((await hub.emperor.trace(edict.id)).spans.find((s) => s.kind === "draft")?.attrs?.by_span).toBe("sp_turn_drafter");
    const again = await drafter.submitDraft(edict.id, draftReq({ idem_key: "k-draft-1" }));
    expect(again.drafts).toHaveLength(1);
    expect(again.edict.version).toBe(first.edict.version);
    expect((first as typeof first & { note?: string }).note).toMatch(/已自动通知中书侍郎/);
    await expectStatus(drafter.submitDraft(edict.id, draftReq({ title: "" })), 400);

    await hub.as("zhongshu.shilang").countersign(edict.id, { post: "zhongshu.shilang", approve: true, comment: "" });
    const rej = await hub.as(REVIEWER).review(edict.id, {
      post: REVIEWER,
      parent_span_id: "sp_turn_reviewer",
      decision: "reject",
      issues: [{ severity: "blocking", clause: "验收", reason: "缺验收标准", required_change: "写明验收" }],
      opinion: "缺验收",
    });
    const issueId = rej.reviews[0].issues[0].id;
    expect((await hub.emperor.trace(edict.id)).spans.find((s) => s.kind === "review")?.attrs?.by_span).toBe("sp_turn_reviewer");
    const miss = await expectStatus(drafter.submitDraft(edict.id, draftReq()), 400);
    expect(miss.message).toContain(issueId);
    await drafter.submitDraft(edict.id, draftReq({ responses: [{ issue_id: issueId, response: "已补" }] }));
    await hub.as("zhongshu.shilang").countersign(edict.id, { post: "zhongshu.shilang", approve: true, comment: "" });
    const ok = await hub.as(REVIEWER).review(edict.id, { post: REVIEWER, decision: "approve", issues: [], opinion: "准" });
    expect(ok.edict).toMatchObject({ state: "approved", dispatcher_post: DISPATCHER });
    expect((ok as typeof ok & { note?: string }).note).toMatch(/已自动交尚书省/);

    await expectStatus(hub.as("gongbu.shangshu").dispatch(edict.id, { post: "gongbu.shangshu", tasks: [] }), 403);
    await expectStatus(hub.as(DISPATCHER).dispatch(edict.id, { post: DISPATCHER, tasks: [{ dept: "nowhere" as never, title: "t", instructions: "i", acceptance: "a" }] }), 400);
    const disp = await hub.as(DISPATCHER).dispatch(edict.id, { post: DISPATCHER, tasks: [{ dept: "gongbu", title: "修门", instructions: "修", acceptance: "可开合" }] });
    const task = disp.tasks[0];
    const head = hub.as("gongbu.shangshu");
    await head.taskAction(task.id, { post: "gongbu.shangshu", action: "start" });
    await head.taskAction(task.id, { post: "gongbu.shangshu", action: "submit", result: "东门修好，验收合格" });
    await expectStatus(hub.as("gongbu.langzhong").taskAction(task.id, { post: "gongbu.langzhong", action: "verify", pass: true, comment: "" }), 403);
    await hub.as(DISPATCHER).taskAction(task.id, { post: DISPATCHER, action: "verify", pass: true, comment: "合格" });
    const rep = await hub.as(DISPATCHER).report(edict.id, { post: DISPATCHER, summary: "东门已修" });
    expect(rep.edict.state).toBe("reported");

    const pending = (await hub.emperor.notifications({ status: "pending" })).find((n) => n.category === "report" && n.related?.id === edict.id)!;
    await hub.emperor.resolveNotification(pending.id, { option: "accept", comment: "善" });
    expect((await hub.emperor.edict(edict.id)).edict.state).toBe("completed");

    const g = await hub.emperor.trace(edict.id);
    expect(g.root).toMatchObject({ kind: "edict", status: "ok" });
    expect(g.spans.some((s) => s.kind === "task")).toBe(true);
    expect(g.events.length).toBeGreaterThan(5);
    expect((await hub.emperor.traces()).some((t) => t.trace_id === edict.id)).toBe(true);

    await expectStatus(hub.as(DRAFTER).emperorEdictAction(edict.id, { action: "withdraw" }), 403);
    await expectStatus(hub.emperor.emperorEdictAction(edict.id, { action: "withdraw" }), 409);
  });

  it("服务调用与科举题目保密", async () => {
    const r = await hub.as("gongbu.langzhong").callService({ caller: "post:gongbu.langzhong", target: "dept:libu_rites", service: "polish", input: "文稿" });
    await expectStatus(hub.as("gongbu.langzhong").serviceResult(r.id, { post: "gongbu.langzhong", ok: true, output: "x" }), 403);
    const done = await hub.as(r.routed_to!).serviceResult(r.id, { post: r.routed_to!, ok: true, output: "润色稿" });
    expect(done.state).toBe("done");
    await expectStatus(hub.as("gongbu.langzhong").callService({ caller: "post:gongbu.langzhong", target: "dept:libu_rites", service: "fly", input: null }), 404);

    const secret = await hub.as("gongbu.langzhong").examQuestions();
    expect(secret.length).toBeGreaterThanOrEqual(24);
    expect(secret.every((q) => q.prompt === "（考题保密）" && q.expected === undefined)).toBe(true);
    const full = await hub.as("libu.kaogong_yuanwailang").examQuestions({ dimension: "code" });
    expect(full.every((q) => q.dimension === "code" && q.prompt !== "（考题保密）")).toBe(true);
    await expectStatus(hub.as("gongbu.langzhong").startExam({ model_key: "opencode-go/kimi-k3", actor: "post:gongbu.langzhong" }), 403);
  });
});
