// 尚书省·分派复奏；六部长官·任务管理；部门广播
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { VERIFY_BY, doTaskAction } from "./docs.ts";
import { deliverAndLog } from "./messaging.ts";
import { DEPT_IDS, ToolError, defineTool, focusEdict, ok, resolveAddress, selfAddr, writeMeta, AUTO_NOTIFY_HINT } from "./_util.ts";

export function dispatchTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  const assignee = (raw: string) => resolveAddress(ctx, raw, ["post"]).slice(5);
  return [
    defineTool({
      name: "edict_dispatch",
      label: "分派诏令",
      description:
        "（尚书省）把已通过审核的诏令拆成任务分派各部（→ executing，≤20 项），各部长官再指派承办人。每项须有说明与可核验的验收标准；" +
        "verify_by：self 自验 / superior 部门长官 / xingbu 刑部。全部任务终结后用 edict_report 复奏。",
      refetch: "edict_get",
      parameters: Type.Object({
        edict_id: Type.String({ description: "诏令 ID" }),
        tasks: Type.Array(
          Type.Object({
            dept: StringEnum(DEPT_IDS, { description: "承办部门 ID" }),
            title: Type.String({ description: "任务标题" }),
            instructions: Type.String({ description: "办理说明" }),
            acceptance: Type.String({ description: "验收标准" }),
            deadline_minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 43200, description: "期限（分钟）" })),
            verify_by: Type.Optional(StringEnum(VERIFY_BY, { description: "核验方，默认 superior" })),
          }),
          { minItems: 1, maxItems: 20, description: "任务清单" },
        ),
        note: Type.Optional(Type.String({ description: "分派说明（各部协作关系、先后顺序）" })),
      }),
      async run(p, call) {
        focusEdict(ctx, p.edict_id);
        const d = await ctx.hub.dispatch(p.edict_id, { ...writeMeta(ctx, call.toolCallId), post: postId, tasks: p.tasks, note: p.note });
        return ok(`已分派 ${p.tasks.length} 项任务，诏令现为 ${d.edict.state}`, {
          edict_id: d.edict.id,
          state: d.edict.state,
          tasks: d.tasks.map((t) => ({ id: t.id, dept: t.dept, title: t.title, state: t.state })),
        }, { hint: AUTO_NOTIFY_HINT });
      },
    }),

    defineTool({
      name: "edict_report",
      label: "复奏",
      description: "（尚书省）诏令下全部任务终结后向皇帝复奏（→ reported，待御览）。summary 写成果与产物，failures 如实写未完成项及原因。",
      refetch: "edict_get",
      parameters: Type.Object({
        edict_id: Type.String({ description: "诏令 ID" }),
        summary: Type.String({ description: "执行结果摘要（含产物资产 ID）" }),
        failures: Type.Optional(Type.String({ description: "未完成/失败事项及原因；无则不填" })),
      }),
      async run(p, call) {
        focusEdict(ctx, p.edict_id);
        const d = await ctx.hub.report(p.edict_id, { ...writeMeta(ctx, call.toolCallId), post: postId, summary: p.summary, failures: p.failures });
        return ok(`已复奏，诏令现为 ${d.edict.state}，待皇帝御览`, { edict_id: d.edict.id, state: d.edict.state }, { hint: AUTO_NOTIFY_HINT });
      },
    }),

    defineTool({
      name: "task_assign",
      label: "指派任务",
      description: "把本部门（或你分派的）任务指派给承办官员（→ assigned），按职掌与负荷选人（可先 get_department_status）。",
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        assignee_post: Type.String({ description: "承办职位 ID（或职衔/姓名）" }),
        note: Type.Optional(Type.String({ description: "交代事项" })),
      }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "assign", assignee_post: assignee(p.assignee_post), note: p.note }, "已指派");
      },
    }),

    defineTool({
      name: "task_reassign",
      label: "改派任务",
      description: `把任务改派给另一位官员（每项 ≤${LIMITS.maxReassign} 次，超出自动上报尚书都事）。`,
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        assignee_post: Type.String({ description: "新承办职位 ID（或职衔/姓名）" }),
        reason: Type.String({ description: "改派理由" }),
      }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "reassign", assignee_post: assignee(p.assignee_post), reason: p.reason }, "已改派");
      },
    }),

    defineTool({
      name: "task_cancel",
      label: "撤销任务",
      description: "撤销任务（不再需要或无法执行；子任务一并撤销，不可恢复）。",
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        reason: Type.String({ description: "撤销理由" }),
      }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "cancel", reason: p.reason }, "已撤销");
      },
    }),

    defineTool({
      name: "task_extend_deadline",
      label: "展期",
      description: "为任务延长期限（分钟），免因超期被逐级上报。",
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        minutes: Type.Integer({ minimum: 1, maximum: 10080, description: "延长分钟数（≤10080，即 7 天）" }),
        reason: Type.String({ description: "展期理由" }),
      }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "extend", minutes: p.minutes, reason: p.reason }, `已展期 ${p.minutes} 分钟`);
      },
    }),

    defineTool({
      name: "task_verify",
      label: "核验任务",
      description:
        `核验已提交的任务：pass=true 办结；false 退回重做（超过 ${LIMITS.maxReturns} 次判失败），comment 写明哪条验收未满足、怎么改。` +
        "先 task_get、asset_read 看成果，逐条对照验收标准，不得走过场。",
      refetch: "task_get",
      parameters: Type.Object({
        task_id: Type.String({ description: "任务 ID" }),
        pass: Type.Boolean({ description: "是否通过" }),
        comment: Type.String({ description: "核验意见（逐条对照验收标准）" }),
      }),
      async run(p, call) {
        return doTaskAction(ctx, call.toolCallId, p.task_id, { action: "verify", pass: p.pass, comment: p.comment }, p.pass ? "核验通过" : "已退回");
      },
    }),

    defineTool({
      name: "broadcast_department",
      label: "部门通告",
      description:
        `向本部门同僚发知会通告（不唤醒，≤${LIMITS.broadcastMaxRecipients} 人）。要人立即处理请用 send_message 或 task_assign。`,
      parameters: Type.Object({
        subject: Type.String({ description: "通告标题" }),
        body: Type.String({ description: "通告内容" }),
      }),
      async run(p, call) {
        const members = ctx
          .registry()
          .posts.filter((x) => x.dept === ctx.dept.id && x.post_id !== postId)
          .map((x) => `post:${x.post_id}`);
        if (!members.length) throw new ToolError("本部门没有其他同僚");
        const list = members.slice(0, LIMITS.broadcastMaxRecipients);
        const res = await deliverAndLog(ctx, {
          ...writeMeta(ctx, call.toolCallId),
          from: selfAddr(ctx),
          to: list[0],
          cc: list.slice(1),
          kind: "fyi",
          subject: `【部门通告】${p.subject}`,
          body: p.body,
          requires_reply: false,
          meta: { broadcast: true, dept: ctx.dept.id },
        });
        return ok(
          `已向 ${list.length} 位同僚发通告（${res.message.id}）${members.length > list.length ? `；另有 ${members.length - list.length} 人超出上限未发` : ""}`,
          { message_id: res.message.id, recipients: list },
        );
      },
    }),
  ];
}
