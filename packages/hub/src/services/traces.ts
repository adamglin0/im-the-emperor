// 追踪图：某 trace 的 span、额外边与事件；最近的根 span 列表。
import type { CourtEvent, Span, TraceGraph } from "@court/shared";
import type { HubCtx } from "../ctx.ts";

const MAX_SPANS = 2000;
const MAX_EVENTS = 1000;
const ROOT_KINDS = ["edict", "deliberation", "message"];

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

export interface TraceRoot {
  trace_id: string;
  kind: string;
  name: string;
  status: string;
  started_at: number;
  ended_at?: number;
}

function rowToEvent(r: EventRow): CourtEvent {
  let data: Record<string, unknown> | undefined;
  try {
    data = r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : undefined;
  } catch {
    data = undefined;
  }
  const ev: CourtEvent = { id: r.id, uid: r.uid, ts: r.ts, type: r.type, actor: r.actor, summary: r.summary };
  if (r.dept) ev.dept = r.dept;
  if (r.trace_id) ev.trace_id = r.trace_id;
  if (r.span_id) ev.span_id = r.span_id;
  if (r.subject_type) ev.subject_type = r.subject_type;
  if (r.subject_id) ev.subject_id = r.subject_id;
  // 事件服务把 parent_span_id 存在 data.__parent_span_id
  if (data && typeof data.__parent_span_id === "string") {
    ev.parent_span_id = data.__parent_span_id;
    delete data.__parent_span_id;
  }
  if (data && Object.keys(data).length) ev.data = data;
  return ev;
}

export function getTraceGraph(ctx: HubCtx, traceId: string): TraceGraph {
  const spans = ctx.db.allJson<Span>("SELECT data_json FROM spans WHERE trace_id = ? ORDER BY started_at, rowid LIMIT ?", traceId, MAX_SPANS);
  const ids = new Set(spans.map((s) => s.span_id));
  const parentless = spans.filter((s) => !s.parent_span_id || !ids.has(s.parent_span_id));
  const root = parentless.find((s) => s.kind === "edict" || s.kind === "deliberation") ?? parentless[0];
  const links = ctx.db
    .all<{ from_span: string; to_span: string; kind: TraceGraph["links"][number]["kind"]; label: string | null }>(
      "SELECT from_span, to_span, kind, label FROM span_links WHERE trace_id = ? LIMIT ?",
      traceId,
      MAX_SPANS * 2,
    )
    .map((l) => (l.label ? { from_span: l.from_span, to_span: l.to_span, kind: l.kind, label: l.label } : { from_span: l.from_span, to_span: l.to_span, kind: l.kind }));
  // 取最近的 MAX_EVENTS 条，按时间正序返回
  const events = ctx.db
    .all<EventRow>(
      "SELECT * FROM (SELECT id, uid, ts, type, actor, dept, trace_id, span_id, subject_type, subject_id, summary, data_json FROM events WHERE trace_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
      traceId,
      MAX_EVENTS,
    )
    .map(rowToEvent);
  return { trace_id: traceId, root, spans, links, events };
}

export function listTraceRoots(ctx: HubCtx, opts: { limit?: number; kind?: string }): TraceRoot[] {
  const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 200);
  const kinds = opts.kind ? [opts.kind] : ROOT_KINDS;
  const ph = kinds.map(() => "?").join(",");
  return ctx.db
    .allJson<Span>(`SELECT data_json FROM spans WHERE parent_span_id IS NULL AND kind IN (${ph}) ORDER BY started_at DESC LIMIT ?`, ...kinds, limit)
    .map((s) => {
      const r: TraceRoot = { trace_id: s.trace_id, kind: s.kind, name: s.name, status: s.status, started_at: s.started_at };
      if (s.ended_at) r.ended_at = s.ended_at;
      return r;
    });
}
