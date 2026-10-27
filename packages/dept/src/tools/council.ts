// 政事堂·议事工具
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS, type DeliberationDetail } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { ToolError, defineTool, fmtTime, focusDeliberation, ok, rememberTrace, snip, writeMeta } from "./_util.ts";

const STANCES = ["support", "oppose", "reserve", "pass"] as const;

function delibView(d: DeliberationDetail, entryLimit = 20) {
  const x = d.deliberation;
  return {
    deliberation_id: x.id,
    topic: snip(x.topic, 600),
    state: x.state,
    chair: x.chair_post,
    session_no: x.session_no,
    round: `${x.round}/${x.max_rounds}`,
    current_speaker: x.current_speaker,
    speaker_queue: x.speaker_queue,
    members: x.members,
    conclusion: x.conclusion,
    token_spent: x.token_spent,
    version: x.version,
    entries: d.entries.slice(-entryLimit).map((e) => ({
      at: fmtTime(e.created_at),
      session: e.session_no,
      round: e.round,
      author: e.author,
      stance: e.stance,
      content: snip(e.content, 600),
    })),
  };
}

export function councilTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  return [
    defineTool({
      name: "council_get",
      label: "查看议事",
      description: "查看政事堂议事：议题、轮次、当前发言人与队列、各人发言、结论。不填 ID 取进行中的一场。",
      parameters: Type.Object({
        deliberation_id: Type.Optional(Type.String({ description: "议事 ID；不填则取进行中的那场" })),
      }),
      async run(p) {
        let id = p.deliberation_id;
        if (!id) {
          const open = await ctx.hub.deliberations("open");
          if (!open.length) return ok("当前没有进行中的议事");
          id = open[0].id;
          if (open.length > 1) ctx.log("council_multi_open", { ids: open.map((d) => d.id) });
        }
        const d = await ctx.hub.deliberation(id);
        rememberTrace(ctx, `delib:${id}`, d.deliberation.trace_id);
        const yourTurn = d.deliberation.current_speaker === postId;
        return ok(`议事 ${id}：${d.deliberation.state}，第 ${d.deliberation.round} 轮，当前发言人 ${d.deliberation.current_speaker ?? "无"}${yourTurn ? "（轮到你了）" : ""}`, delibView(d));
      },
    }),

    defineTool({
      name: "council_speak",
      label: "议事发言",
      description:
        "议事发言（轮到你才可发，每轮一次）。stance：support 赞成 / oppose 反对 / reserve 保留 / pass 弃权。" +
        "要言之有物：判断、理由、风险、建议，不复述他人。发言后轮到下一位，你可 end_turn。",
      refetch: "council_get",
      parameters: Type.Object({
        deliberation_id: Type.String({ description: "议事 ID" }),
        stance: StringEnum(STANCES, { description: "立场" }),
        content: Type.String({ description: "发言内容（pass 时可简短说明）" }),
      }),
      async run(p, call) {
        await focusDeliberation(ctx, p.deliberation_id);
        const d = await ctx.hub.councilSpeak(p.deliberation_id, { ...writeMeta(ctx, call.toolCallId), post: postId, stance: p.stance, content: p.content });
        return ok(`已发言（${p.stance}）。下一位：${d.deliberation.current_speaker ?? "本轮发言已毕，待主持决定"}`, {
          deliberation_id: d.deliberation.id,
          round: d.deliberation.round,
          speaker_queue: d.deliberation.speaker_queue,
        });
      },
    }),

    defineTool({
      name: "council_next_round",
      label: "开启下一轮",
      description: `（主持）本轮发言毕而分歧未决时开下一轮（共 ≤${LIMITS.councilMaxRounds} 轮），可附按语点明分歧。`,
      refetch: "council_get",
      parameters: Type.Object({
        deliberation_id: Type.String({ description: "议事 ID" }),
        note: Type.Optional(Type.String({ description: "主持按语（下一轮聚焦什么）" })),
      }),
      async run(p, call) {
        await focusDeliberation(ctx, p.deliberation_id);
        const d = await ctx.hub.councilNextRound(p.deliberation_id, { ...writeMeta(ctx, call.toolCallId), post: postId, note: p.note });
        return ok(`已开启第 ${d.deliberation.round} 轮，首位发言：${d.deliberation.current_speaker ?? "—"}`, { round: d.deliberation.round, speaker_queue: d.deliberation.speaker_queue });
      },
    }),

    defineTool({
      name: "council_conclude",
      label: "议事总结",
      description:
        "（主持）总结议事奏请皇帝定夺（照准颁旨/再议/搁置）。如实写结论与异议；建议颁旨则同时填拟旨标题与旨意。",
      refetch: "council_get",
      parameters: Type.Object({
        deliberation_id: Type.String({ description: "议事 ID" }),
        summary: Type.String({ description: "结论摘要" }),
        dissent: Type.String({ description: "异议（谁、何观点）；无则写「无」" }),
        proposed_edict_title: Type.Optional(Type.String({ description: "建议颁布的诏令标题" })),
        proposed_edict_intent: Type.Optional(Type.String({ description: "建议颁布的诏令旨意（目标、要求）" })),
        confidence: Type.Number({ minimum: 0, maximum: 1, description: "把握程度 0–1" }),
      }),
      async run(p, call) {
        if (!!p.proposed_edict_title !== !!p.proposed_edict_intent) throw new ToolError("proposed_edict_title 与 proposed_edict_intent 须同时填写或同时不填");
        await focusDeliberation(ctx, p.deliberation_id);
        const d = await ctx.hub.councilConclude(p.deliberation_id, {
          ...writeMeta(ctx, call.toolCallId),
          post: postId,
          summary: p.summary,
          dissent: p.dissent,
          proposed_edict: p.proposed_edict_title ? { title: p.proposed_edict_title, intent: p.proposed_edict_intent! } : undefined,
          confidence: p.confidence,
        });
        return ok(`已总结议事 ${d.deliberation.id}，奏请皇帝定夺`, { deliberation_id: d.deliberation.id, state: d.deliberation.state });
      },
    }),

    defineTool({
      name: "propose_edict",
      label: "拟旨奏请",
      description: "向皇帝建议颁布一道诏令（进入待办，照准后才正式颁旨），写清标题、旨意与理由。返回 notification_id。",
      parameters: Type.Object({
        title: Type.String({ description: "诏令标题" }),
        intent: Type.String({ description: "旨意：目标与要求" }),
        rationale: Type.String({ description: "理由与依据" }),
        deliberation_id: Type.Optional(Type.String({ description: "所依据的议事 ID" })),
      }),
      async run(p, call) {
        if (p.deliberation_id) await focusDeliberation(ctx, p.deliberation_id);
        const n = await ctx.hub.proposeEdict({ ...writeMeta(ctx, call.toolCallId), post: postId, title: p.title, intent: p.intent, rationale: p.rationale, deliberation_id: p.deliberation_id });
        return ok(`已奏请颁旨（${n.id}），待皇帝照准`, { notification_id: n.id }, { hint: `如需等批复：wait_for {notification_id: "${n.id}", timeout_seconds: ...}` });
      },
    }),
  ];
}
