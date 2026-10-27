// 通用·公文工具：诏令只读、任务（自己名下的）、追踪时间线
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS, type EdictDetail, type Task, type TaskActionReq, type TaskDetail, type TraceGraph } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { DEPT_IDS, ToolError, defineTool, fmtTime, focusEdict, focusTask, ok, rememberTrace, resolveAddress, snip, writeMeta, AUTO_NOTIFY_HINT } from "./_util.ts";

const EDICT_STATES = [
  "issued",
  "drafting",
  "reviewing",
  "remonstrated",
  "escalated",
  "approved",
  "awaiting_sign",
  "executing",
  "reported",
  "completed",
  "withdrawn",
  "failed",
  "blocked_budget",
] as const;
export const TASK_STATES = ["open", "pending", "assigned", "in_progress", "blocked", "submitted", "returned", "done", "cancelled", "failed"] as const;
export const VERIFY_BY = ["self", "superior", "xingbu"] as const;

export function taskRow(t: Task) {
  return {
    id: t.id,
    title: t.title,
    dept: t.dept,
    assignee: t.assignee_post,
    state: t.state,
    version: t.version,
    edict_id: t.edict_id,
    parent_id: t.parent_id,
    deadline: fmtTime(t.deadline),
    verify_by: t.verify_by,
    updated: fmtTime(t.updated_at),
  };
}

export function taskDetailView(d: TaskDetail) {
  const t = d.task;
  return {
    ...taskRow(t),
    trace_id: t.trace_id,
    creator: t.creator,
    instructions: snip(t.instructions, 1500),
    acceptance: snip(t.acceptance, 800),
    verifier: t.verifier_post,
    result: t.result ? snip(t.result, 1500) : undefined,
    result_assets: t.result_assets,
    block_reason: t.block_reason,
    return_count: t.return_count || undefined,
    reassign_count: t.reassign_count || undefined,
    comments: d.comments.slice(-10).map((c) => ({ at: fmtTime(c.created_at), author: c.author, content: snip(c.content, 300) })),
    children: d.children.map((c) => ({ id: c.id, title: c.title, dept: c.dept, state: c.state, assignee: c.assignee_post })),
    transitions: d.transitions.slice(-6).map((x) => `${fmtTime(x.at)} ${x.from_state}→${x.to_state} by ${x.actor}${x.reason ? `：${snip(x.reason, 80)}` : ""}`),
  };
}

export function edictDetailView(d: EdictDetail) {
  const e = d.edict;
  const latest = d.drafts.length ? d.drafts.reduce((a, b) => (b.no > a.no ? b : a)) : undefined;
  return {
    id: e.id,
    title: e.title,
    state: e.state,
    version: e.version,
    intent: snip(e.intent, 800),
    skip_review: e.skip_review || undefined,
    draft_no: e.draft_no,
    reject_count: e.reject_count,
    drafter: e.drafter_post,
    reviewer: e.reviewer_post,
    dispatcher: e.dispatcher_post,
    budget_tokens: e.budget_tokens,
    deadline: fmtTime(e.deadline),
    report: e.report ? { summary: snip(e.report.summary, 800), failures: e.report.failures, by: e.report.by } : undefined,
    latest_draft: latest
      ? {
          no: latest.no,
          title: latest.title,
          objective: snip(latest.objective, 600),
          constraints: snip(latest.constraints, 600),
          acceptance: snip(latest.acceptance, 600),
          deadline_text: latest.deadline_text,
          budget_tokens: latest.budget_tokens,
          suggested_depts: latest.suggested_depts,
          text: snip(latest.text, 2000),
          responses: latest.responses,
          author: latest.author_post,
          countersigned_by: latest.countersigned_by,
        }
      : undefined,
    reviews: d.reviews.map((r) => ({
      id: r.id,
      draft_no: r.draft_no,
      reviewer: r.reviewer_post,
      decision: r.decision,
      opinion: snip(r.opinion, 400),
      issues: r.issues.map((i) => ({ id: i.id, severity: i.severity, clause: snip(i.clause, 200), reason: i.reason, required_change: snip(i.required_change, 300) })),
    })),
    tasks: d.tasks.map((t) => ({ id: t.id, dept: t.dept, title: t.title, state: t.state, assignee: t.assignee_post })),
    transitions: d.transitions.slice(-8).map((x) => `${fmtTime(x.at)} ${x.from_state}→${x.to_state} by ${x.actor}${x.reason ? `：${snip(x.reason, 80)}` : ""}`),
  };
}

