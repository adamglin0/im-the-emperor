// 诏令：列表、详情、拟旨奏请、起草、复署、审核、谏诤、分派、复奏、请旨。
import type { Hono } from "hono";
import { REJECT_REASONS, type DeptId, type DispatchTaskSpec, type ReviewIssue } from "@court/shared";
import { bad, type HubCtx } from "../ctx.ts";
import { workflowOf } from "../services/workflow.ts";
import { optNum, optStr, reqArr, reqBool, reqEnum, reqStr } from "../services/flow-util.ts";
import { flowActor, queryInt, readJson, requireTool, withIdem } from "./flow-http.ts";

const VERIFY_BY = ["self", "superior", "xingbu"] as const;
const MAX_DISPATCH_TASKS = 20;

export function register(app: Hono, ctx: HubCtx): void {
  const wf = () => workflowOf(ctx);
  const deptIds = () => ctx.registry.depts().map((d) => d.id);
  const expectedVersion = (v: unknown) => (typeof v === "number" ? v : undefined);

  function deptOf(v: unknown, label: string): DeptId {
    return reqEnum(v, deptIds(), label) as DeptId;
  }

  app.get("/api/edicts", (c) => {
    const state = c.req.query("state") || undefined;
    return c.json(wf().edicts.listEdicts(state, queryInt(c, "limit", 50, 1, 500)));
  });

  app.get("/api/edicts/:id", (c) => c.json(wf().edicts.detail(c.req.param("id"))));

  app.post("/api/edicts/propose", async (c) => {
    requireTool(c, "propose_edict");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const input = {
      title: reqStr(b.title, "title（旨意标题）", 200),
      intent: reqStr(b.intent, "intent（旨意内容）", 8000),
      rationale: reqStr(b.rationale, "rationale（理由）", 8000),
      deliberation_id: optStr(b.deliberation_id, "deliberation_id", 100),
    };
    return c.json(withIdem(ctx, "propose_edict", b.idem_key, () => wf().edicts.proposeEdict(input, actor)));
  });

  app.post("/api/edicts/:id/draft", async (c) => {
    requireTool(c, "edict_submit_draft");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const depts = reqArr(b.suggested_depts ?? [], "suggested_depts（建议承办部门）", 0, 11).map((d, i) => deptOf(d, `suggested_depts[${i}]`));
    const responses = reqArr(b.responses ?? [], "responses（对封驳的逐条回应）", 0, 50).map((r, i) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return { issue_id: reqStr(o.issue_id, `responses[${i}].issue_id`, 100), response: reqStr(o.response, `responses[${i}].response`, 4000) };
    });
    const input = {
      title: reqStr(b.title, "title（诏书标题）", 200),
      objective: reqStr(b.objective, "objective（目标）", 8000),
      constraints: optStr(b.constraints, "constraints（约束）", 8000) ?? "无",
      acceptance: reqStr(b.acceptance, "acceptance（验收标准）", 8000),
      deadline_text: optStr(b.deadline_text, "deadline_text（期限）", 200) ?? "未定",
      budget_tokens: optNum(b.budget_tokens, "budget_tokens（预算上限）", 0, 1e9),
      suggested_depts: depts,
      text: reqStr(b.text, "text（诏书正文）", 20_000),
      responses,
      expected_version: expectedVersion(b.expected_version),
    };
    return c.json(withIdem(ctx, "edict_draft", b.idem_key, () => wf().edicts.submitDraft(c.req.param("id"), input, actor)));
  });

  app.post("/api/edicts/:id/countersign", async (c) => {
    requireTool(c, "edict_countersign");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const input = { approve: reqBool(b.approve, "approve（是否复署）"), comment: optStr(b.comment, "comment", 4000) ?? "" };
    return c.json(withIdem(ctx, "edict_countersign", b.idem_key, () => wf().edicts.countersign(c.req.param("id"), input, actor)));
  });

  app.post("/api/edicts/:id/review", async (c) => {
    requireTool(c, "edict_review");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const decision = reqEnum(b.decision, ["approve", "reject"] as const, "decision（结论）");
    const issues: Omit<ReviewIssue, "id">[] = reqArr(b.issues ?? [], "issues（问题清单）", 0, 30).map((x, i) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        severity: reqEnum(o.severity, ["blocking", "advisory"] as const, `issues[${i}].severity`),
        clause: reqStr(o.clause, `issues[${i}].clause（所涉条款）`, 1000),
        reason: reqEnum(o.reason, REJECT_REASONS, `issues[${i}].reason（理由）`),
        required_change: reqStr(o.required_change, `issues[${i}].required_change（须如何修改）`, 2000),
      };
    });
    const input = { decision, issues, opinion: reqStr(b.opinion, "opinion（审核意见）", 8000), expected_version: expectedVersion(b.expected_version) };
    return c.json(withIdem(ctx, "edict_review", b.idem_key, () => wf().edicts.review(c.req.param("id"), input, actor)));
  });

  app.post("/api/edicts/:id/remonstrate", async (c) => {
    requireTool(c, "edict_remonstrate");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const input = { risk: reqStr(b.risk, "risk（风险）", 8000), alternative: reqStr(b.alternative, "alternative（替代方案）", 8000) };
    return c.json(withIdem(ctx, "edict_remonstrate", b.idem_key, () => wf().edicts.remonstrate(c.req.param("id"), input, actor)));
  });

  app.post("/api/edicts/:id/dispatch", async (c) => {
    requireTool(c, "edict_dispatch");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const tasks: DispatchTaskSpec[] = reqArr(b.tasks, "tasks（任务清单）", 1, MAX_DISPATCH_TASKS).map((x, i) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        dept: deptOf(o.dept, `tasks[${i}].dept（承办部门）`),
        title: reqStr(o.title, `tasks[${i}].title`, 200),
        instructions: reqStr(o.instructions, `tasks[${i}].instructions（要求）`, 8000),
        acceptance: reqStr(o.acceptance, `tasks[${i}].acceptance（验收标准）`, 4000),
        deadline_minutes: optNum(o.deadline_minutes, `tasks[${i}].deadline_minutes`, 1, 60 * 24 * 30),
        verify_by: o.verify_by === undefined || o.verify_by === null ? undefined : reqEnum(o.verify_by, VERIFY_BY, `tasks[${i}].verify_by`),
      };
    });
    const input = { tasks, note: optStr(b.note, "note", 4000), expected_version: expectedVersion(b.expected_version) };
    return c.json(withIdem(ctx, "edict_dispatch", b.idem_key, () => wf().edicts.dispatch(c.req.param("id"), input, actor)));
  });

  app.post("/api/edicts/:id/report", async (c) => {
    requireTool(c, "edict_report");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const input = { summary: reqStr(b.summary, "summary（复奏汇总）", 12_000), failures: optStr(b.failures, "failures（失败与遗留）", 8000) };
    return c.json(withIdem(ctx, "edict_report", b.idem_key, () => wf().edicts.report(c.req.param("id"), input, actor)));
  });

  app.post("/api/edicts/:id/clarify", async (c) => {
    requireTool(c, "edict_request_clarification");
    const b = await readJson(c);
    const actor = flowActor(c, b.post, b.parent_span_id);
    const question = reqStr(b.question, "question（请旨问题）", 4000);
    if (actor.addr === "emperor") throw bad("陛下无须向自己请旨");
    return c.json(withIdem(ctx, "edict_clarify", b.idem_key, () => wf().edicts.clarify(c.req.param("id"), question, actor)));
  });
}
