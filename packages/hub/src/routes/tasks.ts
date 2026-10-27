// 任务：列表、详情、新建（子任务）、状态动作。
import type { Hono } from "hono";
import type { DeptId, TaskActionReq, TaskListQuery, TaskState } from "@court/shared";
import { bad, type HubCtx } from "../ctx.ts";
import { workflowOf } from "../services/workflow.ts";
import { optNum, optStr, optStrArr, reqBool, reqEnum, reqNum, reqStr } from "../services/flow-util.ts";
import { flowActor, queryInt, readJson, requireTool, withIdem } from "./flow-http.ts";

const TASK_STATES: (TaskState | "open")[] = ["open", "pending", "assigned", "in_progress", "blocked", "submitted", "returned", "done", "cancelled", "failed"];
const VERIFY_BY = ["self", "superior", "xingbu"] as const;

/** 任务动作 → 所需工具（服务端 ACL） */
const ACTION_TOOL: Record<TaskActionReq["action"], string> = {
  start: "task_start",
  update: "task_update",
  submit: "task_submit",
  verify: "task_verify",
  block: "task_block",
  unblock: "task_block",
  comment: "task_comment",
  assign: "task_assign",
  reassign: "task_reassign",
  cancel: "task_cancel",
  fail: "task_update",
  extend: "task_extend_deadline",
};
const ACTIONS = Object.keys(ACTION_TOOL) as TaskActionReq["action"][];

function parseAction(b: Record<string, unknown>): TaskActionReq {
  const action = reqEnum(b.action, ACTIONS, "action（任务动作）");
  const meta = { post: typeof b.post === "string" ? b.post : "", expected_version: typeof b.expected_version === "number" ? b.expected_version : undefined };
  switch (action) {
    case "assign":
      return { ...meta, action, assignee_post: reqStr(b.assignee_post, "assignee_post（承办职位）", 100), note: optStr(b.note, "note", 4000) };
    case "start":
      return { ...meta, action };
    case "update":
      return { ...meta, action, progress: reqStr(b.progress, "progress（进展）", 8000) };
    case "submit":
      return { ...meta, action, result: reqStr(b.result, "result（办理结果）", 50_000), asset_ids: optStrArr(b.asset_ids, "asset_ids（产物资产 ID）", 50) };
    case "verify":
      return { ...meta, action, pass: reqBool(b.pass, "pass（是否通过）"), comment: optStr(b.comment, "comment（核验意见）", 8000) ?? "" };
    case "block":
      return { ...meta, action, reason: reqStr(b.reason, "reason（受阻原因）", 4000) };
    case "unblock":
      return { ...meta, action, note: optStr(b.note, "note", 4000) };
    case "comment":
      return { ...meta, action, content: reqStr(b.content, "content（批注）", 8000) };
    case "reassign":
      return { ...meta, action, assignee_post: reqStr(b.assignee_post, "assignee_post（新承办职位）", 100), reason: reqStr(b.reason, "reason（转派原因）", 4000) };
    case "cancel":
      return { ...meta, action, reason: reqStr(b.reason, "reason（取消原因）", 4000) };
    case "fail":
      return { ...meta, action, reason: reqStr(b.reason, "reason（失败原因）", 4000) };
    case "extend":
      return { ...meta, action, minutes: reqNum(b.minutes, "minutes（延期分钟数）", 1, 60 * 24 * 7), reason: reqStr(b.reason, "reason（延期理由）", 4000) };
  }
}

export function register(app: Hono, ctx: HubCtx): void {
  const wf = () => workflowOf(ctx);

  app.get("/api/tasks", (c) => {
    const state = c.req.query("state") || undefined;
    if (state && !TASK_STATES.includes(state as TaskState)) throw bad(`state 无效：${state}；可选：${TASK_STATES.join(" / ")}`);
    const q: TaskListQuery = {
      assignee: c.req.query("assignee") || undefined,
      dept: (c.req.query("dept") || undefined) as DeptId | undefined,
      state: state as TaskListQuery["state"],
      trace_id: c.req.query("trace_id") || undefined,
      edict_id: c.req.query("edict_id") || undefined,
      parent_id: c.req.query("parent_id") || undefined,
      limit: queryInt(c, "limit", 100, 1, 500),
    };
    return c.json(wf().tasks.listTasks(q));
  });

  app.get("/api/tasks/:id", (c) => c.json(wf().tasks.getTaskDetail(c.req.param("id"))));

  app.post("/api/tasks", async (c) => {
    requireTool(c, "task_create_subtask");
    const b = await readJson(c);
    const actor = flowActor(c, b.post);
    const deptIds = ctx.registry.depts().map((d) => d.id);
    const input = {
      creator: actor,
      dept: reqEnum(b.dept, deptIds, "dept（承办部门）") as DeptId,
      parent_id: optStr(b.parent_id, "parent_id", 100),
      assignee_post: optStr(b.assignee_post, "assignee_post", 100),
      title: reqStr(b.title, "title（任务标题）", 200),
      instructions: reqStr(b.instructions, "instructions（要求）", 8000),
      acceptance: reqStr(b.acceptance, "acceptance（验收标准）", 4000),
      deadline_minutes: optNum(b.deadline_minutes, "deadline_minutes", 1, 60 * 24 * 30),
      verify_by: b.verify_by === undefined || b.verify_by === null ? undefined : reqEnum(b.verify_by, VERIFY_BY, "verify_by（核验方式）"),
      trace_id: optStr(b.trace_id, "trace_id", 100),
      parent_span_id: optStr(b.parent_span_id, "parent_span_id", 100),
    };
    return c.json(withIdem(ctx, "task_create", b.idem_key, () => wf().tasks.createTask(input)));
  });

  app.post("/api/tasks/:id/action", async (c) => {
    const b = await readJson(c);
    const req = parseAction(b);
    requireTool(c, ACTION_TOOL[req.action]);
    const actor = flowActor(c, b.post);
    return c.json(withIdem(ctx, `task_${req.action}`, b.idem_key, () => wf().tasks.taskAction(c.req.param("id"), req, actor)));
  });
}
