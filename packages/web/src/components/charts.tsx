// 手绘 SVG 图表（无第三方库）：横向条形、时间序列折线/柱、雷达、热力矩阵、迷你折线。
// 规则（dataviz）：分类色 ≤4（--series-1..4），其余归「其他」；单系列不出图例；
// 文字用墨色而非系列色；每个图形都带悬停提示。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtCompact } from "../lib/format.ts";

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

// ───────── 悬停提示 ─────────
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const node = tip ? (
    <div className="chart-tip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 290), top: tip.y + 14 }}>
      {tip.content}
    </div>
  ) : null;
  return {
    node,
    show: (e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content }),
    hide: () => setTip(null),
  };
}

// ───────── 横向条形（排名/分组对比） ─────────
export interface BarDatum {
  key: string;
  label: ReactNode;
  value: number;
  /** 提示内容（默认 label + 值） */
  tip?: ReactNode;
  href?: string;
}
export function BarList({
  data,
  format = fmtCompact,
  color = "var(--series-1)",
  max,
  onClick,
  limit = 20,
}: {
  data: BarDatum[];
  format?: (n: number) => string;
  color?: string;
  max?: number;
  onClick?: (d: BarDatum) => void;
  limit?: number;
}) {
  const t = useTip();
  const shown = data.slice(0, limit);
  const m = max ?? Math.max(1, ...shown.map((d) => d.value));
  return (
    <div className="barlist">
      {shown.map((d) => (
        <div
          key={d.key}
          className={`barlist-row ${onClick ? "clickable" : ""}`}
          onClick={() => onClick?.(d)}
          onMouseMove={(e) => t.show(e, d.tip ?? <>{d.label}：{format(d.value)}</>)}
          onMouseLeave={t.hide}
        >
          <div className="barlist-label ellipsis">{d.label}</div>
          <div className="barlist-track">
            <div className="barlist-bar" style={{ width: `${Math.max(0.5, (d.value / m) * 100)}%`, background: color }} />
          </div>
          <div className="barlist-value num">{format(d.value)}</div>
        </div>
      ))}
      {data.length > limit && <div className="muted small">另有 {data.length - limit} 项未列</div>}
      {t.node}
    </div>
  );
}

