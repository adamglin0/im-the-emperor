// 定时任务：校验、审批、调度 tick（未处理跳过、宕机补一次、抖动）、手动触发、默认播种。
import { Cron } from "croner";
import {
  LIMITS,
  TZ,
  newId,
  type Address,
  type CreateScheduleReq,
  type Schedule,
  type ScheduleRun,
  type ScheduleSpec,
  type UpdateScheduleReq,
} from "@court/shared";
import { bad, forbidden, notFound, type HubCtx, type ScheduleService } from "../ctx.ts";
import type { MessageServiceExt } from "./messages.ts";
import type { ApprovalServiceExt } from "./approvals.ts";

const MAX_JITTER_SECONDS = 3600;
const MAX_PAYLOAD = 4000;
/** 到期时间落后当前超过此值视为宕机/休眠后的补跑 */
const CATCHUP_THRESHOLD_MS = 60_000;
const SEED_JITTER_SECONDS = 120;

export interface ScheduleServiceExt extends ScheduleService {
  get(id: string): Schedule | undefined;
  list(owner?: Address, limit?: number): Schedule[];
  update(id: string, req: UpdateScheduleReq): Schedule;
  remove(id: string, actor: Address): void;
  trigger(id: string, actor: Address): ScheduleRun;
  runs(id: string, limit?: number): ScheduleRun[];
  /** 规则的最小间隔（秒）；at 为 Infinity */
  intervalSeconds(spec: ScheduleSpec, tz?: string): number;
  /** 下次触发时间（不含抖动），无则 undefined */
  nextOccurrence(spec: ScheduleSpec, after: number, tz?: string): number | undefined;
}

function cronOf(pattern: string, tz: string): Cron {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) throw bad(`cron 必须是 5 段（分 时 日 月 周），收到「${pattern}」`);
  try {
    return new Cron(pattern.trim(), { timezone: tz, paused: true });
  } catch (e) {
    throw bad(`cron 表达式无效「${pattern}」：${(e as Error).message}`);
  }
}

function validateSpec(spec: unknown): ScheduleSpec {
  if (!spec || typeof spec !== "object") throw bad("spec 必填：{cron} / {every_seconds} / {at}");
  const s = spec as ScheduleSpec;
  const given = [s.cron != null, s.every_seconds != null, s.at != null].filter(Boolean).length;
  if (given !== 1) throw bad("spec 必须且只能给 cron / every_seconds / at 其中之一");
  if (s.cron != null) {
    if (typeof s.cron !== "string") throw bad("cron 必须是字符串");
    return { cron: s.cron.trim() };
  }
  if (s.every_seconds != null) {
    const n = Number(s.every_seconds);
    if (!Number.isFinite(n) || n <= 0) throw bad("every_seconds 必须是正数");
    return { every_seconds: Math.floor(n) };
  }
  const at = Number(s.at);
  if (!Number.isFinite(at) || at <= 0) throw bad("at 必须是 epoch 毫秒时间戳");
  return { at };
}

