// HubCtx 上的杂项：状态迁移记录、官员状态汇总。
import { dayStart, type Address, type OfficialStatus } from "@court/shared";
import type { HubCtx } from "../ctx.ts";
import { STATUS_STALE_MS } from "./registry.ts";

export function createTransition(ctx: HubCtx): HubCtx["transition"] {
  return (subjectType, subjectId, from, to, actor: Address, reason, traceId) => {
    const at = ctx.now();
    ctx.db.run(
      "INSERT INTO transitions (subject_type, subject_id, from_state, to_state, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      subjectType,
      subjectId,
      from,
      to,
      actor,
      reason ?? "",
      at,
    );
    const dept = actor.startsWith("post:") ? ctx.registry.post(actor.slice(5))?.dept : undefined;
    ctx.events.emit({
      type: `${subjectType}.state`,
      actor,
      dept,
      trace_id: traceId,
      subject_type: subjectType,
      subject_id: subjectId,
      summary: `${subjectType} ${subjectId}：${from} → ${to}${reason ? `（${reason}）` : ""}`.slice(0, 500),
      data: { from, to, reason: reason ?? "" },
      ts: at,
    });
  };
}

/** 全部职位的状态：空缺 → vacant；无心跳或心跳过期（>30s）→ offline */
export function createStatuses(ctx: HubCtx): HubCtx["statuses"] {
  return () => {
    const now = ctx.now();
    const stored = new Map<string, { updated_at: number; data_json: string }>();
    for (const r of ctx.db.all<{ post_id: string; updated_at: number; data_json: string }>("SELECT post_id, updated_at, data_json FROM statuses LIMIT 5000")) {
      stored.set(r.post_id, r);
    }
    const appointed = new Map<string, string>();
    for (const a of ctx.db.all<{ post_id: string; official_id: string }>("SELECT post_id, official_id FROM appointments LIMIT 5000")) appointed.set(a.post_id, a.official_id);
    // 今日俸禄以账本为准（部门重启后其内存计数归零）
    const ledgerToday = new Map<string, number>();
    for (const r of ctx.db.all<{ post_id: string; t: number | null }>("SELECT post_id, SUM(total_tokens) AS t FROM ledger WHERE ts >= ? GROUP BY post_id", dayStart(now))) {
      ledgerToday.set(r.post_id, r.t ?? 0);
    }
    const out: OfficialStatus[] = [];
    for (const p of ctx.registry.posts()) {
      const official_id = appointed.get(p.post_id);
      if (!official_id) {
        out.push({ post_id: p.post_id, dept: p.dept, state: "vacant", last_progress_at: 0, turns_last_hour: 0, tokens_today: 0, updated_at: now });
        continue;
      }
      const row = stored.get(p.post_id);
      if (!row) {
        out.push({ post_id: p.post_id, official_id, dept: p.dept, state: "offline", last_progress_at: 0, turns_last_hour: 0, tokens_today: 0, updated_at: 0 });
        continue;
      }
      const s = JSON.parse(row.data_json) as OfficialStatus;
      const st: OfficialStatus = { ...s, post_id: p.post_id, official_id, dept: p.dept, updated_at: row.updated_at };
      st.tokens_today = Math.max(Number(s.tokens_today) || 0, ledgerToday.get(p.post_id) ?? 0);
      if (now - row.updated_at > STATUS_STALE_MS) st.state = "offline";
      out.push(st);
    }
    return out;
  };
}
