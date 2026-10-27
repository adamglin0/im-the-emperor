// 刑部·纠错工具（task_verify 由 dispatch.ts 提供）
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DeptId } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { TASK_STATES, taskRow } from "./docs.ts";
import { deliverAndLog } from "./messaging.ts";
import { ToolError, defineTool, ok, rememberTrace, resolvePost, selfAddr, writeMeta } from "./_util.ts";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const SEV_CN: Record<(typeof SEVERITIES)[number], string> = { low: "轻微", medium: "一般", high: "严重", critical: "致命" };
export const BUG_PREFIX = "【bug】";

export function justiceTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  return [
    defineTool({
      name: "bug_report",
      label: "立案纠错",
      description:
        "就发现的缺陷/错误立案：在责任方所在部门创建一项纠错任务（标题加「【bug】」前缀，由刑部核验），并致信责任人。" +
        "须指定 target_post（责任职位）或 task_id（出问题的任务，责任人取其承办人），二者至少一个。" +
        "detail 写清复现步骤、期望与实际结果、证据（资产 ID/命令输出）。",
      parameters: Type.Object({
        target_post: Type.Optional(Type.String({ description: "责任职位 ID（或职衔/姓名）" })),
        task_id: Type.Optional(Type.String({ description: "出问题的任务 ID" })),
        title: Type.String({ description: "缺陷标题" }),
        detail: Type.String({ description: "复现步骤、期望与实际、证据" }),
        severity: StringEnum(SEVERITIES, { description: "严重程度：low/medium/high/critical" }),
      }),
      async run(p, call) {
        let assignee: string | undefined;
        let dept: DeptId | undefined;
        let edictNote = "";
        if (p.task_id) {
          const d = await ctx.hub.task(p.task_id);
          rememberTrace(ctx, `task:${d.task.id}`, d.task.trace_id);
          assignee = d.task.assignee_post;
          dept = d.task.dept;
          edictNote = `\n相关任务：${d.task.id}「${d.task.title}」${d.task.edict_id ? `（诏令 ${d.task.edict_id}）` : ""}`;
        }
        if (p.target_post) {
          const post = resolvePost(ctx, p.target_post);
          assignee = post.post_id;
          dept = post.dept;
        }
        if (!dept) throw new ToolError("须指定 target_post 或 task_id（且该任务有承办部门）");
        const t = await ctx.hub.createTask({
          ...writeMeta(ctx, call.toolCallId, "task"),
          post: postId,
          dept,
          assignee_post: assignee,
          title: `${BUG_PREFIX}${p.title}`,
          instructions: `【${SEV_CN[p.severity]}】${p.detail}${edictNote}`,
          acceptance: "修复缺陷并说明修复方式与验证方法，经刑部复核通过",
          verify_by: "xingbu",
        });
        rememberTrace(ctx, `task:${t.id}`, t.trace_id);
        const to = assignee ? `post:${assignee}` : `dept:${dept}`;
        const msg = await deliverAndLog(ctx, {
          ...writeMeta(ctx, call.toolCallId, "msg"),
          from: selfAddr(ctx),
          to,
          kind: "chat",
          subject: `刑部纠错立案：${p.title}`,
          body: `已立纠错任务 ${t.id}（${SEV_CN[p.severity]}）。\n${p.detail}${edictNote}\n\n请修复后 task_submit，由刑部复核。`,
          priority: p.severity === "high" || p.severity === "critical" ? "high" : "normal",
          meta: { bug_task_id: t.id, severity: p.severity },
        });
        return ok(`已立案：任务 ${t.id} → ${to}（${SEV_CN[p.severity]}），并致信 ${msg.message.id}`, { task: taskRow(t), message_id: msg.message.id });
      },
    }),

    defineTool({
      name: "bug_list",
      label: "纠错案卷",
      description: "列出本部门立案的纠错任务（标题以「【bug】」开头），默认只看未结的。",
      parameters: Type.Object({
        state: Type.Optional(StringEnum(TASK_STATES, { description: "状态过滤，默认 open（未结）" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "最多条数，默认 50" })),
      }),
      async run(p) {
        const members = new Set(ctx.registry().posts.filter((x) => x.dept === ctx.dept.id).map((x) => `post:${x.post_id}`));
        const all = await ctx.hub.tasks({ state: p.state ?? "open", limit: 500 });
        const list = all.filter((t) => t.title.startsWith(BUG_PREFIX) && (members.has(t.creator) || t.creator === `dept:${ctx.dept.id}`)).slice(0, p.limit ?? 50);
        return ok(`纠错案卷 ${list.length} 件`, list.map(taskRow));
      },
    }),
  ];
}
