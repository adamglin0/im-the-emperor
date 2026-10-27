// 门下省·审核（封驳）与谏诤工具
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS, REJECT_REASONS } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { ToolError, defineTool, focusEdict, ok, writeMeta, AUTO_NOTIFY_HINT } from "./_util.ts";

export function reviewTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  return [
    defineTool({
      name: "edict_review",
      label: "审核诏令",
      description:
        "审核当前草稿：approve 通过（送尚书省）/ reject 封驳（退中书重拟）。封驳规则：" +
        `1) reject 须至少一条 blocking 问题，approve 不得含 blocking；建议列为 advisory。理由只能取：${REJECT_REASONS.join("、")}。` +
        "2) 第 2 次审核起不得新增 blocking，只核对前次问题：blocking 的 clause 必须引用前次问题 ID（iss_…），新发现只能列 advisory。" +
        `3) 封驳超过 ${LIMITS.maxRejects} 次上呈皇帝圣裁。4) clause 指明哪条哪句，required_change 写明改成什么，不得空泛。` +
        "先 edict_get 看草稿与历次意见，第二稿起用 edict_diff 看改动。",
      refetch: "edict_get",
      parameters: Type.Object({
        edict_id: Type.String({ description: "诏令 ID" }),
        decision: StringEnum(["approve", "reject"] as const, { description: "approve 通过 / reject 封驳" }),
        opinion: Type.String({ description: "总体审核意见" }),
        issues: Type.Array(
          Type.Object({
            severity: StringEnum(["blocking", "advisory"] as const, { description: "blocking 必须修改 / advisory 建议" }),
            clause: Type.String({ description: "针对的条款或原文；复审时引用前次问题 ID" }),
            reason: StringEnum(REJECT_REASONS, { description: "理由（固定清单）" }),
            required_change: Type.String({ description: "要求如何修改" }),
          }),
          { maxItems: 30, description: "问题清单；无意见时为空数组" },
        ),
      }),
      async run(p, call) {
        const blocking = p.issues.filter((i) => i.severity === "blocking");
        if (p.decision === "reject" && blocking.length === 0) throw new ToolError("封驳须至少列出一条 blocking 问题", "若只是建议，请 decision=approve 并以 advisory 列出。");
        if (p.decision === "approve" && blocking.length > 0) throw new ToolError("通过时不能带 blocking 问题", "有必须修改之处请 decision=reject；否则把问题改为 advisory。");
        focusEdict(ctx, p.edict_id);
        const d = await ctx.hub.review(p.edict_id, { ...writeMeta(ctx, call.toolCallId), post: postId, decision: p.decision, opinion: p.opinion, issues: p.issues });
        const last = d.reviews[d.reviews.length - 1];
        return ok(`已${p.decision === "approve" ? "审核通过" : "封驳"}第 ${d.edict.draft_no} 稿，诏令现为 ${d.edict.state}（累计封驳 ${d.edict.reject_count} 次）`, {
          edict_id: d.edict.id,
          state: d.edict.state,
          review_id: last?.id,
          issue_ids: last?.issues.map((i) => i.id),
        }, { hint: AUTO_NOTIFY_HINT });
      },
    }),

    defineTool({
      name: "edict_remonstrate",
      label: "谏诤",
      description:
        "（谏官）就诏令向皇帝进谏：指出风险并给替代方案。每稿限谏一次；谏后诏令暂停，待皇帝「坚持/修改/撤回」。只在确有重大风险（违法、扰民、劳民伤财、与前诏冲突）时用。",
      refetch: "edict_get",
      parameters: Type.Object({
        edict_id: Type.String({ description: "诏令 ID" }),
        risk: Type.String({ description: "风险：会出什么问题、依据" }),
        alternative: Type.String({ description: "替代方案" }),
      }),
      async run(p, call) {
        focusEdict(ctx, p.edict_id);
        const d = await ctx.hub.remonstrate(p.edict_id, { ...writeMeta(ctx, call.toolCallId), post: postId, risk: p.risk, alternative: p.alternative });
        return ok(`已进谏，诏令现为 ${d.edict.state}，待皇帝圣裁`, { edict_id: d.edict.id, state: d.edict.state });
      },
    }),
  ];
}
