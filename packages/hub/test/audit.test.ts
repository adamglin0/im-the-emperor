// 稽查规则、弹劾与奏报。
import { describe, expect, it } from "vitest";
import { SLA } from "@court/shared";
import { createFakeCtx } from "./fakes-b.ts";

const BAD = "post:bingbu.zhifang_langzhong";

describe("稽查规则", () => {
  it("八条规则各自命中、批量知会巡察御史、去重不重复", () => {
    const ctx = createFakeCtx();
    // 超期：任务已指派逾 SLA 两倍
    const late = ctx.wf.tasks.createTask({ creator: { addr: "post:shangshu.youpuye", post: "shangshu.youpuye" }, dept: "gongbu", title: "迟办", instructions: "x", acceptance: "y" });
    ctx.advance(SLA.task_assigned * 2000 + 60_000);
    // 宣称完成无产物
    const empty = ctx.wf.tasks.createTask({ creator: { addr: "post:gongbu.shangshu", post: "gongbu.shangshu" }, dept: "gongbu", assignee_post: "gongbu.langzhong", title: "空", instructions: "x", acceptance: "y", verify_by: "self" });
    ctx.wf.tasks.taskAction(empty.id, { action: "submit", post: "gongbu.langzhong", result: "完成" }, { addr: "post:gongbu.langzhong", post: "gongbu.langzhong" });
    // 循环对话
    for (let i = 0; i < 8; i++) {
      ctx.messages.send({ from: i % 2 ? "post:libu.shangshu" : "post:hubu.shangshu", to: i % 2 ? "post:hubu.shangshu" : "post:libu.shangshu", kind: "chat", subject: "议", body: `第${i}句`, thread_id: "th_loop" });
    }
    // 事件类
    for (let i = 0; i < 10; i++) ctx.events.emit({ type: "turn.end", actor: "post:libu_rites.langzhong", summary: "空轮", data: { tool_calls: 1, tools: ["end_turn"] } });
    for (let i = 0; i < 12; i++) ctx.events.emit({ type: "turn.end", actor: "post:libu_rites.shilang", summary: "实干", data: { tool_calls: 2, tools: ["task_submit", "end_turn"] } });
    for (let i = 0; i < 5; i++) ctx.events.emit({ type: "tool.error", actor: BAD, summary: "报错" });
    ctx.events.emit({ type: "acl.denied", actor: BAD, summary: "越权" });
    ctx.events.emit({ type: "tool.injection_suspect", actor: BAD, summary: "注入" });
    // 预算燃烧
    ctx.db.run("INSERT INTO budgets (scope, data_json) VALUES ('post:hubu.zhushi', ?)", JSON.stringify({ scope: "post:hubu.zhushi", daily_tokens: 1000, updated_by: "emperor", updated_at: 0 }));
    ctx.db.run(
      "INSERT INTO ledger (id, idem_key, ts, post_id, official_id, dept, trace_id, purpose, provider, model, total_tokens, cost, data_json) VALUES ('l1','k1',?, 'hubu.zhushi','of','hubu',NULL,'turn','p','m',300,0,'{}')",
      ctx.now(),
    );

    const found = ctx.au.runRules(ctx.now());
    const rules = new Set(found.map((f) => f.rule));
    for (const r of ["loop_chat", "idle_spin", "overdue", "tool_errors", "claimed_no_output", "privilege_attempt", "budget_burn", "injection_suspect"]) expect(rules, r).toContain(r);
    expect(found.find((f) => f.rule === "overdue")?.evidence.task_id).toBe(late.id);
    expect(found.find((f) => f.rule === "claimed_no_output")?.subject).toBe("post:gongbu.langzhong");
    expect(found.filter((f) => f.rule === "idle_spin").map((f) => f.subject)).toEqual(["post:libu_rites.langzhong"]);

    const patrol = ctx.inboxOf("yushitai.jiancha").filter((m) => m.kind === "audit");
    expect(patrol).toHaveLength(1);
    expect(patrol[0].body).toContain(found[0].id);
    expect(ctx.briefing.pendingItems("yushitai.jiancha").filter((i) => i.type === "audit_finding")).toHaveLength(3);
    expect(ctx.briefing.pendingItems("yushitai.shiyushi")).toEqual([]);

    expect(ctx.au.runRules(ctx.now())).toEqual([]);
    expect(ctx.inboxOf("yushitai.jiancha").filter((m) => m.kind === "audit")).toHaveLength(1);
  });
});

describe("弹劾与奏报", () => {
  it("弹劾 → 皇帝交吏部 → 吏部与被劾者收到通知；发现标记 impeached", () => {
    const ctx = createFakeCtx();
    for (let i = 0; i < 5; i++) ctx.events.emit({ type: "tool.error", actor: BAD, summary: "报错" });
    const [f] = ctx.au.runRules(ctx.now());
    expect(() => ctx.au.impeach({ post: "bingbu.zhifang_langzhong", target: BAD, charges: "x", evidence: "y", finding_ids: [] })).toThrow(/不能弹劾自己/);
    expect(() => ctx.au.impeach({ post: "yushitai.shiyushi", target: BAD, charges: "x", evidence: "y", finding_ids: ["af_nope"] })).toThrow(/不存在/);
    const im = ctx.au.impeach({ post: "yushitai.shiyushi", target: BAD, charges: "屡屡报错", evidence: "五次 tool.error", finding_ids: [f.id] });
    expect(ctx.au.listFindings({ status: "impeached" }).map((x) => x.id)).toEqual([f.id]);
    const n = ctx.notifications.get(im.notification_id)!;
    expect(n.options.map((o) => o.id)).toEqual(["reject", "to_libu", "to_hubu", "to_xingbu"]);
    ctx.notifications.resolve(n.id, "to_libu", "整改提示词");
    expect(ctx.au.listImpeachments()[0].status).toBe("to_libu");
    expect(ctx.inboxOf("libu.shangshu").at(-1)).toMatchObject({ kind: "audit" });
    expect(ctx.inboxOf("bingbu.zhifang_langzhong").at(-1)?.subject).toMatch(/弹劾案处置结果/);

    const upd = ctx.au.updateFinding(f.id, "post:yushitai.shiyushi", "reviewed", "已核实");
    expect(upd.evidence.review_notes).toHaveLength(1);
    const rep = ctx.au.report({ post: "yushitai.dafu", title: "监察日报", body: "今日无大事" });
    expect(rep).toMatchObject({ kind: "fyi", category: "audit_report", from: "post:yushitai.dafu" });
  });
});
