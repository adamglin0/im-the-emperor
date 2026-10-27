// 中书省·起草工具（含 edict_diff，门下省共用）
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS, type EdictDraft } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { DEPT_IDS, ToolError, defineTool, focusEdict, lineDiff, ok, writeMeta, AUTO_NOTIFY_HINT } from "./_util.ts";

function draftText(d: EdictDraft): string {
  return [
    `标题：${d.title}`,
    `目标：${d.objective}`,
    `约束：${d.constraints}`,
    `验收标准：${d.acceptance}`,
    `期限：${d.deadline_text}`,
    `预算：${d.budget_tokens ?? "未定"}`,
    `建议承办：${d.suggested_depts.join("、")}`,
    "正文：",
    d.text,
  ].join("\n");
}

export function edictDiffTool(ctx: ToolContext): AgentTool<any> {
  return defineTool({
    name: "edict_diff",
    label: "草稿比对",
    description: "逐行比较诏令两稿的差异（- 删 / + 增，含各字段与正文），默认最新稿对上一稿。复审必用。",
    refetch: "edict_get",
    parameters: Type.Object({
      edict_id: Type.String({ description: "诏令 ID" }),
      from_no: Type.Optional(Type.Integer({ minimum: 1, description: "旧稿号，默认 to_no-1" })),
      to_no: Type.Optional(Type.Integer({ minimum: 1, description: "新稿号，默认最新" })),
    }),
    async run(p) {
      focusEdict(ctx, p.edict_id);
      const d = await ctx.hub.edict(p.edict_id);
      if (d.drafts.length === 0) throw new ToolError("该诏令尚无草稿");
      const latest = Math.max(...d.drafts.map((x) => x.no));
      const to = p.to_no ?? latest;
      const from = p.from_no ?? to - 1;
      const a = d.drafts.find((x) => x.no === from);
      const b = d.drafts.find((x) => x.no === to);
      if (!b) throw new ToolError(`没有第 ${to} 稿（现有：${d.drafts.map((x) => x.no).join("、")}）`);
      if (!a) throw new ToolError(`没有第 ${from} 稿（现有：${d.drafts.map((x) => x.no).join("、")}）`, "只有一稿时无需比对，直接 edict_get 查看。");
      const diff = lineDiff(draftText(a), draftText(b));
      const changed = diff.split("\n").filter((l) => l.startsWith("+ ") || l.startsWith("- ")).length;
      return ok(`第 ${from} 稿 → 第 ${to} 稿：${changed} 行变化`, diff, {
        hint: b.responses.length ? `第 ${to} 稿对封驳的逐条回应：${JSON.stringify(b.responses)}` : undefined,
      });
    },
  });
}

export function draftingTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  return [
    defineTool({
      name: "edict_submit_draft",
      label: "呈递草稿",
      description:
        "呈递新一稿草稿（送复署或门下审核）：目标、约束、可核验的验收标准、期限、建议承办部门必填，预算可选。" +
        `若上稿被封驳，须在 responses 中对每条 blocking 问题（iss_…）逐条回应（如何改/不改的理由），缺一条即被退回；封驳超过 ${LIMITS.maxRejects} 次上呈圣裁。先 edict_get 看审核意见。`,
      refetch: "edict_get",
      parameters: Type.Object({
        edict_id: Type.String({ description: "诏令 ID" }),
        title: Type.String({ description: "诏令标题" }),
        objective: Type.String({ description: "目标：要达成什么" }),
        constraints: Type.String({ description: "约束：边界、禁止事项、依据" }),
        acceptance: Type.String({ description: "验收标准：可逐条核验的完成条件" }),
        deadline_text: Type.String({ description: "期限（如「三日内」「2026-10-30 前」）" }),
        budget_tokens: Type.Optional(Type.Integer({ minimum: 0, description: "token 预算上限（可选）" })),
        suggested_depts: Type.Array(StringEnum(DEPT_IDS), { description: "建议承办部门" }),
        text: Type.String({ description: "诏书正文（正式文本）" }),
        responses: Type.Optional(
          Type.Array(
            Type.Object({
              issue_id: Type.String({ description: "封驳问题 ID（iss_…）" }),
              response: Type.String({ description: "如何修改，或不改的理由" }),
            }),
            { description: "对上次封驳问题的逐条回应" },
          ),
        ),
      }),
      async run(p, call) {
        focusEdict(ctx, p.edict_id);
        const d = await ctx.hub.submitDraft(p.edict_id, {
          ...writeMeta(ctx, call.toolCallId),
          post: postId,
          title: p.title,
          objective: p.objective,
          constraints: p.constraints,
          acceptance: p.acceptance,
          deadline_text: p.deadline_text,
          budget_tokens: p.budget_tokens,
          suggested_depts: p.suggested_depts,
          text: p.text,
          responses: p.responses,
        });
        return ok(`已呈递第 ${d.edict.draft_no} 稿，诏令现为 ${d.edict.state}`, { edict_id: d.edict.id, draft_no: d.edict.draft_no, state: d.edict.state, version: d.edict.version }, { hint: AUTO_NOTIFY_HINT });
      },
    }),

    defineTool({
      name: "edict_countersign",
      label: "复署草稿",
      description: "（中书侍郎）复署舍人草稿：approve=true 送门下审核；false 退回重拟，comment 写明修改意见。",
      refetch: "edict_get",
      parameters: Type.Object({
        edict_id: Type.String({ description: "诏令 ID" }),
        approve: Type.Boolean({ description: "是否同意" }),
        comment: Type.String({ description: "复署意见（退回时写明修改要求）" }),
      }),
      async run(p, call) {
        focusEdict(ctx, p.edict_id);
        const d = await ctx.hub.countersign(p.edict_id, { ...writeMeta(ctx, call.toolCallId), post: postId, approve: p.approve, comment: p.comment });
        return ok(`已${p.approve ? "复署同意" : "退回重拟"}，诏令现为 ${d.edict.state}`, { edict_id: d.edict.id, state: d.edict.state, draft_no: d.edict.draft_no }, { hint: AUTO_NOTIFY_HINT });
      },
    }),

    defineTool({
      name: "edict_request_clarification",
      label: "请旨释疑",
      description: "旨意不明无法起草时向皇帝请旨澄清（进入待办），返回 notification_id，可 wait_for {notification_id} 等批复。勿为小事请示。",
      refetch: "edict_get",
      parameters: Type.Object({
        edict_id: Type.String({ description: "诏令 ID" }),
        question: Type.String({ description: "需要皇帝澄清的问题（最好给出备选方案）" }),
      }),
      async run(p, call) {
        focusEdict(ctx, p.edict_id);
        const n = await ctx.hub.clarify(p.edict_id, { ...writeMeta(ctx, call.toolCallId), post: postId, question: p.question });
        return ok(`已请旨释疑（${n.id}）`, { notification_id: n.id }, { hint: `等待批复：wait_for {notification_id: "${n.id}", timeout_seconds: ...}` });
      },
    }),

    edictDiffTool(ctx),
  ];
}
