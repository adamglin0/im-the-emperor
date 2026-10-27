// 吏部：官员配置（提示词附加段、思考强度、工具组）查看、提议、历史、回滚。
import type { Hono } from "hono";
import {
  effectiveToolGroups,
  ALL_TOOL_GROUPS,
  type Address,
  type ConfigHistoryRow,
  type ConfigProposeReq,
  type ConfigProposeRes,
  type Official,
  type ThinkingLevel,
} from "@court/shared";
import { bad, forbidden, notFound, type HubCtx } from "../ctx.ts";
import { actingAddress, principal, queryInt, readJson, requireTool } from "../auth.ts";
import { controlQuiet } from "../services/doorbell.ts";

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MAX_PROMPT_OVERRIDES = 8000;

export type ConfigChanges = ConfigProposeReq["changes"];

function sameSet(a: string[] = [], b: string[] = []): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((x) => sa.has(x));
}

/** 校验并规范化配置变更 */
export function validateChanges(changes: unknown): ConfigChanges {
  if (!changes || typeof changes !== "object") throw bad("changes 必填：{prompt_overrides?, thinking?, extra_tool_groups?, disabled_tool_groups?}");
  const ch = changes as ConfigChanges;
  const out: ConfigChanges = {};
  if (ch.prompt_overrides !== undefined) {
    if (typeof ch.prompt_overrides !== "string") throw bad("prompt_overrides 必须是字符串");
    if (ch.prompt_overrides.length > MAX_PROMPT_OVERRIDES) throw bad(`prompt_overrides 过长（上限 ${MAX_PROMPT_OVERRIDES} 字）`);
    out.prompt_overrides = ch.prompt_overrides;
  }
  if (ch.thinking !== undefined) {
    if (!THINKING.includes(ch.thinking)) throw bad(`thinking 只能是 ${THINKING.join("/")}`);
    out.thinking = ch.thinking;
  }
  for (const k of ["extra_tool_groups", "disabled_tool_groups"] as const) {
    const v = ch[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) throw bad(`${k} 必须是工具组数组`);
    for (const g of v) if (!(ALL_TOOL_GROUPS as string[]).includes(g)) throw bad(`工具组 ${g} 不存在，可选：${ALL_TOOL_GROUPS.join("/")}`);
    if (k === "disabled_tool_groups" && v.includes("common")) throw bad("common 工具组不能禁用");
    out[k] = [...new Set(v)];
  }
  if (!Object.keys(out).length) throw bad("changes 为空，没有要修改的项");
  return out;
}

/** 是否须皇帝批准：职位敏感，或工具组上限外授予有变化 */
export function configNeedsApproval(ctx: HubCtx, targetPost: string, official: Official, changes: ConfigChanges): boolean {
  if (ctx.registry.post(targetPost)?.approval_sensitive) return true;
  // 授予职位默认之外的新工具组须批；只收回不须批
  if (changes.extra_tool_groups !== undefined && !sameSet(changes.extra_tool_groups, official.extra_tool_groups)) {
    return changes.extra_tool_groups.some((g) => !official.extra_tool_groups.includes(g));
  }
  return false;
}

/** 落实配置变更：写官员、config_history、名册 bump、通知部门热加载 */
export function applyConfig(ctx: HubCtx, officialId: string, changes: ConfigChanges, actor: Address, reason: string): Official {
  const o = ctx.registry.official(officialId);
  if (!o) throw notFound(`官员 ${officialId}`);
  const next: Official = { ...o };
  if (changes.prompt_overrides !== undefined) next.prompt_overrides = changes.prompt_overrides;
  if (changes.thinking !== undefined) next.thinking = changes.thinking;
  if (changes.extra_tool_groups !== undefined) next.extra_tool_groups = changes.extra_tool_groups;
  if (changes.disabled_tool_groups !== undefined) next.disabled_tool_groups = changes.disabled_tool_groups;
  const saved = ctx.registry.saveOfficial(next, actor, reason);
  const post = ctx.registry.postOf(officialId);
  ctx.events.emit({
    type: "config.changed",
    actor,
    subject_type: "official",
    subject_id: officialId,
    summary: `${o.name}${post ? `（${post}）` : ""} 配置更新至 v${saved.config_version}：${reason}`.slice(0, 300),
    data: { changes, post_id: post },
  });
  const dept = post ? ctx.registry.post(post)?.dept : undefined;
  if (dept) setImmediate(() => controlQuiet(ctx, dept, "/control/reload", {}));
  return saved;
}

