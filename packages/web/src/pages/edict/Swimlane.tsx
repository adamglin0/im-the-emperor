// 泳道时序图（手绘 SVG）：按部门分道（可展开到官员），轮次为条、工具为刻、消息/服务为箭头；
// 底部时间轴 + 游标回放（游标之后的元素淡出）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CourtEvent, Span } from "@court/shared/types";
import { useRegistry } from "../../api/registry.tsx";
import { useTip } from "../../components/charts.tsx";
import { DEPT_NAMES, DEPT_ORDER, SPAN_KIND } from "../../lib/labels.ts";
import { fmtDuration, fmtTime, fmtTokens } from "../../lib/format.ts";
import { deptOfAddr, type MacroGraph } from "./model.ts";

const LABEL_W = 132;
const LANE_H = 30;
const SUB_H = 24;
const AXIS_H = 26;

interface Lane {
  key: string; // dept 或 post
  label: string;
  dept: string;
  sub: boolean;
  y: number;
  h: number;
}

function laneKeyOf(actor: string | undefined): { dept: string; post?: string } {
  const d = deptOfAddr(actor) ?? "system";
  const post = actor?.startsWith("post:") ? actor.slice(5) : undefined;
  return { dept: d, post };
}

export function Swimlane({
  g,
  events,
  cursor,
  setCursor,
  onSelectSpan,
  filterSpan,
  filterEvent,
  now,
}: {
  g: MacroGraph;
  events: CourtEvent[];
  cursor: number | null;
  setCursor: (c: number | null) => void;
  onSelectSpan: (spanId: string) => void;
  filterSpan: (s: Span) => boolean;
  filterEvent: (e: CourtEvent) => boolean;
  now: number;
}) {
  const r = useRegistry();
  const tip = useTip();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(480, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(480, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const spans = useMemo(() => [...g.spanById.values()].filter((s) => s.kind !== "edict").filter(filterSpan), [g, filterSpan]);
  const evs = useMemo(() => events.filter(filterEvent), [events, filterEvent]);

  // 时间范围
  const [t0, t1] = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (const s of g.spanById.values()) {
      a = Math.min(a, s.started_at);
      b = Math.max(b, s.ended_at ?? now);
    }
    for (const e of events) {
      a = Math.min(a, e.ts);
      b = Math.max(b, e.ts);
    }
    if (!isFinite(a)) return [now - 3_600_000, now];
    if (b - a < 60_000) b = a + 60_000;
    const pad = (b - a) * 0.02;
    return [a - pad, b + pad];
  }, [g, events, now]);

  // 分道
  const lanes = useMemo<Lane[]>(() => {
    const deptPosts = new Map<string, Set<string>>();
    const touch = (actor?: string) => {
      if (!actor) return;
      const { dept, post } = laneKeyOf(actor);
      const set = deptPosts.get(dept) ?? new Set<string>();
      if (post) set.add(post);
      deptPosts.set(dept, set);
    };
    for (const s of spans) touch(s.actor);
    for (const e of evs) touch(e.actor);
    const order = (d: string) => (d === "emperor" ? -1 : d === "system" ? 99 : DEPT_ORDER.indexOf(d as never) >= 0 ? DEPT_ORDER.indexOf(d as never) : 50);
    const out: Lane[] = [];
    let y = 0;
    for (const d of [...deptPosts.keys()].sort((a, b) => order(a) - order(b))) {
      const label = d === "emperor" ? "御前" : d === "system" ? "皇城" : (r.deptName(d) ?? DEPT_NAMES[d] ?? d);
      out.push({ key: d, label, dept: d, sub: false, y, h: LANE_H });
      y += LANE_H;
      if (expanded.has(d)) {
        for (const p of [...(deptPosts.get(d) ?? [])].sort()) {
          out.push({ key: p, label: r.postLabel(p), dept: d, sub: true, y, h: SUB_H });
          y += SUB_H;
        }
      }
    }
    return out;
  }, [spans, evs, expanded, r]);
  const laneMap = useMemo(() => new Map(lanes.map((l) => [l.key, l])), [lanes]);
  const laneOf = (actor?: string): Lane | undefined => {
    const { dept, post } = laneKeyOf(actor);
    if (post && expanded.has(dept)) return laneMap.get(post) ?? laneMap.get(dept);
    return laneMap.get(dept);
  };
  const totalH = (lanes.at(-1)?.y ?? 0) + (lanes.at(-1)?.h ?? 0);
  const plotW = width - LABEL_W - 8;
  const x = (t: number) => LABEL_W + ((t - t0) / (t1 - t0)) * plotW;
  const tAt = (px: number) => t0 + ((px - LABEL_W) / plotW) * (t1 - t0);

  // 刻度
  const ticks = useMemo(() => {
    const span = t1 - t0;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 1440].map((m) => m * 60_000);
    const step = steps.find((s) => span / s <= 10) ?? steps[steps.length - 1];
    const out: number[] = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
    return out;
  }, [t0, t1]);

  // 回放：14 秒扫完全程
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let c = cursorRef.current === null || cursorRef.current >= t1 ? t0 : cursorRef.current;
    const tick = (ts: number) => {
      c = Math.min(t1, c + ((t1 - t0) * (ts - last)) / 14_000);
      last = ts;
      setCursor(c);
      if (c >= t1) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, t0, t1]);

  const future = (t: number) => cursor !== null && t > cursor;

  // 箭头：追踪连线 + 消息 span + message.sent 事件（去重）
  const arrows = useMemo(() => {
    const out: { key: string; x1: number; y1: number; x2: number; y2: number; kind: string; label?: string; t: number }[] = [];
    const seen = new Set<string>();
    const push = (key: string, t1x: number, fromActor: string | undefined, t2x: number, toActor: string | undefined, kind: string, label?: string) => {
      const a = laneOf(fromActor);
      const b = laneOf(toActor);
      if (!a || !b) return;
      const sig = `${Math.round(t1x / 5000)}|${a.key}|${b.key}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      const x1 = x(t1x);
      const x2 = Math.max(x1 + (a === b ? 10 : 3), x(t2x));
      out.push({ key, x1, y1: a.y + a.h / 2, x2, y2: b.y + b.h / 2, kind, label, t: t1x });
    };
    const spanIds = new Set(spans.map((s) => s.span_id));
    // 服务调用先画（hub 事件 data.from/to），同一时刻的请求消息去重后不再盖成普通消息箭头
    for (const e of evs) {
      if (e.type !== "service.requested") continue;
      const to = e.data?.to as string | undefined;
      const from = (e.data?.from as string | undefined) ?? e.actor;
      if (to) push(`ev${e.id}`, e.ts, from, e.ts + 20_000, to, "service", e.summary);
    }
    for (const s of spans) {
      if (s.kind !== "message") continue;
      const to = s.attrs?.to as string | undefined;
      if (to) push(s.span_id, s.started_at, s.actor, s.started_at + 20_000, to, "message", s.name);
    }
    for (const lk of g.links) {
      if (!spanIds.has(lk.from_span) && !spanIds.has(lk.to_span)) continue;
      const a = g.spanById.get(lk.from_span);
      const b = g.spanById.get(lk.to_span);
      if (!a || !b) continue;
      if (lk.kind === "causes") continue;
      const ta = a.kind === "message" ? a.started_at : (a.ended_at ?? a.started_at);
      push(`${lk.from_span}>${lk.to_span}`, Math.min(ta, b.started_at), a.actor, b.started_at, b.actor, lk.kind, lk.label);
    }
    for (const e of evs) {
      if (e.type !== "message.sent") continue;
      const to = e.data?.to as string | undefined;
      if (to) push(`ev${e.id}`, e.ts, e.actor, e.ts + 20_000, to, "message", e.summary);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spans, evs, lanes, t0, t1, width, g]);

  const turnSpans = spans.filter((s) => s.kind === "turn");
  const toolSpans = spans.filter((s) => s.kind === "tool");
  const macroSpans = spans.filter((s) => s.kind !== "turn" && s.kind !== "tool" && s.kind !== "message");
  const errorEvents = evs.filter((e) => /error/.test(e.type));
  // 公文状态事件：菱形标记
  const stateEvents = evs.filter((e) => /^(edict|task|notification|deliberation|council)\./.test(e.type));

  const onAxis = (ev: React.MouseEvent<SVGSVGElement>) => {
    const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * width;
    if (px < LABEL_W) return;
    setPlaying(false);
    setCursor(Math.min(t1, Math.max(t0, tAt(px))));
  };

  return (
    <div className="swim" ref={wrapRef}>
      <div className="swim-toolbar">
        <button className="btn sm" onClick={() => setPlaying((p) => !p)} title="回放：游标从头扫至尾">
          {playing ? "❚❚ 暂停" : "▶ 回放"}
        </button>
        <button className="btn sm ghost" onClick={() => (setPlaying(false), setCursor(null))} disabled={cursor === null}>
          复位
        </button>
        <input
          type="range"
          className="swim-range"
          min={t0}
          max={t1}
          step={(t1 - t0) / 500}
          value={cursor ?? t1}
          onChange={(e) => (setPlaying(false), setCursor(Number(e.target.value)))}
          aria-label="时间游标"
        />
        <span className="mono small swim-cursor-time">{cursor === null ? "全程" : fmtTime(cursor)}</span>
        <span className="legend small">
          <span><i style={{ background: "var(--azure)" }} />轮次</span>
          <span><i style={{ background: "var(--jade)" }} />消息</span>
          <span><i style={{ background: "var(--gold)" }} />服务</span>
          <span><i style={{ background: "var(--vermilion)" }} />出错/驳</span>
        </span>
      </div>
      {lanes.length === 0 ? (
        <div className="empty serif">尚无执行轨迹</div>
      ) : (
        <svg className="swim-svg" width={width} height={totalH + AXIS_H} viewBox={`0 0 ${width} ${totalH + AXIS_H}`} onDoubleClick={onAxis}>
          <defs>
            {(["message", "service", "causes"] as const).map((k) => (
              <marker key={k} id={`sw-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={k === "message" ? "var(--jade)" : k === "service" ? "var(--gold)" : "var(--plum)"} />
              </marker>
            ))}
          </defs>
          {/* 分道底纹与标签 */}
          {lanes.map((l, i) => (
            <g key={l.key}>
              <rect x={0} y={l.y} width={width} height={l.h} className={`swim-lane ${l.sub ? "sub" : ""} ${i % 2 ? "odd" : ""}`} />
              <text
                x={l.sub ? 22 : 8}
                y={l.y + l.h / 2 + 4}
                className={`swim-label ${l.sub ? "sub" : ""}`}
                onClick={() => {
                  if (l.sub) return;
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (n.has(l.dept)) n.delete(l.dept);
                    else n.add(l.dept);
                    return n;
                  });
                }}
                style={{ cursor: l.sub ? "default" : "pointer" }}
              >
                {!l.sub && (expanded.has(l.dept) ? "▾ " : "▸ ")}
                {l.label.length > 9 ? l.label.slice(0, 9) + "…" : l.label}
              </text>
            </g>
          ))}
          {/* 刻度 */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={totalH} className="swim-grid" />
              <text x={x(t)} y={totalH + 16} textAnchor="middle" className="swim-tick">
                {fmtTime(t).slice(0, 5)}
              </text>
            </g>
          ))}
          <line x1={LABEL_W} x2={LABEL_W} y1={0} y2={totalH} className="swim-axis" />
          {/* 宏观职责线 */}
          {macroSpans.map((s) => {
            const l = laneOf(s.actor);
            if (!l) return null;
            const x1 = x(s.started_at);
            const x2 = x(s.ended_at ?? now);
            return (
              <line
                key={s.span_id}
                x1={x1}
                x2={Math.max(x1 + 2, x2)}
                y1={l.y + l.h - 4}
                y2={l.y + l.h - 4}
                className={`swim-duty st-${s.status} ${future(s.started_at) ? "future" : ""}`}
                onClick={() => onSelectSpan(s.span_id)}
                onMouseMove={(e) => tip.show(e, <>{SPAN_KIND[s.kind] ?? s.kind} · {s.name}<br />{fmtTime(s.started_at)} 起 · {fmtDuration((s.ended_at ?? now) - s.started_at)}</>)}
                onMouseLeave={tip.hide}
              />
            );
          })}
          {/* 轮次条 */}
          {turnSpans.map((s) => {
            const l = laneOf(s.actor);
            if (!l) return null;
            const x1 = x(s.started_at);
            const w = Math.max(3, x(s.ended_at ?? now) - x1);
            const tid = (s.attrs?.turn_id as string) ?? s.span_id;
            const u = g.turnUsage.get(tid);
            return (
              <rect
                key={s.span_id}
                x={x1}
                y={l.y + 6}
                width={w}
                height={l.h - 14}
                rx={2}
                className={`swim-turn st-${s.status} ${future(s.started_at) ? "future" : ""}`}
                onClick={() => onSelectSpan(s.span_id)}
                onMouseMove={(e) =>
                  tip.show(
                    e,
                    <>
                      {r.addrLabel(s.actor)} · {s.name}
                      <br />
                      {fmtTime(s.started_at)} · {fmtDuration((s.ended_at ?? now) - s.started_at)}
                      {u ? ` · ${fmtTokens(u.tokens)} tokens` : ""}
                    </>,
                  )
                }
                onMouseLeave={tip.hide}
              />
            );
          })}
          {/* 工具刻 */}
          {toolSpans.map((s) => {
            const l = laneOf(s.actor);
            if (!l) return null;
            const xx = x(s.started_at);
            return (
              <line
                key={s.span_id}
                x1={xx}
                x2={xx}
                y1={l.y + 4}
                y2={l.y + l.h - 6}
                className={`swim-tool st-${s.status} ${future(s.started_at) ? "future" : ""}`}
                onClick={() => onSelectSpan(s.span_id)}
                onMouseMove={(e) => tip.show(e, <>工具 {s.name}{s.status === "error" ? `（出错：${String(s.attrs?.error ?? "")}）` : ""}</>)}
                onMouseLeave={tip.hide}
              />
            );
          })}
          {/* 错误事件 */}
          {errorEvents.map((e) => {
            const l = laneOf(e.actor);
            if (!l) return null;
            return (
              <text key={e.id} x={x(e.ts)} y={l.y + 11} textAnchor="middle" className={`swim-err ${future(e.ts) ? "future" : ""}`}>
                ✕
              </text>
            );
          })}
          {stateEvents.map((e) => {
            const l = laneOf(e.actor);
            if (!l) return null;
            const cx = x(e.ts);
            const cy = l.y + l.h / 2;
            const tone = /reject|驳|block|fail|error/.test(`${e.type}${e.summary}`) ? "bad" : e.type.startsWith("edict") ? "edict" : "task";
            return (
              <path
                key={`se${e.id}`}
                d={`M${cx},${cy - 6} L${cx + 6},${cy} L${cx},${cy + 6} L${cx - 6},${cy} Z`}
                className={`swim-state ${tone} ${future(e.ts) ? "future" : ""}`}
                onClick={() => e.span_id && onSelectSpan(e.span_id)}
                onMouseMove={(ev) => tip.show(ev, <>{e.type} · {e.summary}<br />{fmtTime(e.ts)}</>)}
                onMouseLeave={tip.hide}
              />
            );
          })}
          {/* 箭头 */}
          {arrows.map((a) => {
            const midX = (a.x1 + a.x2) / 2;
            const d = a.y1 === a.y2 ? `M${a.x1},${a.y1 - 3} Q${midX},${a.y1 - 14} ${a.x2},${a.y2 - 3}` : `M${a.x1},${a.y1} C${a.x1 + 14},${a.y1} ${a.x2 - 14},${a.y2} ${a.x2},${a.y2}`;
            return (
              <path
                key={a.key}
                d={d}
                className={`swim-arrow k-${a.kind} ${future(a.t) ? "future" : ""}`}
                markerEnd={`url(#sw-arrow-${a.kind === "service" ? "service" : a.kind === "causes" ? "causes" : "message"})`}
                onMouseMove={(e) => tip.show(e, <>{a.kind === "service" ? "服务" : "消息"}：{a.label ?? ""}<br />{fmtTime(a.t)}</>)}
                onMouseLeave={tip.hide}
              />
            );
          })}
          {/* 游标 */}
          {cursor !== null && (
            <g pointerEvents="none">
              <line x1={x(cursor)} x2={x(cursor)} y1={0} y2={totalH} className="swim-cursor" />
              <rect x={x(cursor) - 26} y={totalH + 4} width={52} height={16} rx={2} fill="var(--vermilion)" />
              <text x={x(cursor)} y={totalH + 16} textAnchor="middle" fill="var(--vermilion-ink)" style={{ fontSize: 10.5, fontFamily: "var(--font-mono)" }}>
                {fmtTime(cursor)}
              </text>
            </g>
          )}
          {/* 现在 */}
          {now <= t1 && <line x1={x(now)} x2={x(now)} y1={0} y2={totalH} className="swim-now" />}
        </svg>
      )}
      <div className="muted small" style={{ marginTop: 4 }}>
        点部门名展开到官员 · 点条目看详情 · 双击图面定位游标
      </div>
      {tip.node}
    </div>
  );
}
