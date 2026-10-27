// 户部人事：任命、调动、罢免、换模型、新增官员；人事记录；空缺职位。
import { randomInt } from "node:crypto";
import type { Hono } from "hono";
import { newId, type Address, type Official, type PersonnelReq, type PersonnelRes, type PostDef } from "@court/shared";
import { bad, forbidden, invalidState, notFound, type HubCtx } from "../ctx.ts";
import { actingAddress, principal, queryInt, readJson, requireTool } from "../auth.ts";
import { controlQuiet } from "../services/doorbell.ts";

type Action = PersonnelReq["action"];
const ACTION_TOOL: Record<Action, string> = {
  appoint: "personnel_appoint",
  transfer: "personnel_transfer",
  dismiss: "personnel_dismiss",
  set_model: "personnel_set_model",
  new_official: "personnel_new_official",
};
const ACTION_LABEL: Record<Action, string> = { appoint: "任命", transfer: "调任", dismiss: "罢免", set_model: "换模型", new_official: "新增官员" };

const SURNAMES = "李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文";
const GIVEN = "元景思敬文德仁弘守道知明玄贞士宗安节延庆承令嗣怀行俭方正徽崇礼义温良恭让敏昭晦远";

export function genTangName(): string {
  const s = SURNAMES[randomInt(SURNAMES.length)];
  const n = randomInt(2) ? 2 : 1;
  let g = "";
  for (let i = 0; i < n; i++) g += GIVEN[randomInt(GIVEN.length)];
  return s + g;
}

interface Plan {
  action: Action;
  official_id?: string;
  /** 涉及的职位（目标职位、原职位） */
  posts: string[];
  model?: string;
  name?: string;
}

function vacant(ctx: HubCtx, postId: string): PostDef {
  const p = ctx.registry.post(postId);
  if (!p) throw bad(`职位 ${postId} 不存在`);
  if (ctx.registry.officialOf(postId)) throw invalidState(`职位 ${postId} 已有人在任，请先调离或罢免`);
  return p;
}

/** 校验请求，得出涉及的职位与模型 */
export function planPersonnel(ctx: HubCtx, req: PersonnelReq): Plan {
  switch (req.action) {
    case "appoint": {
      const o = ctx.registry.official(req.official_id);
      if (!o) throw notFound(`官员 ${req.official_id}`);
      const cur = ctx.registry.postOf(o.official_id);
      if (cur) throw invalidState(`${o.name} 现任 ${cur}，请用 transfer 调任`);
      vacant(ctx, req.post_id);
      return { action: "appoint", official_id: o.official_id, posts: [req.post_id], model: o.model };
    }
    case "transfer": {
      const o = ctx.registry.official(req.official_id);
      if (!o) throw notFound(`官员 ${req.official_id}`);
      if (o.status === "dismissed") throw invalidState(`${o.name} 已罢免，请用 appoint 重新任命`);
      const cur = ctx.registry.postOf(o.official_id);
      if (!cur) throw invalidState(`${o.name} 目前无职，请用 appoint 任命`);
      if (cur === req.to_post_id) throw bad(`${o.name} 已在 ${cur}`);
      vacant(ctx, req.to_post_id);
      return { action: "transfer", official_id: o.official_id, posts: [req.to_post_id, cur], model: o.model };
    }
    case "dismiss": {
      const o = ctx.registry.official(req.official_id);
      if (!o) throw notFound(`官员 ${req.official_id}`);
      if (o.status === "dismissed") throw invalidState(`${o.name} 已经罢免`);
      const cur = ctx.registry.postOf(o.official_id);
      return { action: "dismiss", official_id: o.official_id, posts: cur ? [cur] : [] };
    }
    case "set_model": {
      const o = ctx.registry.official(req.official_id);
      if (!o) throw notFound(`官员 ${req.official_id}`);
      const m = ctx.registry.model(req.model);
      if (!m) throw bad(`模型 ${req.model} 不在模型池中`);
      if (m.status === "retired" || m.status === "failed") throw bad(`模型 ${req.model} 状态为 ${m.status}，不可任用`);
      if (o.model === req.model) throw bad(`${o.name} 已在使用 ${req.model}`);
      const cur = ctx.registry.postOf(o.official_id);
      return { action: "set_model", official_id: o.official_id, posts: cur ? [cur] : [], model: req.model };
    }
    case "new_official": {
      vacant(ctx, req.post_id);
      const m = ctx.registry.model(req.model);
      if (!m) throw bad(`模型 ${req.model} 不在模型池中`);
      if (m.status === "retired" || m.status === "failed") throw bad(`模型 ${req.model} 状态为 ${m.status}，不可任用`);
      const name = String(req.name ?? "").trim().slice(0, 20) || genTangName();
      return { action: "new_official", posts: [req.post_id], model: req.model, name };
    }
    default:
      throw bad("action 只能是 appoint/transfer/dismiss/set_model/new_official");
  }
}