export function createSchedules(ctx: HubCtx): ScheduleServiceExt {
  const messages = () => ctx.messages as MessageServiceExt;

  function getS(id: string): Schedule | undefined {
    return ctx.db.getJson<Schedule>("SELECT data_json FROM schedules WHERE id = ?", id);
  }
  function save(s: Schedule): void {
    ctx.db.run(
      `INSERT INTO schedules (id, owner, status, enabled, next_run_at, data_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, status = excluded.status, enabled = excluded.enabled,
         next_run_at = excluded.next_run_at, data_json = excluded.data_json`,
      s.id,
      s.owner,
      s.status,
      s.enabled ? 1 : 0,
      s.next_run_at ?? null,
      JSON.stringify(s),
    );
  }

  function nextOccurrence(spec: ScheduleSpec, after: number, tz = TZ): number | undefined {
    if (spec.cron) return cronOf(spec.cron, tz).nextRun(new Date(after))?.getTime();
    if (spec.every_seconds) return after + spec.every_seconds * 1000;
    if (spec.at) return spec.at > after ? spec.at : undefined;
    return undefined;
  }

  function intervalSeconds(spec: ScheduleSpec, tz = TZ): number {
    if (spec.cron) {
      const runs = cronOf(spec.cron, tz).nextRuns(3, new Date(ctx.now()));
      if (runs.length < 2) return Infinity;
      let min = Infinity;
      for (let i = 1; i < runs.length; i++) min = Math.min(min, (runs[i].getTime() - runs[i - 1].getTime()) / 1000);
      return min;
    }
    if (spec.every_seconds) return spec.every_seconds;
    return Infinity;
  }

  /** 计算下次运行（含抖动）；无下次则 undefined */
  function computeNext(s: Schedule, after: number): number | undefined {
    const base = nextOccurrence(s.spec, after, s.tz);
    if (base === undefined) return undefined;
    if (s.expires_at && base >= s.expires_at) return undefined;
    const jitter = s.spec.at ? 0 : Math.floor(Math.random() * (s.jitter_seconds * 1000 + 1));
    return base + jitter;
  }

  function refreshNext(s: Schedule): Schedule {
    const now = ctx.now();
    if (s.status === "active" && s.enabled) {
      const next = computeNext(s, now);
      if (next === undefined) {
        s.next_run_at = undefined;
        if (s.spec.at || s.expires_at) s.status = "expired";
      } else s.next_run_at = next;
    } else {
      s.next_run_at = undefined;
    }
    if (s.next_run_at === undefined) delete s.next_run_at;
    return s;
  }

  /** 官员只能管理自己或本部门的定时任务；皇帝与系统不限 */
  function assertOwnerAuthority(actor: Address, owner: Address): void {
    if (actor === "emperor" || actor.startsWith("system:")) return;
    if (!actor.startsWith("post:")) throw forbidden(`actor ${actor} 无权管理定时任务`);
    const post = ctx.registry.post(actor.slice(5));
    if (!post) throw bad(`actor ${actor} 不存在`);
    if (owner === actor || owner === `dept:${post.dept}`) return;
    throw forbidden(`只能管理本人（${actor}）或本部门（dept:${post.dept}）的定时任务`);
  }

  function validateOwner(owner: unknown): Address {
    if (typeof owner !== "string") throw bad("owner 必须是 post:<职位> 或 dept:<部门>");
    if (owner.startsWith("post:") && ctx.registry.post(owner.slice(5))) return owner;
    if (owner.startsWith("dept:") && ctx.registry.dept(owner.slice(5))) return owner;
    throw bad(`owner「${owner}」无效，应为 post:<职位> 或 dept:<部门>`);
  }

  function checkInterval(spec: ScheduleSpec, tz: string): number {
    const iv = intervalSeconds(spec, tz);
    if (iv < LIMITS.scheduleMinIntervalSeconds) {
      throw bad(`触发间隔 ${Math.round(iv)} 秒过短，最小 ${LIMITS.scheduleMinIntervalSeconds} 秒（5 分钟）`);
    }
    if (spec.at && spec.at <= ctx.now()) throw bad("at 时间已过，请给将来的时间");
    return iv;
  }

  function needsApproval(actor: Address, iv: number): boolean {
    return actor.startsWith("post:") && iv < LIMITS.scheduleApprovalBelowSeconds;
  }

  function requestApproval(s: Schedule, actor: Address, iv: number): void {
    ctx.approvals.request(
      "schedule",
      { schedule_id: s.id },
      actor,
      `高频定时任务：${s.title}`,
      `${actor} 为 ${s.owner} 设定定时任务「${s.title}」，间隔约 ${Math.round(iv / 60)} 分钟（低于 ${LIMITS.scheduleApprovalBelowSeconds / 60} 分钟须批准）。\n规则：${JSON.stringify(s.spec)}\n内容：${s.payload.slice(0, 500)}`,
    );
  }

  /** 上一次触发的消息是否尚未被处理（收件人 acked_seq 未越过其 seq） */
  function previousUnhandled(s: Schedule): boolean {
    const last = ctx.db.getJson<ScheduleRun>(
      "SELECT data_json FROM schedule_runs WHERE schedule_id = ? AND json_extract(data_json, '$.message_id') IS NOT NULL ORDER BY scheduled_at DESC LIMIT 1",
      s.id,
    );
    if (!last?.message_id) return false;
    const d = ctx.db.get<{ post_id: string; seq: number }>("SELECT post_id, seq FROM deliveries WHERE message_id = ? AND role = 'to' LIMIT 1", last.message_id);
    if (!d) return false;
    return d.seq > ctx.messages.ackedSeq(d.post_id);
  }

  function fire(s: Schedule, scheduledAt: number, outcome: ScheduleRun["outcome"]): ScheduleRun | undefined {
    // (schedule_id, scheduled_at) 唯一：已触发过则不重复投递
    if (ctx.db.get("SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND scheduled_at = ?", s.id, scheduledAt)) return undefined;
    const now = ctx.now();
    const trace_id = newId("tr");
    const span_id = ctx.events.span({
      trace_id,
      kind: "schedule",
      name: s.title,
      actor: "system:scheduler",
      status: "ok",
      started_at: now,
      ended_at: now,
      attrs: { schedule_id: s.id, owner: s.owner, outcome },
    });
    const res = messages().sendWith(
      {
        from: "system:scheduler",
        to: s.owner,
        kind: "schedule",
        subject: s.title,
        body: s.payload,
        trace_id,
        parent_span_id: span_id,
        meta: { schedule_id: s.id, outcome },
      },
      undefined,
      { allowVacant: true },
    );
    const run: ScheduleRun = { id: newId("sr"), schedule_id: s.id, scheduled_at: scheduledAt, fired_at: now, message_id: res.message.id, trace_id, outcome };
    ctx.db.run("INSERT INTO schedule_runs (id, schedule_id, scheduled_at, data_json) VALUES (?, ?, ?, ?)", run.id, s.id, scheduledAt, JSON.stringify(run));
    ctx.events.emit({
      type: "schedule.fired",
      actor: "system:scheduler",
      trace_id,
      span_id,
      subject_type: "schedule",
      subject_id: s.id,
      summary: `定时任务「${s.title}」触发 → ${s.owner}${outcome === "catchup" ? "（补跑）" : outcome === "manual" ? "（手动）" : ""}`,
      data: { outcome, message_id: res.message.id, routed_to: res.routed_to },
    });
    return run;
  }

  const self: ScheduleServiceExt = {
    create(req: CreateScheduleReq): Schedule {
      if (!req || typeof req !== "object") throw bad("请求体缺失");
      const actor = req.actor;
      if (typeof actor !== "string" || !actor) throw bad("actor 不能为空");
      const owner = validateOwner(req.owner);
      assertOwnerAuthority(actor, owner);
      const title = String(req.title ?? "").trim();
      if (!title) throw bad("title 不能为空");
      if (title.length > 100) throw bad("title 过长（上限 100 字）");
      const payload = String(req.payload ?? "");
      if (payload.length > MAX_PAYLOAD) throw bad(`payload 过长（上限 ${MAX_PAYLOAD} 字）`);
      const tz = req.tz || TZ;
      const spec = validateSpec(req.spec);
      const jitter = Math.floor(Number(req.jitter_seconds ?? 0));
      if (!Number.isFinite(jitter) || jitter < 0 || jitter > MAX_JITTER_SECONDS) throw bad(`jitter_seconds 应在 0..${MAX_JITTER_SECONDS}`);
      if (req.expires_at != null && (!Number.isFinite(Number(req.expires_at)) || Number(req.expires_at) <= ctx.now())) throw bad("expires_at 必须是将来的时间戳");

      return ctx.idem.wrap(req.idem_key ? `schedule:${actor}:${req.idem_key}` : undefined, () =>
        ctx.db.tx(() => {
          const iv = checkInterval(spec, tz);
          const count = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schedules WHERE owner = ? AND status != 'expired'", owner)!.n;
          if (count >= LIMITS.schedulesPerOwner) throw bad(`${owner} 已有 ${count} 个定时任务（上限 ${LIMITS.schedulesPerOwner}），请先删除或合并`);
          const dup = ctx.db.get<{ id: string }>(
            "SELECT id FROM schedules WHERE owner = ? AND json_extract(data_json, '$.title') = ? AND status != 'expired' LIMIT 1",
            owner,
            title,
          );
          if (dup) throw bad(`${owner} 已有同名定时任务「${title}」（${dup.id}），请改用 update`);
          const now = ctx.now();
          const approval = needsApproval(actor, iv);
          const enabled = req.enabled !== false;
          const s: Schedule = {
            id: newId("sc"),
            owner,
            created_by: actor,
            title,
            spec,
            tz,
            jitter_seconds: jitter,
            payload,
            enabled,
            status: approval ? "pending_approval" : enabled ? "active" : "paused",
            run_count: 0,
            missed_count: 0,
            created_at: now,
            updated_at: now,
          };
          if (req.expires_at != null) s.expires_at = Number(req.expires_at);
          refreshNext(s);
          save(s);
          if (approval) requestApproval(s, actor, iv);
          ctx.events.emit({ type: "schedule.created", actor, subject_type: "schedule", subject_id: s.id, summary: `新建定时任务「${title}」（${owner}）${approval ? "，待批准" : ""}` });
          return s;
        }),
      );
    },

    get: getS,

    list(owner?: Address, limit = 500): Schedule[] {
      const lim = Math.max(1, Math.min(1000, Math.floor(limit) || 500));
      if (owner) return ctx.db.allJson<Schedule>("SELECT data_json FROM schedules WHERE owner = ? ORDER BY rowid LIMIT ?", owner, lim);
      return ctx.db.allJson<Schedule>("SELECT data_json FROM schedules ORDER BY owner, rowid LIMIT ?", lim);
    },

    update(id: string, req: UpdateScheduleReq): Schedule {
      if (!req || typeof req.actor !== "string") throw bad("actor 不能为空");
      return ctx.idem.wrap(req.idem_key ? `schedule_upd:${req.actor}:${req.idem_key}` : undefined, () =>
        ctx.db.tx(() => {
          const s = getS(id);
          if (!s) throw notFound(`定时任务 ${id}`);
          assertOwnerAuthority(req.actor, s.owner);
          const next: Schedule = { ...s, updated_at: ctx.now() };
          if (req.title !== undefined) {
            const t = String(req.title).trim();
            if (!t || t.length > 100) throw bad("title 不能为空且不超过 100 字");
            next.title = t;
          }
          if (req.payload !== undefined) {
            if (String(req.payload).length > MAX_PAYLOAD) throw bad(`payload 过长（上限 ${MAX_PAYLOAD} 字）`);
            next.payload = String(req.payload);
          }
          if (req.jitter_seconds !== undefined) {
            const j = Math.floor(Number(req.jitter_seconds));
            if (!Number.isFinite(j) || j < 0 || j > MAX_JITTER_SECONDS) throw bad(`jitter_seconds 应在 0..${MAX_JITTER_SECONDS}`);
            next.jitter_seconds = j;
          }
          if (req.expires_at !== undefined) {
            if (req.expires_at === null) delete next.expires_at;
            else if (!Number.isFinite(Number(req.expires_at)) || Number(req.expires_at) <= ctx.now()) throw bad("expires_at 必须是将来的时间戳");
            else next.expires_at = Number(req.expires_at);
          }
          let approval = false;
          let iv = Infinity;
          if (req.spec !== undefined) {
            next.spec = validateSpec(req.spec);
            iv = checkInterval(next.spec, next.tz);
            approval = needsApproval(req.actor, iv);
            if (next.status === "expired") next.status = "active";
          }
          if (req.enabled !== undefined) next.enabled = !!req.enabled;
          if (approval) next.status = "pending_approval";
          else if (next.status !== "pending_approval" && next.status !== "expired") next.status = next.enabled ? "active" : "paused";
          refreshNext(next);
          save(next);
          if (approval) requestApproval(next, req.actor, iv);
          ctx.events.emit({ type: "schedule.updated", actor: req.actor, subject_type: "schedule", subject_id: id, summary: `更新定时任务「${next.title}」：${next.status}${next.enabled ? "" : "（停用）"}` });
          return next;
        }),
      );
    },

    remove(id: string, actor: Address): void {
      const s = getS(id);
      if (!s) throw notFound(`定时任务 ${id}`);
      assertOwnerAuthority(actor, s.owner);
      ctx.db.tx(() => {
        ctx.db.run("DELETE FROM schedules WHERE id = ?", id);
        ctx.events.emit({ type: "schedule.deleted", actor, subject_type: "schedule", subject_id: id, summary: `删除定时任务「${s.title}」（${s.owner}）` });
      });
    },

    trigger(id: string, actor: Address): ScheduleRun {
      const s = getS(id);
      if (!s) throw notFound(`定时任务 ${id}`);
      assertOwnerAuthority(actor, s.owner);
      if (s.status === "pending_approval") throw bad("该定时任务尚待批准，不能手动触发");
      return ctx.db.tx(() => {
        let at = ctx.now();
        while (ctx.db.get("SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND scheduled_at = ?", id, at)) at++;
        const run = fire(s, at, "manual")!;
        save({ ...s, last_run_at: run.fired_at, run_count: s.run_count + 1, updated_at: ctx.now() });
        return run;
      });
    },

    runs(id: string, limit = 100): ScheduleRun[] {
      const lim = Math.max(1, Math.min(500, Math.floor(limit) || 100));
      return ctx.db.allJson<ScheduleRun>("SELECT data_json FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_at DESC LIMIT ?", id, lim);
    },

    intervalSeconds,
    nextOccurrence,

    seedDefaults(): void {
      const items: { owner: Address; d: { title: string; spec: ScheduleSpec; payload: string; jitter_seconds?: number } }[] = [];
      for (const p of ctx.court.posts) for (const d of p.default_schedules ?? []) items.push({ owner: `post:${p.post_id}`, d });
      for (const dept of ctx.court.depts) for (const d of dept.default_schedules ?? []) items.push({ owner: `dept:${dept.id}`, d });
      ctx.db.tx(() => {
        for (const { owner, d } of items) {
          // 播种过一次就不再补（被删除的默认任务不会在重启后复活）
          const seededKey = `seeded_schedule:${owner}|${d.title}`;
          if (ctx.db.get("SELECT 1 FROM meta WHERE k = ?", seededKey)) continue;
          const exists = ctx.db.get("SELECT 1 FROM schedules WHERE owner = ? AND json_extract(data_json, '$.title') = ? LIMIT 1", owner, d.title);
          ctx.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", seededKey, String(ctx.now()));
          if (exists) continue;
          let spec: ScheduleSpec;
          try {
            spec = validateSpec(d.spec);
            if (spec.cron) cronOf(spec.cron, TZ);
          } catch (e) {
            console.error(`[hub] 默认定时任务「${d.title}」（${owner}）无效：${(e as Error).message}`);
            continue;
          }
          const now = ctx.now();
          const s: Schedule = {
            id: newId("sc"),
            owner,
            created_by: "system:hub",
            title: d.title,
            spec,
            tz: TZ,
            jitter_seconds: d.jitter_seconds ?? SEED_JITTER_SECONDS,
            payload: d.payload ?? "",
            enabled: true,
            status: "active",
            run_count: 0,
            missed_count: 0,
            created_at: now,
            updated_at: now,
          };
          refreshNext(s);
          save(s);
        }
      });
    },

    tick(now: number): ScheduleRun[] {
      const due = ctx.db.allJson<Schedule>(
        "SELECT data_json FROM schedules WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 100",
        now,
      );
      const out: ScheduleRun[] = [];
      for (const s of due) {
        try {
          const run = ctx.db.tx((): ScheduleRun | undefined => {
            const cur = getS(s.id);
            if (!cur || cur.status !== "active" || !cur.enabled || cur.next_run_at === undefined || cur.next_run_at > now) return undefined;
            const scheduledAt = cur.next_run_at;
            const next: Schedule = { ...cur, updated_at: now };
            if (cur.expires_at && now >= cur.expires_at) {
              next.status = "expired";
              delete next.next_run_at;
              save(next);
              ctx.events.emit({ type: "schedule.expired", actor: "system:scheduler", subject_type: "schedule", subject_id: cur.id, summary: `定时任务「${cur.title}」已过期` });
              return undefined;
            }
            let run: ScheduleRun | undefined;
            if (previousUnhandled(cur)) {
              run = { id: newId("sr"), schedule_id: cur.id, scheduled_at: scheduledAt, fired_at: now, outcome: "skipped_unhandled" };
              const ins = ctx.db.run("INSERT OR IGNORE INTO schedule_runs (id, schedule_id, scheduled_at, data_json) VALUES (?, ?, ?, ?)", run.id, cur.id, scheduledAt, JSON.stringify(run));
              if (!ins.changes) run = undefined;
              else {
                next.missed_count = cur.missed_count + 1;
                ctx.events.emit({
                  type: "schedule.skipped",
                  actor: "system:scheduler",
                  subject_type: "schedule",
                  subject_id: cur.id,
                  summary: `定时任务「${cur.title}」上次触发尚未处理，本次跳过（累计 ${next.missed_count} 次）`,
                });
              }
            } else {
              const outcome: ScheduleRun["outcome"] = now - scheduledAt > CATCHUP_THRESHOLD_MS ? "catchup" : "fired";
              run = fire(cur, scheduledAt, outcome);
              if (run) {
                next.last_run_at = now;
                next.run_count = cur.run_count + 1;
              }
            }
            // 下次：当前之后的下一个时点（宕机期间错过的只补这一次）
            if (cur.spec.at) {
              next.status = "expired";
              delete next.next_run_at;
            } else {
              const n = computeNext(next, now);
              if (n === undefined) {
                delete next.next_run_at;
                if (next.expires_at) next.status = "expired";
              } else next.next_run_at = n;
            }
            save(next);
            return run;
          });
          if (run) out.push(run);
        } catch (e) {
          // 出错也要推进 next_run_at，避免每个 tick 反复失败
          const msg = (e as Error).message;
          try {
            const cur = getS(s.id);
            if (cur) {
              const n = cur.spec.at ? undefined : computeNext(cur, now);
              const next: Schedule = { ...cur, updated_at: now, ...(n === undefined ? { status: cur.spec.at ? "expired" : cur.status } : { next_run_at: n }) };
              if (n === undefined) delete next.next_run_at;
              save(next);
            }
            ctx.events.emit({ type: "schedule.error", actor: "system:scheduler", subject_type: "schedule", subject_id: s.id, summary: `定时任务「${s.title}」触发失败：${msg}`.slice(0, 300) });
          } catch {
            /* 忽略 */
          }
        }
      }
      return out;
    },
  };

  ctx.approvals.onApprove("schedule", (a) => {
    const id = String(a.payload.schedule_id ?? "");
    const s = getS(id);
    if (!s) throw new Error(`定时任务 ${id} 已不存在`);
    if (s.status !== "pending_approval") return;
    const next: Schedule = { ...s, status: s.enabled ? "active" : "paused", updated_at: ctx.now() };
    refreshNext(next);
    save(next);
    ctx.events.emit({ type: "schedule.approved", actor: "emperor", subject_type: "schedule", subject_id: id, summary: `准设定时任务「${s.title}」` });
  });

  (ctx.approvals as ApprovalServiceExt).onReject("schedule", (a) => {
    const s = getS(String(a.payload.schedule_id ?? ""));
    if (!s || s.status !== "pending_approval") return;
    const next: Schedule = { ...s, status: "expired", enabled: false, updated_at: ctx.now() };
    delete next.next_run_at;
    save(next);
    ctx.events.emit({ type: "schedule.rejected", actor: "emperor", subject_type: "schedule", subject_id: s.id, summary: `驳回定时任务「${s.title}」` });
  });

  return self;
}