/** 追踪图 → 按时间排序的紧凑时间线 */
export function traceTimeline(g: TraceGraph, limit: number): { lines: string[]; total: number } {
  const rows: { ts: number; line: string }[] = [];
  for (const s of g.spans) {
    const dur = s.ended_at ? ` ${Math.round((s.ended_at - s.started_at) / 1000)}s` : " 进行中";
    rows.push({ ts: s.started_at, line: `${fmtTime(s.started_at)} [${s.kind}] ${s.name} · ${s.actor} · ${s.status}${dur} (${s.span_id})` });
  }
  for (const e of g.events) {
    if (e.type.startsWith("llm.") || e.type.startsWith("tool.")) continue; // 细节过多，留给 span
    rows.push({ ts: e.ts, line: `${fmtTime(e.ts)} {${e.type}} ${e.actor}：${snip(e.summary, 120)}` });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const lines = rows.map((r) => r.line);
  return { lines: lines.slice(-limit), total: lines.length };
}

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TaskActionBody = DistOmit<TaskActionReq, "post" | "idem_key" | "trace_id" | "parent_span_id">;

/** 任务动作公共实现 */
export async function doTaskAction(
  ctx: ToolContext,
  toolCallId: string,
  taskId: string,
  action: TaskActionBody,
  verb: string,
) {
  await focusTask(ctx, taskId);
  const body = { ...writeMeta(ctx, toolCallId), post: ctx.post.post_id, ...action } as TaskActionReq;
  const d = await ctx.hub.taskAction(taskId, body);
  rememberTrace(ctx, `task:${d.task.id}`, d.task.trace_id);
  return ok(`${verb}：任务 ${d.task.id}「${d.task.title}」现为 ${d.task.state}`, taskRow(d.task), ["submit", "verify", "assign", "reassign"].includes(body.action) ? { hint: AUTO_NOTIFY_HINT } : undefined);
}

export function docsTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  return [
    defineTool({
      name: "edict_get",
      label: "查阅诏令",
      description:
        "查阅诏令全貌：状态/版本、旨意、最新草稿、历次审核意见与问题编号（iss_…）、分派的任务、状态流转。起草、审核、分派、复奏前先看。",
      parameters: Type.Object({ edict_id: Type.String({ description: "诏令 ID（亦即其 trace_id）" }) }),
      async run(p) {
        focusEdict(ctx, p.edict_id);
        const d = await ctx.hub.edict(p.edict_id);
        return ok(`诏令 ${d.edict.id}「${d.edict.title}」：${d.edict.state}（v${d.edict.version}，草稿 ${d.edict.draft_no} 号）`, edictDetailView(d), {
          hint: d.drafts.length > 1 ? "比较草稿差异可用 edict_diff（如有权限）。" : undefined,
        });
      },
    }),

    defineTool({
      name: "edict_list",
      label: "诏令列表",
      description: "列出诏令（最新在前）：ID、标题、状态、草稿号、封驳次数、承办人。",
      parameters: Type.Object({
        state: Type.Optional(StringEnum(EDICT_STATES, { description: "按状态过滤" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "最多条数，默认 20" })),
      }),
      async run(p) {
        const list = await ctx.hub.edicts({ state: p.state, limit: p.limit ?? 20 });
        return ok(
          `诏令 ${list.length} 道`,
          list.map((e) => ({ id: e.id, title: e.title, state: e.state, draft_no: e.draft_no, rejects: e.reject_count || undefined, drafter: e.drafter_post, reviewer: e.reviewer_post, dispatcher: e.dispatcher_post, created: fmtTime(e.created_at) })),
        );
      },
    }),

    defineTool({
      name: "task_get",
      label: "查阅任务",
      description: "查阅任务详情：说明、验收标准、期限、状态、承办人、核验方式、结果、评论、子任务、流转。",
      parameters: Type.Object({ task_id: Type.String({ description: "任务 ID（tsk_…）" }) }),
      async run(p) {
        const d = await ctx.hub.task(p.task_id);
        rememberTrace(ctx, `task:${d.task.id}`, d.task.trace_id);
        return ok(`任务 ${d.task.id}「${d.task.title}」：${d.task.state}`, taskDetailView(d));
      },
    }),

    defineTool({
      name: "task_list",
      label: "任务列表",
      description: "列出任务，默认你名下未结的；可按部门、状态、诏令过滤。",
      parameters: Type.Object({
        mine: Type.Optional(Type.Boolean({ description: "只看自己名下的（默认：未指定部门/诏令时为 true）" })),
        dept: Type.Optional(StringEnum(DEPT_IDS, { description: "按部门过滤" })),
        state: Type.Optional(StringEnum(TASK_STATES, { description: "按状态过滤；open=所有未结，默认 open" })),
        edict_id: Type.Optional(Type.String({ description: "只看某诏令下的任务" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "最多条数，默认 30" })),
      }),
      async run(p) {
        const mine = p.mine ?? (!p.dept && !p.edict_id);
        const list = await ctx.hub.tasks({ assignee: mine ? postId : undefined, dept: p.dept, state: p.state ?? "open", edict_id: p.edict_id, limit: p.limit ?? 30 });
        return ok(`任务 ${list.length} 项`, list.map(taskRow));
      },
    }),

    defineTool({
      name: "task_start",
      label: "开始任务",
      description: "开始办理指派给你（或被退回）的任务 → in_progress。久无进展会被看门狗改派，请适时 task_update。",
      refetch: "task_get",
      parameters: Type.Object({ task_id: Type.String({ description: "任务 ID" }) }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "start" }, "已开始");
      },
    }),

    defineTool({
      name: "task_update",
      label: "汇报进展",
      description: "记录任务进展（续租防改派）：已完成什么、下一步、预计何时提交。确实无法完成时 failed=true 判为失败并通知上级（不可恢复）。",
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        progress: Type.String({ description: "进展说明；failed=true 时写失败原因" }),
        failed: Type.Optional(Type.Boolean({ description: "确认无法完成，判为失败" })),
      }),
      async run(p, call) {
        if (p.failed) return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "fail", reason: p.progress }, "已判失败");
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "update", progress: p.progress }, "已记录进展");
      },
    }),

    defineTool({
      name: "task_comment",
      label: "任务批注",
      description: "在任务下留言（提问、补充、说明），通知相关人，不改变状态。",
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        content: Type.String({ description: "留言内容" }),
      }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "comment", content: p.content }, "已留言");
      },
    }),

    defineTool({
      name: "task_submit",
      label: "提交任务",
      description:
        `提交成果交核验（自验则直接办结）；不通过会退回，超过 ${LIMITS.maxReturns} 次判失败。result 逐条对照验收标准；产物先存为资产并列入 asset_ids——宣称完成而无产物会被御史稽查。`,
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        result: Type.String({ description: "成果说明（逐条对照验收标准）" }),
        asset_ids: Type.Optional(Type.Array(Type.String({ description: "资产 ID" }), { description: "相关产物资产 ID 列表" })),
      }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "submit", result: p.result, asset_ids: p.asset_ids }, "已提交");
      },
    }),

    defineTool({
      name: "task_block",
      label: "任务受阻",
      description: "声明任务受阻（→ blocked，通知上级），写明阻碍与需要谁做什么。阻碍解除后用 unblock=true 恢复办理（受阻中不能提交）。",
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        reason: Type.String({ description: "受阻原因与所需支援；unblock 时写解除说明" }),
        unblock: Type.Optional(Type.Boolean({ description: "true=解除受阻，恢复 in_progress" })),
      }),
      async run(p, call) {
        if (p.unblock) return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "unblock", note: p.reason }, "已解除受阻");
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "block", reason: p.reason }, "已标记受阻");
      },
    }),

    defineTool({
      name: "task_create_subtask",
      label: "创建子任务",
      description:
        `创建任务（通常是你名下任务的子任务）交给某部门，可指定承办职位，否则由该部门指派。须写清说明与可核验的验收标准；每人未结任务 ≤${LIMITS.maxOpenTasksPerPost}，勿滥建。`,
      parameters: Type.Object({
        parent_id: Type.Optional(Type.String({ description: "父任务 ID（继承其诏令与 trace）" })),
        dept: StringEnum(DEPT_IDS, { description: "承办部门 ID" }),
        title: Type.String({ description: "任务标题" }),
        instructions: Type.String({ description: "办理说明：做什么、依据、边界" }),
        acceptance: Type.String({ description: "验收标准（可核验）" }),
        assignee_post: Type.Optional(Type.String({ description: "承办职位（须属该部门）" })),
        deadline_minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 43200, description: "期限（分钟）" })),
        verify_by: Type.Optional(StringEnum(VERIFY_BY, { description: "核验方，默认 superior" })),
      }),
      async run(p, call) {
        if (p.parent_id) await focusTask(ctx, p.parent_id);
        const assignee = p.assignee_post ? resolveAddress(ctx, p.assignee_post, ["post"]).slice(5) : undefined;
        const t = await ctx.hub.createTask({
          ...writeMeta(ctx, call.toolCallId),
          post: postId,
          dept: p.dept,
          parent_id: p.parent_id,
          assignee_post: assignee,
          title: p.title,
          instructions: p.instructions,
          acceptance: p.acceptance,
          deadline_minutes: p.deadline_minutes,
          verify_by: p.verify_by,
        });
        rememberTrace(ctx, `task:${t.id}`, t.trace_id);
        return ok(`已创建任务 ${t.id}「${t.title}」→ ${t.dept}${t.assignee_post ? `（${t.assignee_post}）` : ""}，状态 ${t.state}`, taskRow(t));
      },
    }),

    defineTool({
      name: "trace_timeline",
      label: "事务时间线",
      description: "查看某事务（trace）的执行时间线：各环节起止、执行人、状态与关键事件。默认当前 trace。",
      parameters: Type.Object({
        trace_id: Type.Optional(Type.String({ description: "trace ID（诏令 ID 即其 trace）；默认当前 trace" })),
        limit: Type.Optional(Type.Integer({ minimum: 5, maximum: 200, description: "最多显示最近多少条，默认 60" })),
      }),
      async run(p) {
        const id = p.trace_id ?? ctx.turn().trace_id;
        if (!id) throw new ToolError("当前没有聚焦的 trace，请指定 trace_id");
        const g = await ctx.hub.trace(id);
        const { lines, total } = traceTimeline(g, p.limit ?? 60);
        return ok(`trace ${id}：共 ${total} 条记录${total > lines.length ? `，显示最近 ${lines.length} 条` : ""}`, lines.join("\n"), {
          hint: total > lines.length ? "可加大 limit 查看更早记录。" : undefined,
        });
      },
    }),
  ];
}

