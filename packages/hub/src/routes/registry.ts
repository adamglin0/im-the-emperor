// 名册、令牌、健康、心跳、状态、模型池。
import type { Hono } from "hono";
import { API_VERSION, type AddModelReq, type ModelCheckRes, type ModelEntry, type ModelsMeta, type OfficialStatus } from "@court/shared";
import { bad, forbidden, invalidState, type HubCtx } from "../ctx.ts";
import { principal, readJson, requireEmperor, requireGateway } from "../auth.ts";
import { gatewayAdmin } from "./providers.ts";

const OPEN_EDICT_EXCLUDE = ["completed", "withdrawn", "failed"];
const OPEN_TASK_EXCLUDE = ["done", "cancelled", "failed"];

export function register(app: Hono, ctx: HubCtx): void {
  app.get("/api/registry", (c) => c.json(ctx.registry.snapshot()));

  app.get("/api/internal/tokens", (c) => {
    requireGateway(c);
    const out: Record<string, string> = {};
    for (const r of ctx.db.all<{ id: string; token: string }>("SELECT id, token FROM depts LIMIT 100")) out[r.token] = r.id;
    return c.json(out);
  });

  app.get("/api/health", (c) => {
    const now = ctx.now();
    const lag = ctx.db.all<{ post_id: string; lag: number }>(
      "SELECT post_id, (next_seq - 1 - acked_seq) AS lag FROM inbox_cursors WHERE next_seq - 1 > acked_seq ORDER BY lag DESC LIMIT 5",
    );
    const ph = (xs: string[]) => xs.map(() => "?").join(",");
    const oldestEdict = ctx.db.get<{ t: number | null }>(`SELECT MIN(created_at) AS t FROM edicts WHERE state NOT IN (${ph(OPEN_EDICT_EXCLUDE)})`, ...OPEN_EDICT_EXCLUDE)?.t;
    const oldestTask = ctx.db.get<{ t: number | null }>(`SELECT MIN(created_at) AS t FROM tasks WHERE state NOT IN (${ph(OPEN_TASK_EXCLUDE)})`, ...OPEN_TASK_EXCLUDE)?.t;
    const burn = ctx.db.get<{ t: number | null; c: number | null; n: number; e: number | null }>(
      "SELECT SUM(total_tokens) AS t, SUM(cost) AS c, COUNT(*) AS n, SUM(CASE WHEN json_extract(data_json, '$.ok') = 0 THEN 1 ELSE 0 END) AS e FROM ledger WHERE ts > ?",
      now - 3600_000,
    )!;
    return c.json({
      ok: true,
      role: "hub",
      version: API_VERSION,
      details: {
        outbox: "n/a",
        halted: ctx.registry.isHalted(),
        registry_version: ctx.registry.version(),
        delivery_lag: lag,
        oldest_open_edict_age_ms: oldestEdict ? now - oldestEdict : null,
        oldest_open_task_age_ms: oldestTask ? now - oldestTask : null,
        tokens_last_hour: burn.t ?? 0,
        cost_last_hour: burn.c ?? 0,
        llm_calls_last_hour: burn.n,
        llm_error_rate_last_hour: burn.n ? (burn.e ?? 0) / burn.n : 0,
        depts: ctx.doorbell.deptHealth(),
      },
    });
  });

  app.post("/api/heartbeat", async (c) => {
    const p = principal(c);
    if (p.kind === "gateway") throw forbidden("网关不发心跳");
    const body = await readJson<{ statuses?: OfficialStatus[] }>(c);
    const list = body.statuses ?? [];
    if (!Array.isArray(list)) throw bad("statuses 必须是数组");
    if (list.length > 200) throw bad("statuses 过多（上限 200）");
    const now = ctx.now();
    const changed: { post_id: string; dept: string; from?: string; to: string; status_text?: string }[] = [];
    ctx.db.tx(() => {
      for (const s of list) {
        if (!s || typeof s.post_id !== "string") continue;
        const def = ctx.registry.post(s.post_id);
        if (!def) continue;
        if (p.kind === "dept" && def.dept !== p.dept) continue; // 只接受本部门职位
        const st: OfficialStatus = { ...s, dept: def.dept, updated_at: now };
        const prev = ctx.db.getJson<OfficialStatus>("SELECT data_json FROM statuses WHERE post_id = ?", s.post_id);
        if (prev?.state !== s.state) changed.push({ post_id: s.post_id, dept: def.dept, from: prev?.state, to: s.state, status_text: s.status_text });
        ctx.db.run(
          "INSERT INTO statuses (post_id, dept, updated_at, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET dept = excluded.dept, updated_at = excluded.updated_at, data_json = excluded.data_json",
          s.post_id,
          def.dept,
          now,
          JSON.stringify(st),
        );
      }
      if (p.kind === "dept" && p.dept) ctx.doorbell.markSeen(p.dept);
    });
    // 状态变化：只推 SSE，不入库（心跳频繁，事件表不留痕）
    for (const ch of changed) {
      ctx.events.publish({
        type: "status.changed",
        actor: `post:${ch.post_id}`,
        dept: ch.dept,
        summary: `${ch.post_id}：${ch.from ?? "—"} → ${ch.to}${ch.status_text ? `（${ch.status_text.slice(0, 80)}）` : ""}`,
        data: { from: ch.from ?? null, to: ch.to, status_text: ch.status_text ?? null },
      });
    }
    return c.json({ ok: true as const, halted: ctx.registry.isHalted(), registry_version: ctx.registry.version() });
  });

  app.get("/api/statuses", (c) => c.json(ctx.statuses()));

  app.get("/api/models", (c) => c.json(ctx.registry.models()));

  // 模型池元数据：任命门槛、各部门适配权重、默认/阅卷模型（config/models.yaml）
  app.get("/api/models/meta", (c) => {
    const m = ctx.modelsCfg;
    return c.json({
      default_model: m.default_model,
      grader_model: m.grader_model,
      fitness_threshold: m.fitness_threshold,
      fitness_weights: (m.fitness_weights ?? {}) as Record<string, Record<string, number>>,
    } satisfies ModelsMeta);
  });

  app.post("/api/models", async (c) => {
    requireEmperor(c);
    const r = await readJson<AddModelReq>(c);
    const provider = String(r.provider ?? "").trim();
    const model_id = String(r.model_id ?? "").trim();
    if (!provider || !model_id) throw bad("provider 与 model_id 必填");
    if (!/^[\w.@:-]+$/.test(provider) || /\s/.test(model_id)) throw bad("provider/model_id 含非法字符");
    const key = `${provider}/${model_id}`;
    const prev = ctx.registry.model(key);
    if (prev && prev.status !== "retired") throw invalidState(`模型 ${key} 已在池中（${prev.status}）`);
    // 网关是模型表的唯一真相：不认得的 provider/model 不入池（网关暂不可达时放行，科举时自会报错）
    let check: ModelCheckRes | undefined;
    try {
      check = await gatewayAdmin(ctx, 3000).adminCheckModel(provider, model_id);
    } catch {
      check = undefined;
    }
    if (check && !check.ok) throw bad(check.reason ?? `网关不认得 ${key}`);
    const m: ModelEntry = { key, provider, model_id, name: String(r.name ?? "").trim() || check?.model?.name || model_id, status: "candidate", added_at: ctx.now() };
    if (r.api) m.api = String(r.api);
    if (r.base_url) m.base_url = String(r.base_url);
    if (r.context_window == null && check?.model?.context_window) m.context_window = check.model.context_window;
    if (r.context_window != null) {
      const cw = Math.floor(Number(r.context_window));
      if (!Number.isFinite(cw) || cw <= 0) throw bad("context_window 必须是正整数");
      m.context_window = cw;
    }
    if (r.notes) m.notes = String(r.notes).slice(0, 2000);
    ctx.registry.saveModel(m);
    ctx.events.emit({ type: "model.added", actor: "emperor", subject_type: "model", subject_id: key, summary: `陛下增补模型 ${m.name}（${key}），待科举` });
    // 自动排考（科举服务存在时）
    try {
      ctx.exams?.start?.(key, "emperor");
    } catch (e) {
      ctx.events.emit({ type: "exam.start_failed", actor: "system:hub", subject_type: "model", subject_id: key, summary: `自动排考失败：${(e as Error).message}`.slice(0, 300) });
    }
    return c.json(ctx.registry.model(key) ?? m);
  });
}