/** 提议（propose / rollback 共用）：校验权限 → 审批或直接落实 */
export function proposeConfig(ctx: HubCtx, actor: Address, targetPost: string, changes: ConfigChanges, reason: string, label = "配置调整"): ConfigProposeRes {
  if (!ctx.registry.post(targetPost)) throw bad(`职位 ${targetPost} 不存在`);
  const o = ctx.registry.officialOf(targetPost);
  if (!o) throw bad(`职位 ${targetPost} 空缺，无官员可配置`);
  if (actor === `post:${targetPost}`) throw forbidden("官员不得修改自己的配置");
  if (!reason?.trim()) throw bad("reason（理由）必填");
  if (actor.startsWith("post:") && configNeedsApproval(ctx, targetPost, o, changes)) {
    const a = ctx.approvals.request(
      "config_change",
      { target_post: targetPost, official_id: o.official_id, changes, reason, actor },
      actor,
      `${label}：${o.name}（${targetPost}）`,
      `${actor} 申请调整 ${o.name}（${targetPost}）的配置。\n理由：${reason}\n变更：${JSON.stringify(changes, null, 2)}`,
    );
    return { status: "pending_approval", approval_id: a.id };
  }
  return { status: "applied", official: applyConfig(ctx, o.official_id, changes, actor, reason) };
}

export function register(app: Hono, ctx: HubCtx): void {
  ctx.approvals.onApprove("config_change", (a) => {
    const p = a.payload as { official_id: string; changes: ConfigChanges; reason: string; actor: Address };
    applyConfig(ctx, p.official_id, p.changes, p.actor ?? a.requested_by, `${p.reason}（陛下准奏）`);
  });

  app.get("/api/config/history", (c) => {
    const post = c.req.query("post");
    const limit = queryInt(c, "limit", 200, 1, 500);
    const rows = post
      ? ctx.db.all<{ id: number; official_id: string; post_id: string; version: number; snapshot_json: string; actor: string; reason: string; at: number }>(
          "SELECT * FROM config_history WHERE post_id = ? ORDER BY id DESC LIMIT ?",
          post,
          limit,
        )
      : ctx.db.all<{ id: number; official_id: string; post_id: string; version: number; snapshot_json: string; actor: string; reason: string; at: number }>(
          "SELECT * FROM config_history ORDER BY id DESC LIMIT ?",
          limit,
        );
    const out: ConfigHistoryRow[] = rows.map((r) => ({
      id: r.id,
      official_id: r.official_id,
      post_id: r.post_id,
      version: r.version,
      snapshot: JSON.parse(r.snapshot_json) as Official,
      actor: r.actor,
      reason: r.reason,
      at: r.at,
    }));
    return c.json(out);
  });

  app.get("/api/config/:post", (c) => {
    const postId = c.req.param("post");
    const post = ctx.registry.post(postId);
    if (!post) throw notFound(`职位 ${postId}`);
    const official = ctx.registry.officialOf(postId);
    if (!official) throw notFound(`职位 ${postId} 的在任官员（该职位空缺）`);
    return c.json({ official, post, effective_tool_groups: effectiveToolGroups(post, official), system_prompt: ctx.registry.systemPrompt(postId) });
  });

  app.post("/api/config/propose", async (c) => {
    if (principal(c).kind === "gateway") throw forbidden("网关无权修改配置");
    requireTool(c, "config_propose");
    const req = await readJson<ConfigProposeReq>(c);
    const actor = actingAddress(c, req.actor);
    const target = String(req.target_post ?? "").replace(/^post:/, "");
    const changes = validateChanges(req.changes);
    const key = req.idem_key ? `config:${actor}:${req.idem_key}` : undefined;
    return c.json(ctx.idem.wrap(key, () => ctx.db.tx(() => proposeConfig(ctx, actor, target, changes, String(req.reason ?? "")))));
  });

  app.post("/api/config/rollback", async (c) => {
    if (principal(c).kind === "gateway") throw forbidden("网关无权修改配置");
    requireTool(c, "config_rollback");
    const req = await readJson<{ actor?: string; post?: string; version?: number; reason?: string; idem_key?: string }>(c);
    const actor = actingAddress(c, req.actor);
    const target = String(req.post ?? "").replace(/^post:/, "");
    const o = ctx.registry.officialOf(target);
    if (!o) throw bad(`职位 ${target} 不存在或空缺`);
    const version = Math.floor(Number(req.version));
    if (!Number.isFinite(version)) throw bad("version 必填");
    const row = ctx.db.get<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM config_history WHERE official_id = ? AND version = ? ORDER BY id DESC LIMIT 1",
      o.official_id,
      version,
    );
    if (!row) throw notFound(`${o.name} 的配置版本 v${version}`);
    const snap = JSON.parse(row.snapshot_json) as Official;
    const changes: ConfigChanges = {
      prompt_overrides: snap.prompt_overrides ?? "",
      thinking: snap.thinking,
      extra_tool_groups: snap.extra_tool_groups ?? [],
      disabled_tool_groups: snap.disabled_tool_groups ?? [],
    };
    const key = req.idem_key ? `config_rb:${actor}:${req.idem_key}` : undefined;
    const reason = `回滚至 v${version}：${String(req.reason ?? "").trim() || "未说明"}`;
    return c.json(ctx.idem.wrap(key, () => ctx.db.tx(() => proposeConfig(ctx, actor, target, changes, reason, "配置回滚"))));
  });
}