/** 是否须皇帝批准 */
export function personnelNeedsApproval(ctx: HubCtx, plan: Plan): string | undefined {
  if (plan.action === "dismiss" || plan.action === "new_official") return `${ACTION_LABEL[plan.action]}须陛下批准`;
  for (const p of plan.posts) if (ctx.registry.post(p)?.approval_sensitive) return `涉及敏感职位 ${p}`;
  if ((plan.action === "set_model" || plan.action === "appoint" || plan.action === "transfer") && plan.model) {
    const m = ctx.registry.model(plan.model);
    if (!m || m.status !== "examined") return `模型 ${plan.model} 尚未通过科举（${m?.status ?? "未知"}）`;
    const dept = ctx.registry.post(plan.posts[0])?.dept;
    const fit = dept ? m.fitness?.[dept as keyof typeof m.fitness] : undefined;
    // 未评适配度的已考模型视为达标（如名册默认模型）
    if (fit !== undefined && fit < ctx.modelsCfg.fitness_threshold) return `模型 ${plan.model} 对 ${dept} 适配度 ${fit} 低于门槛 ${ctx.modelsCfg.fitness_threshold}`;
  }
  return undefined;
}

function history(ctx: HubCtx, actor: Address, action: string, officialId: string | undefined, postId: string | undefined, detail: string): void {
  ctx.db.run(
    "INSERT INTO appointment_history (at, actor, action, official_id, post_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
    ctx.now(),
    actor,
    action,
    officialId ?? null,
    postId ?? null,
    detail,
  );
}

/** 落实人事（重新校验现状，防止审批期间情况变化） */
export function applyPersonnel(ctx: HubCtx, req: PersonnelReq, actor: Address): void {
  const plan = planPersonnel(ctx, req);
  const now = ctx.now();
  const reason = req.reason ?? "";
  const affectedDepts = new Set<string>();
  ctx.db.tx(() => {
    switch (req.action) {
      case "appoint": {
        const o = ctx.registry.official(req.official_id)!;
        ctx.db.run("INSERT INTO appointments (post_id, official_id, since) VALUES (?, ?, ?)", req.post_id, o.official_id, now);
        if (o.status !== "active") ctx.db.run("UPDATE officials SET data_json = ? WHERE official_id = ?", JSON.stringify({ ...o, status: "active" }), o.official_id);
        history(ctx, actor, "appoint", o.official_id, req.post_id, `${o.name} 任 ${req.post_id}。${reason}`);
        break;
      }
      case "transfer": {
        const o = ctx.registry.official(req.official_id)!;
        const from = plan.posts[1];
        ctx.db.run("DELETE FROM appointments WHERE official_id = ?", o.official_id);
        ctx.db.run("INSERT INTO appointments (post_id, official_id, since) VALUES (?, ?, ?)", req.to_post_id, o.official_id, now);
        history(ctx, actor, "transfer", o.official_id, req.to_post_id, `${o.name} 由 ${from} 调任 ${req.to_post_id}。${reason}`);
        break;
      }
      case "dismiss": {
        const o = ctx.registry.official(req.official_id)!;
        ctx.db.run("DELETE FROM appointments WHERE official_id = ?", o.official_id);
        ctx.db.run("UPDATE officials SET data_json = ? WHERE official_id = ?", JSON.stringify({ ...o, status: "dismissed" }), o.official_id);
        history(ctx, actor, "dismiss", o.official_id, plan.posts[0], `罢免 ${o.name}${plan.posts[0] ? `（原任 ${plan.posts[0]}）` : ""}。${reason}`);
        break;
      }
      case "set_model": {
        const o = ctx.registry.official(req.official_id)!;
        ctx.registry.saveOfficial({ ...o, model: req.model }, actor, `换模型 ${o.model} → ${req.model}：${reason}`);
        history(ctx, actor, "set_model", o.official_id, plan.posts[0], `${o.name} 模型 ${o.model} → ${req.model}。${reason}`);
        break;
      }
      case "new_official": {
        const o: Official = {
          official_id: newId("of"),
          name: plan.name!,
          model: req.model,
          thinking: "low",
          prompt_overrides: "",
          extra_tool_groups: [],
          disabled_tool_groups: [],
          status: "active",
          config_version: 1,
          created_at: now,
        };
        ctx.db.run("INSERT INTO officials (official_id, data_json) VALUES (?, ?)", o.official_id, JSON.stringify(o));
        ctx.db.run("INSERT INTO appointments (post_id, official_id, since) VALUES (?, ?, ?)", req.post_id, o.official_id, now);
        ctx.db.run(
          "INSERT INTO config_history (official_id, post_id, version, snapshot_json, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          o.official_id,
          req.post_id,
          1,
          JSON.stringify(o),
          actor,
          `新任：${reason}`,
          now,
        );
        history(ctx, actor, "new_official", o.official_id, req.post_id, `新增官员 ${o.name}（${req.model}）任 ${req.post_id}。${reason}`);
        break;
      }
    }
    for (const p of plan.posts) {
      const d = ctx.registry.post(p)?.dept;
      if (d) affectedDepts.add(d);
    }
    if (req.action !== "set_model") ctx.registry.bump(`人事：${ACTION_LABEL[req.action]}`);
    ctx.events.emit({
      type: `personnel.${req.action}`,
      actor,
      subject_type: "official",
      subject_id: plan.official_id,
      summary: `人事${ACTION_LABEL[req.action]}：${plan.posts.join(" ← ")}${reason ? `（${reason}）` : ""}`.slice(0, 300),
      data: { request: req },
    });
  });
  setImmediate(() => {
    for (const d of affectedDepts) controlQuiet(ctx, d, "/control/reload", {});
  });
}

