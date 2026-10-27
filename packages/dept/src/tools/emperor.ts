// 通用·面圣工具：上奏、知会、查批复
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS, type Notification } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { defineTool, fmtTime, focusDeliberation, focusEdict, focusMessage, focusTask, ok, rememberTrace, writeMeta } from "./_util.ts";

export function notificationView(n: Notification) {
  return {
    notification_id: n.id,
    kind: n.kind,
    category: n.category,
    title: n.title,
    status: n.status,
    options: n.options,
    resolution: n.resolution ? { option: n.resolution.option, comment: n.resolution.comment, at: fmtTime(n.resolution.at) } : undefined,
    related: n.related,
    trace_id: n.trace_id,
    created: fmtTime(n.created_at),
  };
}

const RELATED = Type.Optional(
  Type.Object(
    {
      type: Type.String({ description: "edict / task / deliberation / message 等" }),
      id: Type.String({ description: "对象 ID" }),
    },
    { description: "关联对象（本轮随之聚焦其事务）" },
  ),
);

/** 奏事关联某公文时，聚焦其 trace，使待办挂在正确的事务上 */
async function focusRelated(ctx: ToolContext, r: { type: string; id: string } | undefined): Promise<void> {
  if (!r?.id) return;
  if (r.type === "edict") focusEdict(ctx, r.id);
  else if (r.type === "task") await focusTask(ctx, r.id);
  else if (r.type === "deliberation") await focusDeliberation(ctx, r.id);
  else if (r.type === "message") await focusMessage(ctx, r.id);
}

export function emperorTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  return [
    defineTool({
      name: "petition_emperor",
      label: "上奏请旨",
      description:
        `上奏请皇帝圣裁（进入待办），只用于确需皇帝决断的大事：越权、重大分歧、预算追加、流程卡死；每人每小时 ≤${LIMITS.petitionPerHour} 次。` +
        "返回 notification_id，批复会唤醒你；要停下等批复用 wait_for {notification_id}。",
      parameters: Type.Object({
        title: Type.String({ description: "奏事标题，一句话" }),
        body: Type.String({ description: "奏文：事由、利弊、建议；称陛下、自称臣" }),
        options: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.String({ description: "选项 ID（短英文）" }),
              label: Type.String({ description: "选项文字" }),
            }),
            { maxItems: 6, description: "供皇帝选的选项（≤6）；默认 准奏/不准/已阅" },
          ),
        ),
        related: RELATED,
      }),
      async run(p, call) {
        await focusRelated(ctx, p.related);
        const n = await ctx.hub.petition({
          ...writeMeta(ctx, call.toolCallId),
          post: postId,
          kind: "action_required",
          category: "petition",
          title: p.title,
          body: p.body,
          options: p.options,
          related: p.related,
        });
        rememberTrace(ctx, `notif:${n.id}`, n.trace_id);
        return ok(`已上奏（${n.id}），待皇帝批复`, notificationView(n), {
          hint: `如需停下等批复：wait_for {notification_id: "${n.id}", timeout_seconds: ...}；也可先处理别的事，批复会唤醒你。`,
        });
      },
    }),

    defineTool({
      name: "report_progress",
      label: "奏报进展",
      description: "向皇帝知会进展（不需批复），用于重要节点完成、风险预警；勿频报琐事。",
      parameters: Type.Object({
        title: Type.String({ description: "标题" }),
        body: Type.String({ description: "进展内容，简明扼要" }),
        related: RELATED,
      }),
      async run(p, call) {
        await focusRelated(ctx, p.related);
        const n = await ctx.hub.petition({
          ...writeMeta(ctx, call.toolCallId),
          post: postId,
          kind: "fyi",
          category: "progress",
          title: p.title,
          body: p.body,
          related: p.related,
        });
        return ok(`已奏报进展（${n.id}）`, { notification_id: n.id });
      },
    }),

    defineTool({
      name: "get_notification",
      label: "查询批复",
      description: "查询皇帝待办（上奏、请旨、审批）的状态与批复（所选选项与朱批）。",
      parameters: Type.Object({ notification_id: Type.String({ description: "待办 ID（ntf_…）" }) }),
      async run(p) {
        const n = await ctx.hub.notification(p.notification_id);
        rememberTrace(ctx, `notif:${n.id}`, n.trace_id);
        return ok(`待办 ${n.id}「${n.title}」：${n.status === "resolved" ? `已批复「${n.resolution?.option}」` : n.status}`, notificationView(n));
      },
    }),
  ];
}