// ───────── 时间序列（柱或线），单轴 ─────────
export interface SeriesDef {
  key: string;
  label: string;
  values: number[]; // 与 xs 对齐
}
export function TimeChart({
  xs,
  series,
  kind = "bar",
  height = 180,
  xLabel = (x: number) => String(x),
  format = fmtCompact,
  stacked,
}: {
  xs: number[];
  series: SeriesDef[];
  kind?: "bar" | "line";
  height?: number;
  xLabel?: (x: number, i: number) => string;
  format?: (n: number) => string;
  stacked?: boolean;
}) {
  const t = useTip();
  const ref = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // 按容器实际宽度绘制，避免 preserveAspectRatio=none 拉伸文字
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const w = Math.round(es[0].contentRect.width);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const pad = { l: 44, r: 10, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const shown = series.slice(0, 4);
  const totals = xs.map((_, i) => shown.reduce((s, se) => s + (se.values[i] ?? 0), 0));
  const maxV = Math.max(1, ...(stacked ? totals : shown.flatMap((s) => s.values)));
  const ticks = niceTicks(maxV, 4);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const step = xs.length > 0 ? iw / xs.length : iw;
  const labelEvery = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(W / 70))));

  const onMove = (e: React.MouseEvent) => {
    const svg = ref.current;
    if (!svg || xs.length === 0) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W - pad.l;
    const i = Math.max(0, Math.min(xs.length - 1, Math.floor(px / step)));
    setHover(i);
    t.show(
      e,
      <div>
        <div style={{ marginBottom: 2 }}>{xLabel(xs[i], i)}</div>
        {shown.map((s, si) => (
          <div key={s.key}>
            {shown.length > 1 && <i style={{ display: "inline-block", width: 8, height: 8, background: SERIES[si], marginRight: 5, borderRadius: 2 }} />}
            {s.label}：{format(s.values[i] ?? 0)}
          </div>
        ))}
      </div>,
    );
  };

  return (
    <div ref={boxRef}>
      {shown.length > 1 && (
        <div className="legend" style={{ marginBottom: 6 }}>
          {shown.map((s, i) => (
            <span key={s.key}>
              <i style={{ background: SERIES[i] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} style={{ height: H }} onMouseMove={onMove} onMouseLeave={() => (setHover(null), t.hide())}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end">
              {format(v)}
            </text>
          </g>
        ))}
        {hover !== null && <rect x={pad.l + hover * step} y={pad.t} width={step} height={ih} fill="var(--gold-soft)" opacity={0.6} />}
        {kind === "bar" &&
          xs.map((_, i) => {
            let acc = 0;
            const bw = stacked || shown.length === 1 ? Math.max(1, step - 3) : Math.max(1, (step - 3) / shown.length);
            return shown.map((s, si) => {
              const v = s.values[i] ?? 0;
              if (v <= 0) return null;
              const x = stacked || shown.length === 1 ? pad.l + i * step + 1.5 : pad.l + i * step + 1.5 + si * bw;
              const y0 = stacked ? y(acc + v) : y(v);
              const h = stacked ? y(acc) - y(acc + v) : pad.t + ih - y(v);
              acc += v;
              return <rect key={`${i}-${s.key}`} x={x} y={y0} width={Math.max(1, bw - (stacked ? 0 : 1))} height={Math.max(0, h - (stacked && si > 0 ? 1 : 0))} rx={Math.min(2, bw / 3)} fill={SERIES[si]} />;
            });
          })}
        {kind === "line" &&
          shown.map((s, si) => (
            <polyline
              key={s.key}
              fill="none"
              stroke={SERIES[si]}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              points={s.values.map((v, i) => `${pad.l + i * step + step / 2},${y(v)}`).join(" ")}
            />
          ))}
        {kind === "line" &&
          hover !== null &&
          shown.map((s, si) => <circle key={s.key} cx={pad.l + hover * step + step / 2} cy={y(s.values[hover] ?? 0)} r={4} fill={SERIES[si]} stroke="var(--panel)" strokeWidth={2} />)}
        <line className="axis-line" x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} />
        {xs.map((x, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={pad.l + i * step + step / 2} y={H - 6} textAnchor="middle">
              {xLabel(x, i)}
            </text>
          ) : null,
        )}
      </svg>
      {t.node}
    </div>
  );
}

export function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

// ───────── 雷达（≤4 个对象 × N 维度） ─────────
export function Radar({
  axes,
  series,
  size = 260,
  max = 100,
}: {
  axes: { key: string; label: string }[];
  series: { key: string; label: string; values: Record<string, number | undefined> }[];
  size?: number;
  max?: number;
}) {
  const t = useTip();
  const shown = series.slice(0, 4);
  const c = size / 2;
  const r = size / 2 - 34;
  const n = axes.length;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + Math.cos(a) * r * (v / max), c + Math.sin(a) * r * (v / max)];
  };
  return (
    <div>
      {shown.length > 1 && (
        <div className="legend" style={{ marginBottom: 6 }}>
          {shown.map((s, i) => (
            <span key={s.key}>
              <i style={{ background: SERIES[i] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg className="chart" viewBox={`0 0 ${size} ${size}`} style={{ maxWidth: size, margin: "0 auto" }}>
        {[0.25, 0.5, 0.75, 1].map((k) => (
          <polygon key={k} className="grid-line" fill="none" points={axes.map((_, i) => pt(i, max * k).join(",")).join(" ")} />
        ))}
        {axes.map((a, i) => {
          const [x, y] = pt(i, max);
          const [lx, ly] = pt(i, max * 1.17);
          return (
            <g key={a.key}>
              <line className="grid-line" x1={c} y1={c} x2={x} y2={y} />
              <text x={lx} y={ly + 4} textAnchor="middle" style={{ fontFamily: "var(--font-serif)", fontSize: 12, fill: "var(--ink-2)" }}>
                {a.label}
              </text>
            </g>
          );
        })}
        {shown.map((s, si) => (
          <g key={s.key}>
            <polygon
              points={axes.map((a, i) => pt(i, s.values[a.key] ?? 0).join(",")).join(" ")}
              fill={SERIES[si]}
              fillOpacity={0.12}
              stroke={SERIES[si]}
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {axes.map((a, i) => {
              const [x, y] = pt(i, s.values[a.key] ?? 0);
              return (
                <circle
                  key={a.key}
                  cx={x}
                  cy={y}
                  r={4}
                  fill={SERIES[si]}
                  stroke="var(--panel)"
                  strokeWidth={2}
                  onMouseMove={(e) => t.show(e, `${s.label} · ${a.label}：${s.values[a.key] ?? "—"}`)}
                  onMouseLeave={t.hide}
                />
              );
            })}
          </g>
        ))}
      </svg>
      {t.node}
    </div>
  );
}

// ───────── 热力矩阵（顺序色阶 seq-0..5） ─────────
export function seqColor(v: number, max: number): string {
  if (!(v > 0) || max <= 0) return "var(--seq-0)";
  const k = Math.min(5, Math.max(1, Math.ceil((v / max) * 5)));
  return `var(--seq-${k})`;
}
export function HeatGrid({
  rows,
  cols,
  value,
  format = (n: number) => String(Math.round(n)),
  max,
  showValues = true,
  cell = 34,
  rowLabelWidth = 110,
}: {
  rows: { key: string; label: ReactNode }[];
  cols: { key: string; label: ReactNode }[];
  value: (row: string, col: string) => number | undefined;
  format?: (n: number) => string;
  max?: number;
  showValues?: boolean;
  cell?: number;
  rowLabelWidth?: number;
}) {
  const t = useTip();
  const m = useMemo(() => max ?? Math.max(1, ...rows.flatMap((r) => cols.map((c) => value(r.key, c.key) ?? 0))), [rows, cols, value, max]);
  return (
    <div className="heatgrid" style={{ gridTemplateColumns: `${rowLabelWidth}px repeat(${cols.length}, minmax(${cell}px, 1fr))` }}>
      <div />
      {cols.map((c) => (
        <div key={c.key} className="hg-col">
          {c.label}
        </div>
      ))}
      {rows.map((r) => (
        <div key={r.key} style={{ display: "contents" }}>
          <div className="hg-row ellipsis">{r.label}</div>
          {cols.map((c) => {
            const v = value(r.key, c.key);
            const dark = v !== undefined && v / m > 0.55;
            return (
              <div
                key={c.key}
                className="hg-cell"
                style={{ background: v === undefined ? "transparent" : seqColor(v, m), color: dark ? "var(--seq-ink-hi)" : "var(--ink-2)", height: cell }}
                onMouseMove={(e) => t.show(e, <>{r.label} → {c.label}：{v === undefined ? "—" : format(v)}</>)}
                onMouseLeave={t.hide}
              >
                {showValues && v !== undefined && v > 0 ? format(v) : ""}
              </div>
            );
          })}
        </div>
      ))}
      {t.node}
    </div>
  );
}

// ───────── 迷你折线 ─────────
export function Sparkline({ values, width = 90, height = 24, color = "var(--series-1)" }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const m = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (width - 2) + 1},${height - 2 - (v / m) * (height - 4)}`).join(" ");
  return (
    <svg width={width} height={height} className="chart" style={{ width, height }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}