export function register(app: Hono, ctx: HubCtx): void {
  ctx.approvals.onApprove("personnel", (a) => applyPersonnel(ctx, a.payload.request as PersonnelReq, a.requested_by));
  ctx.approvals.onApprove("new_official", (a) => applyPersonnel(ctx, a.payload.request as PersonnelReq, a.requested_by));

  app.post("/api/personnel", async (c) => {
    if (principal(c).kind === "gateway") throw forbidden("网关无权办理人事");
    const req = await readJson<PersonnelReq>(c);
    const tool = ACTION_TOOL[req.action as Action];
    if (!tool) throw bad("action 只能是 appoint/transfer/dismiss/set_model/new_official");
    requireTool(c, tool);
    const actor = actingAddress(c, req.actor);
    if (!String(req.reason ?? "").trim()) throw bad("reason（理由）必填");
    const key = req.idem_key ? `personnel:${actor}:${req.idem_key}` : undefined;
    const res = ctx.idem.wrap(key, (): PersonnelRes =>
      ctx.db.tx(() => {
        const plan = planPersonnel(ctx, req);
        if (actor.startsWith("post:")) {
          const self = ctx.registry.officialOf(actor.slice(5));
          if (self && plan.official_id === self.official_id) throw forbidden("官员不得办理自己的人事");
          const why = personnelNeedsApproval(ctx, plan);
          if (why) {
            const a = ctx.approvals.request(
              req.action === "new_official" ? "new_official" : "personnel",
              { request: { ...req, actor } },
              actor,
              `人事${ACTION_LABEL[req.action]}：${plan.posts.join("、") || plan.official_id}`,
              `${actor} 申请${ACTION_LABEL[req.action]}（${why}）。\n理由：${req.reason}\n详情：${JSON.stringify(req)}`,
            );
            return { status: "pending_approval", approval_id: a.id };
          }
        }
        applyPersonnel(ctx, req, actor);
        return { status: "applied" };
      }),
    );
    return c.json(res);
  });

  app.get("/api/personnel/history", (c) => {
    const limit = queryInt(c, "limit", 200, 1, 500);
    return c.json(
      ctx.db.all<{ at: number; actor: string; action: string; detail: string; official_id: string | null; post_id: string | null }>(
        "SELECT at, actor, action, detail, official_id, post_id FROM appointment_history ORDER BY id DESC LIMIT ?",
        limit,
      ),
    );
  });

  app.get("/api/posts/vacancies", (c) => c.json(ctx.registry.posts().filter((p) => !ctx.registry.officialOf(p.post_id))));
}
