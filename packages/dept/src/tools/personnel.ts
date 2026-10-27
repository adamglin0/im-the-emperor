// 户部·人事工具（任免调迁、换模型）
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PersonnelReq, PersonnelRes } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { defineTool, fail, fmtTime, ok, resolveOfficialId, resolvePost, selfAddr, snip, writeMeta } from "./_util.ts";

const SENSITIVE_NOTE = "调动宰相/御史/给事中、新增/罢免官员、更换模型等敏感事项须皇帝批准（返回 pending_approval，批复后通知你）。更换模型须科举适配度达标。";

function result(r: PersonnelRes, what: string) {
  return r.status === "applied"
    ? ok(`${what}已生效`, r)
    : ok(`${what}已提交皇帝审批（approval_id ${r.approval_id}）`, r, { hint: "审批结果会通知你；勿重复提交。" });
}

export function personnelTools(ctx: ToolContext): AgentTool<any>[] {
  const self = selfAddr(ctx);
  const send = async (toolCallId: string, action: PersonnelReq, what: string) => {
    const r = await ctx.hub.personnel({ ...writeMeta(ctx, toolCallId), ...action });
    ctx.log("personnel", { action: action.action, reason: action.reason, status: r.status });
    return result(r, what);
  };
  const OFFICIAL = Type.String({ description: "official_id（也可写官员姓名或其现任职位 ID）" });
  return [
    defineTool({
      name: "personnel_appoint",
      label: "任命",
      description: `任命一位（未在任的）官员到某个空缺职位。${SENSITIVE_NOTE}`,
      parameters: Type.Object({
        official_id: OFFICIAL,
        post_id: Type.String({ description: "目标职位 ID（须缺员，见 post_vacancies）" }),
        reason: Type.String({ description: "理由" }),
      }),
      async run(p, call) {
        const oid = resolveOfficialId(ctx, p.official_id);
        const post = resolvePost(ctx, p.post_id).post_id;
        return send(call.toolCallId, { actor: self, reason: p.reason, action: "appoint", official_id: oid, post_id: post }, `任命 ${oid} 为 ${post}`);
      },
    }),

    defineTool({
      name: "personnel_transfer",
      label: "调岗",
      description: `把官员调到另一职位（原职位当前轮结束后停止，记忆与会话随人走）。${SENSITIVE_NOTE}`,
      parameters: Type.Object({
        official_id: OFFICIAL,
        to_post_id: Type.String({ description: "新职位 ID" }),
        reason: Type.String({ description: "理由" }),
      }),
      async run(p, call) {
        const oid = resolveOfficialId(ctx, p.official_id);
        const post = resolvePost(ctx, p.to_post_id).post_id;
        return send(call.toolCallId, { actor: self, reason: p.reason, action: "transfer", official_id: oid, to_post_id: post }, `调 ${oid} 至 ${post}`);
      },
    }),

    defineTool({
      name: "personnel_dismiss",
      label: "罢免",
      description: `罢免官员（职位转为缺员）。${SENSITIVE_NOTE}须有充分理由（如弹劾成立、考课下等）。`,
      parameters: Type.Object({ official_id: OFFICIAL, reason: Type.String({ description: "理由" }) }),
      async run(p, call) {
        const oid = resolveOfficialId(ctx, p.official_id);
        return send(call.toolCallId, { actor: self, reason: p.reason, action: "dismiss", official_id: oid }, `罢免 ${oid}`);
      },
    }),

    defineTool({
      name: "personnel_set_model",
      label: "换模型",
      description: `为官员更换所用模型（模型键 provider/model_id，须在模型池中且科举适配度达标）。${SENSITIVE_NOTE}`,
      parameters: Type.Object({
        official_id: OFFICIAL,
        model: Type.String({ description: "模型键 provider/model_id（见 exam_list_models 或名册）" }),
        reason: Type.String({ description: "理由（如考课结果、成本）" }),
      }),
      async run(p, call) {
        const oid = resolveOfficialId(ctx, p.official_id);
        const known = ctx.registry().models;
        if (known.length && !known.some((m) => m.key === p.model)) {
          return fail(`模型池中没有 ${p.model}`, "请从下列模型中选择（或先由皇帝加入模型池并经科举）。", known.map((m) => ({ key: m.key, status: m.status })));
        }
        return send(call.toolCallId, { actor: self, reason: p.reason, action: "set_model", official_id: oid, model: p.model }, `为 ${oid} 换用 ${p.model}`);
      },
    }),

    defineTool({
      name: "personnel_new_official",
      label: "新补官员",
      description: `为缺员职位新补一位官员（生成新 persona，指定模型，姓名可选）。${SENSITIVE_NOTE}`,
      parameters: Type.Object({
        post_id: Type.String({ description: "职位 ID（须缺员）" }),
        model: Type.String({ description: "模型键 provider/model_id" }),
        name: Type.Optional(Type.String({ description: "唐风姓名（虚构，不用真实历史人物），不填自动生成" })),
        reason: Type.String({ description: "理由" }),
      }),
      async run(p, call) {
        const post = resolvePost(ctx, p.post_id).post_id;
        return send(call.toolCallId, { actor: self, reason: p.reason, action: "new_official", post_id: post, model: p.model, name: p.name }, `为 ${post} 新补官员`);
      },
    }),

    defineTool({
      name: "post_vacancies",
      label: "缺员一览",
      description: "列出当前缺员（无在任官员）的职位：职位 ID、部门、职衔、品阶。任命或新补官员前先查，缺员职位的职责由部门路由给同僚代办。",
      parameters: Type.Object({}),
      async run() {
        const list = await ctx.hub.vacancies();
        return ok(`缺员职位 ${list.length} 个`, list.map((p) => ({ post: p.post_id, dept: p.dept, title: p.title, rank: p.rank })));
      },
    }),

    defineTool({
      name: "personnel_history",
      label: "人事沿革",
      description: "查看人事变动历史（任命、调岗、罢免、换模型）：时间、操作者、动作、详情，最新在后。用于核查任免依据与沿革。",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "最多条数，默认 30" })),
      }),
      async run(p) {
        // hub 返回最新在前；统一按时间升序后取最近 limit 条（最新在后）
        const rows = [...(await ctx.hub.personnelHistory())].sort((a, b) => a.at - b.at);
        const list = rows.slice(-(p.limit ?? 30)).map((r) => ({ at: fmtTime(r.at), actor: r.actor, action: r.action, detail: snip(r.detail, 200) }));
        return ok(`人事记录 ${rows.length} 条，显示最近 ${list.length} 条`, list);
      },
    }),
  ];
}
