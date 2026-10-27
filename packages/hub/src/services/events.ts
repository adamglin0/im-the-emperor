// 事件与追踪：events / spans / span_links 表 + SSE 订阅。
import { newId, type CourtEvent, type EventIn, type Span } from "@court/shared";
import type { EventService, HubCtx } from "../ctx.ts";

type EventRow = {
  id: number;
  uid: string;
  ts: number;
  type: string;
  actor: string;
  dept: string | null;
  trace_id: string | null;
  span_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  summary: string;
  data_json: string | null;
};

/** 数据库行 → CourtEvent */
export function rowToEvent(r: EventRow): CourtEvent {
  const data = r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : undefined;
  const ev: CourtEvent = { id: r.id, uid: r.uid, ts: r.ts, type: r.type, actor: r.actor, summary: r.summary };
  if (r.dept) ev.dept = r.dept;
  if (r.trace_id) ev.trace_id = r.trace_id;
  if (r.span_id) ev.span_id = r.span_id;
  if (r.subject_type) ev.subject_type = r.subject_type;
  if (r.subject_id) ev.subject_id = r.subject_id;
  // parent_span_id 不单独建列，随 data 保存
  if (data && typeof data.__parent_span_id === "string") {
    ev.parent_span_id = data.__parent_span_id;
    delete data.__parent_span_id;
  }
  if (data && Object.keys(data).length) ev.data = data;
  return ev;
}

const MAX_SUMMARY = 500;

export function createEvents(ctx: HubCtx): EventService {
  const subscribers = new Set<(e: CourtEvent) => void>();
  let ephemeralSeq = 0;

  function fanout(ev: CourtEvent): void {
    for (const fn of subscribers) {
      try {
        fn(ev);
      } catch {
        /* 订阅者异常不影响其他人 */
      }
    }
  }

  /** 提交后推送：微任务里确认行仍存在（事务回滚则不推送） */
  function publish(ev: CourtEvent): void {
    if (!subscribers.size) return;
    queueMicrotask(() => {
      const still = ctx.db.get<{ id: number }>("SELECT id FROM events WHERE uid = ?", ev.uid);
      if (!still || still.id !== ev.id) return; // 已回滚（自增 id 可能被复用，按 uid 核对）
      fanout(ev);
    });
  }

  function insert(e: Omit<CourtEvent, "id" | "uid" | "ts"> & { uid?: string; ts?: number }): CourtEvent | undefined {
    const uid = e.uid || newId("ev");
    const ts = e.ts ?? ctx.now();
    const data: Record<string, unknown> | undefined = e.parent_span_id ? { ...(e.data ?? {}), __parent_span_id: e.parent_span_id } : e.data;
    const summary = String(e.summary ?? "").slice(0, MAX_SUMMARY);
    const r = ctx.db.run(
      `INSERT OR IGNORE INTO events (uid, ts, type, actor, dept, trace_id, span_id, subject_type, subject_id, summary, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uid,
      ts,
      e.type,
      e.actor,
      e.dept ?? null,
      e.trace_id ?? null,
      e.span_id ?? null,
      e.subject_type ?? null,
      e.subject_id ?? null,
      summary,
      data ? JSON.stringify(data) : null,
    );
    if (!r.changes) return undefined;
    const ev: CourtEvent = { ...e, id: r.lastInsertRowid, uid, ts, summary };
    for (const k of Object.keys(ev) as (keyof CourtEvent)[]) if (ev[k] === undefined) delete ev[k];
    publish(ev);
    return ev;
  }

  function getSpan(spanId: string): Span | undefined {
    return ctx.db.getJson<Span>("SELECT data_json FROM spans WHERE span_id = ?", spanId);
  }

  function writeSpan(s: Span): void {
    ctx.db.run(
      `INSERT INTO spans (span_id, trace_id, parent_span_id, kind, status, started_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(span_id) DO UPDATE SET trace_id = excluded.trace_id, parent_span_id = excluded.parent_span_id,
         kind = excluded.kind, status = excluded.status, started_at = excluded.started_at, data_json = excluded.data_json`,
      s.span_id,
      s.trace_id,
      s.parent_span_id ?? null,
      s.kind,
      s.status,
      s.started_at,
      JSON.stringify(s),
    );
  }

  /** 合并式 upsert：已有字段保留，新给的覆盖，attrs 浅合并 */
  function upsertSpan(s: Partial<Span> & { trace_id: string; kind: Span["kind"]; name: string; actor: string; span_id?: string }): string {
    const spanId = s.span_id || newId("sp");
    const prev = getSpan(spanId);
    const merged: Span = {
      span_id: spanId,
      trace_id: s.trace_id ?? prev?.trace_id,
      parent_span_id: s.parent_span_id ?? prev?.parent_span_id,
      kind: s.kind ?? prev?.kind,
      name: s.name ?? prev?.name,
      actor: s.actor ?? prev?.actor,
      status: s.status ?? prev?.status ?? "running",
      started_at: s.started_at ?? prev?.started_at ?? ctx.now(),
      ended_at: s.ended_at ?? prev?.ended_at,
      attrs: prev?.attrs || s.attrs ? { ...(prev?.attrs ?? {}), ...(s.attrs ?? {}) } : undefined,
    };
    if (!merged.parent_span_id) delete merged.parent_span_id;
    if (merged.ended_at === undefined) delete merged.ended_at;
    if (!merged.attrs) delete merged.attrs;
    writeSpan(merged);
    return spanId;
  }

  return {
    emit: insert,

    ingest(events: EventIn[]): number {
      if (!Array.isArray(events)) return 0;
      let inserted = 0;
      ctx.db.tx(() => {
        for (const e of events.slice(0, 2000)) {
          if (!e || typeof e.type !== "string" || typeof e.actor !== "string") continue;
          if (e.span && e.span.span_id && e.span.trace_id) {
            upsertSpan({ ...e.span, name: e.span.name ?? e.type, actor: e.span.actor ?? e.actor });
          }
          const { span: _span, ...rest } = e;
          const ev = insert({ ...rest, summary: e.summary ?? e.type, uid: e.uid || undefined });
          if (ev) inserted++;
        }
      });
      return inserted;
    },

    span: upsertSpan,

    publish(e) {
      const ev: CourtEvent = { ...e, id: -++ephemeralSeq, uid: newId("ev"), ts: ctx.now(), summary: String(e.summary ?? "").slice(0, MAX_SUMMARY) };
      for (const k of Object.keys(ev) as (keyof CourtEvent)[]) if (ev[k] === undefined) delete ev[k];
      if (subscribers.size) queueMicrotask(() => fanout(ev));
      return ev;
    },

    endSpan(spanId: string, status: Span["status"], attrs?: Record<string, unknown>): void {
      const prev = getSpan(spanId);
      if (!prev) return;
      writeSpan({ ...prev, status, ended_at: ctx.now(), attrs: attrs ? { ...(prev.attrs ?? {}), ...attrs } : prev.attrs });
    },

    link(fromSpan: string, toSpan: string, kind: "message" | "service" | "causes", traceId: string, label?: string): void {
      ctx.db.run(
        "INSERT OR IGNORE INTO span_links (from_span, to_span, kind, label, trace_id) VALUES (?, ?, ?, ?, ?)",
        fromSpan,
        toSpan,
        kind,
        label ?? null,
        traceId,
      );
    },

    subscribe(fn: (e: CourtEvent) => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
