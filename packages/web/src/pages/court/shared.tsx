// 朝堂/部门/官员页共用：官员牌、任务看板与抽屉、文书列表、资产浏览、定时表、用量面板、实时数据查询
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Asset, LedgerEntry, Message, OfficialState, OfficialStatus, PostDef, Schedule, Task } from "@court/shared/types";
import type { LedgerSummaryRow } from "@court/shared/api";
import { hub } from "../../api/client.ts";
import { useRegistry } from "../../api/registry.tsx";
import { Addr, TimeAgo, TraceLink } from "../../components/Addr.tsx";
import { BarList, TimeChart } from "../../components/charts.tsx";
import { JsonView } from "../../components/JsonView.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Drawer } from "../../components/Overlay.tsx";
import { Seal } from "../../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../../components/States.tsx";
import { Tag, TaskStateTag } from "../../components/Tag.tsx";
import { useQuery } from "../../hooks/useQuery.ts";
import { useNow } from "../../hooks/useNow.ts";
import { describeSpec } from "../../lib/cron.ts";
import { fmtBytes, fmtCost, fmtDateTime, fmtTime, fmtTokens, hourKeyMs } from "../../lib/format.ts";
import { MESSAGE_KIND, OFFICIAL_STATE, PRIORITY, SCHEDULE_STATUS, TASK_COLUMNS, TASK_STATE, VISIBILITY } from "../../lib/labels.ts";

// ───────── 实时数据查询（部门容器经 hub 代理；失败不触发「皇城失联」横幅） ─────────
export function useLiveQuery<T>(fn: () => Promise<T>, deps: unknown[], interval = 0) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const idRef = useRef(0);
  const reload = useCallback(() => {
    const id = ++idRef.current;
    setLoading(true);
    fnRef
      .current()
      .then((d) => id === idRef.current && (setData(d), setError(undefined)))
      .catch((e) => id === idRef.current && setError(e))
      .finally(() => id === idRef.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setData(undefined);
    reload();
  }, [reload]);
  useEffect(() => {
    if (!interval) return;
    const h = setInterval(reload, interval);
    return () => clearInterval(h);
  }, [reload, interval]);
  return { data, error, loading, reload };
}

// ───────── 状态元信息 ─────────
export const STATE_VAR: Record<OfficialState, string> = {
  thinking: "var(--vermilion)",
  tool: "var(--azure)",
  waiting: "var(--gold)",
  sleeping: "var(--ink-3)",
  idle: "var(--jade)",
  paused: "var(--ink-2)",
  suspended: "var(--bad)",
  sick: "var(--plum)",
  offline: "var(--ink-3)",
  vacant: "var(--rule-strong)",
};
export const STATE_ORDER: OfficialState[] = ["thinking", "tool", "waiting", "idle", "sleeping", "paused", "suspended", "sick", "offline", "vacant"];

/** 合成职位状态：心跳缺失时按名册判空缺/离线 */
export function statusForPost(p: PostDef, statuses: OfficialStatus[] | undefined, hasOfficial: boolean): OfficialStatus {
  const s = statuses?.find((x) => x.post_id === p.post_id);
  if (s) return hasOfficial ? s : { ...s, state: "vacant" };
  return {
    post_id: p.post_id,
    dept: p.dept,
    state: hasOfficial ? "offline" : "vacant",
    last_progress_at: 0,
    turns_last_hour: 0,
    tokens_today: 0,
    updated_at: 0,
  };
}

/** 状态一句话：等待谁、超时于；睡至何时 */
export function StateLine({ s }: { s: OfficialStatus }) {
  const now = useNow(30_000);
  if (s.state === "waiting") {
    const from = s.wait_filter?.from?.[0];
    return (
      <span>
        等待{from ? <> <Addr a={from} /></> : s.wait_filter?.reply_to ? "回信" : s.wait_filter?.notification_id ? "御批" : ""}
        {s.next_wake_at ? <span className="muted"> · 超时于 {fmtTime(s.next_wake_at).slice(0, 5)}</span> : null}
      </span>
    );
  }
  if (s.state === "sleeping" && s.next_wake_at) {
    const mins = Math.max(0, Math.round((s.next_wake_at - now) / 60_000));
    return (
      <span>
        睡至 {fmtTime(s.next_wake_at).slice(0, 5)} <span className="muted">（{mins >= 60 ? `${(mins / 60).toFixed(1)}时` : `${mins}分`}后）</span>
      </span>
    );
  }
  return null;
}

// ───────── 官员牌 ─────────
export function OfficialCard({ post, status, compact }: { post: PostDef; status: OfficialStatus; compact?: boolean }) {
  const r = useRegistry();
  const o = r.officialOf(post.post_id);
  const st = OFFICIAL_STATE[status.state] ?? OFFICIAL_STATE.idle;
  const model = o ? r.registry?.models.find((m) => m.key === o.model) : undefined;
  const win = model?.context_window ?? 128_000;
  const ctxPct = status.context_tokens ? Math.min(100, (status.context_tokens / win) * 100) : 0;
  const vacant = status.state === "vacant";
  const nav = useNavigate();
  const href = `/officials/${post.post_id}`;
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => nav(href)}
      onKeyDown={(e) => e.key === "Enter" && nav(href)}
      className={`hu st-${status.state} ${compact ? "compact" : ""}`}
      title={post.duties}
    >
      <div className="hu-top">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="hu-title">
            {post.title}
            {post.benguan ? ` · ${post.benguan}` : ""} · {post.rank}
          </div>
          <div className="hu-name">{vacant ? "（虚位以待）" : (o?.name ?? "—")}</div>
        </div>
        <div className="hu-state">
          <Seal text={st.icon} tone="" size={24} rotate={-4} />
          <span className="hu-state-label">{st.label}</span>
        </div>
      </div>
      {!vacant && (
        <>
          <div className="hu-text ellipsis">
            {status.state === "waiting" || status.state === "sleeping" ? <StateLine s={status} /> : (status.status_text ?? <span className="muted">—</span>)}
          </div>
          {!compact && (status.state === "waiting" || status.state === "sleeping") && status.status_text && <div className="hu-text ellipsis muted small">{status.status_text}</div>}
          <div className="hu-meta">
            <span title="今日用量">
              俸 <span className="num">{fmtTokens(status.tokens_today)}</span>
            </span>
            {status.turns_last_hour > 0 && (
              <span title="近一小时轮次">
                轮 <span className="num">{status.turns_last_hour}</span>
              </span>
            )}
            {status.current_trace_id && (
              <span className="ellipsis" style={{ maxWidth: 120 }}>
                <TraceLink id={status.current_trace_id}>⇢ {status.current_trace_id.replace(/^tr_/, "")}</TraceLink>
              </span>
            )}
          </div>
          {status.context_tokens ? (
            <div className={`ctx-bar ${ctxPct > 60 ? "hot" : ""}`} title={`上下文 ${fmtTokens(status.context_tokens)} / ${fmtTokens(win)}`}>
              <i style={{ width: `${ctxPct}%` }} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ───────── 任务看板 + 抽屉 ─────────
export function TaskCard({ t, onOpen, showDept }: { t: Task; onOpen: (id: string) => void; showDept?: boolean }) {
  const r = useRegistry();
  const now = useNow(60_000);
  const overdue = !!t.deadline && t.deadline < now && !["done", "cancelled", "failed"].includes(t.state);
  return (
    <div className={`task-card ${t.state === "blocked" ? "blocked" : ""} ${overdue ? "overdue" : ""}`} onClick={() => onOpen(t.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(t.id)}>
      {t.parent_id && <span className="sub-mark">↳ 子任务</span>}
      <div className="t-title">{t.title}</div>
      <div className="t-meta">
        {showDept && <Tag>{r.deptName(t.dept)}</Tag>}
        {t.assignee_post ? <Addr a={`post:${t.assignee_post}`} /> : <span>未派</span>}
      </div>
      {t.block_reason && t.state === "blocked" && <div className="small" style={{ color: "var(--bad)" }}>阻：{t.block_reason}</div>}
      <div className="t-meta">
        {t.deadline && <span className="t-deadline">限 {fmtDateTime(t.deadline)}</span>}
        {t.return_count > 0 && <Tag tone="red">退×{t.return_count}</Tag>}
        {t.edict_id && <TraceLink id={t.edict_id}>诏</TraceLink>}
      </div>
    </div>
  );
}

export function TaskBoard({ tasks, onOpen, showDept }: { tasks: Task[]; onOpen: (id: string) => void; showDept?: boolean }) {
  const extra = tasks.filter((t) => !TASK_COLUMNS.includes(t.state));
  const cols = [...TASK_COLUMNS.map((s) => ({ key: s as string, label: TASK_STATE[s].label, tone: TASK_STATE[s].tone, items: tasks.filter((t) => t.state === s) }))];
  if (extra.length) cols.push({ key: "other", label: "撤/败", tone: "ink", items: extra });
  return (
    <div className="board">
      {cols.map((c) => (
        <div key={c.key} className="board-col">
          <div className="board-col-head">
            <Tag tone={c.tone}>{c.label}</Tag>
            <span className="n">{c.items.length}</span>
          </div>
          <div className="board-col-body">
            {c.items.length === 0 ? <div className="muted small" style={{ textAlign: "center", padding: 8 }}>—</div> : c.items.map((t) => <TaskCard key={t.id} t={t} onOpen={onOpen} showDept={showDept} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TaskDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery(() => (id ? hub.task(id) : Promise.resolve(undefined)), [id], { watch: (e) => e.subject_id === id, enabled: !!id, interval: 0 });
  return (
    <Drawer open={!!id} onClose={onClose} title={q.data?.task.title ?? "任务"} width={620}>
      {q.initial ? (
        <Loading />
      ) : q.error && !q.data ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : q.data ? (
        <div className="stack">
          <div className="row wrap">
            <TaskStateTag state={q.data.task.state} />
            {q.data.task.edict_id && <TraceLink id={q.data.task.edict_id}>诏令调查 ⇢</TraceLink>}
            <span className="muted small mono">{q.data.task.id}</span>
          </div>
          <dl className="kv">
            <dt>承办</dt>
            <dd>{q.data.task.assignee_post ? <Addr a={`post:${q.data.task.assignee_post}`} /> : "未派"}</dd>
            <dt>交办</dt>
            <dd>
              <Addr a={q.data.task.creator} />
            </dd>
            <dt>核验</dt>
            <dd>{{ self: "自验", superior: "上官核验", xingbu: "刑部核验" }[q.data.task.verify_by]}</dd>
            <dt>期限</dt>
            <dd>{fmtDateTime(q.data.task.deadline)}</dd>
            <dt>入此状态</dt>
            <dd>
              <TimeAgo ms={q.data.task.state_entered_at} />
            </dd>
            {q.data.task.block_reason && (
              <>
                <dt>阻因</dt>
                <dd style={{ color: "var(--bad)" }}>{q.data.task.block_reason}</dd>
              </>
            )}
          </dl>
          {q.data.task.instructions && (
            <div>
              <h3>指示</h3>
              <Markdown text={q.data.task.instructions} />
            </div>
          )}
          {q.data.task.acceptance && (
            <div>
              <h3>验收</h3>
              <Markdown text={q.data.task.acceptance} />
            </div>
          )}
          {q.data.task.result && (
            <div>
              <h3>结果</h3>
              <Markdown text={q.data.task.result} />
              {q.data.task.result_assets.length > 0 && (
                <div className="row wrap small">
                  产物：
                  {q.data.task.result_assets.map((a) => (
                    <Link key={a} to={`/assets?id=${a}`} className="mono">
                      {a}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
          {q.data.children.length > 0 && (
            <div>
              <h3>子任务</h3>
              {q.data.children.map((c) => (
                <div key={c.id} className="row" style={{ padding: "4px 0" }}>
                  <TaskStateTag state={c.state} />
                  <span className="grow">{c.title}</span>
                  {c.assignee_post && <Addr a={`post:${c.assignee_post}`} />}
                </div>
              ))}
            </div>
          )}
          {q.data.comments.length > 0 && (
            <div>
              <h3>批注</h3>
              {q.data.comments.map((c) => (
                <div key={c.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--rule)" }}>
                  <div className="small muted">
                    <Addr a={c.author} /> · <TimeAgo ms={c.created_at} />
                  </div>
                  <div className="serif">{c.content}</div>
                </div>
              ))}
            </div>
          )}
          {q.data.transitions.length > 0 && (
            <div>
              <h3>流转</h3>
              {q.data.transitions.map((t) => (
                <div key={t.id} className="small" style={{ padding: "3px 0" }}>
                  <span className="mono muted">{fmtTime(t.at)}</span> {TASK_STATE[t.from_state as Task["state"]]?.label ?? t.from_state} → {TASK_STATE[t.to_state as Task["state"]]?.label ?? t.to_state} · <Addr a={t.actor} /> {t.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

// ───────── 文书列表 ─────────
export function MessageList({ messages, self, limit = 60 }: { messages: Message[]; self?: string[]; limit?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  if (messages.length === 0) return <Empty text="尚无文书往来" seal="牍" />;
  return (
    <div className="msg-list">
      {messages.slice(0, limit).map((m) => {
        const out = self ? self.includes(m.from) : false;
        return (
          <div key={m.id} className={`msg-row ${open === m.id ? "open" : ""}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
            <span className={`dir ${out ? "out" : ""}`} title={out ? "发出" : "收到"}>
              {out ? "出" : "入"}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="m-head">
                <Addr a={m.from} />
                <span className="muted">→</span>
                <Addr a={m.to} />
                <Tag>{MESSAGE_KIND[m.kind] ?? m.kind}</Tag>
                {m.priority !== "normal" && m.priority !== "low" && <Tag tone={PRIORITY[m.priority].tone}>{PRIORITY[m.priority].label}</Tag>}
                {m.requires_reply && <Tag tone="gold">需复</Tag>}
              </div>
              <div className="m-subject">{m.subject}</div>
              <div className="m-body clamp-2">{m.body}</div>
              {open === m.id && (
                <div className="small muted" style={{ marginTop: 4 }}>
                  {m.trace_id && <TraceLink id={m.trace_id} />} · 线程 <span className="mono">{m.thread_id}</span> · 跳数 {m.hop_count}
                </div>
              )}
            </div>
            <span className="m-time">
              <TimeAgo ms={m.created_at} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ───────── 资产浏览（列表 + 预览） ─────────
function isMemory(a: Asset) {
  return /(^|\/)memory\.md$/i.test(a.path);
}
export function AssetBrowser({ assets }: { assets: Asset[] }) {
  const sorted = useMemo(() => [...assets].sort((a, b) => Number(isMemory(b)) - Number(isMemory(a)) || b.updated_at - a.updated_at), [assets]);
  const [sel, setSel] = useState<string | null>(sorted[0]?.id ?? null);
  useEffect(() => {
    if (!sel && sorted[0]) setSel(sorted[0].id);
  }, [sorted, sel]);
  const content = useQuery(() => (sel ? hub.asset(sel, "emperor") : Promise.resolve(undefined)), [sel], { enabled: !!sel, interval: 0 });
  if (assets.length === 0) return <Empty text="尚无资产" seal="藏" />;
  return (
    <div className="asset-browser">
      <div className="asset-list">
        {sorted.map((a) => {
          const vis = a.shared_with.length > 0 ? VISIBILITY.shared : VISIBILITY[a.visibility];
          return (
            <div key={a.id} className={`asset-item ${sel === a.id ? "active" : ""} ${isMemory(a) ? "memory" : ""}`} onClick={() => setSel(a.id)}>
              {isMemory(a) ? <Seal text="忆" tone="red" size={18} /> : <Tag tone={vis.tone}>{vis.label}</Tag>}
              <span className="grow ellipsis" title={a.path}>
                {a.path}
              </span>
              <span className="muted small">v{a.latest_version}</span>
            </div>
          );
        })}
      </div>
      <div className="asset-preview" style={{ minWidth: 0 }}>
        {!sel ? null : content.initial ? (
          <Loading />
        ) : content.error && !content.data ? (
          <ErrorBox error={content.error} onRetry={content.reload} />
        ) : content.data ? (
          <>
            <div className="row wrap small muted" style={{ marginBottom: 8 }}>
              <span className="mono">{content.data.asset.path}</span>
              <span>· {content.data.asset.mime}</span>
              <span>· {fmtBytes(content.data.asset.size)}</span>
              <span>· v{content.data.version}</span>
              <span>
                · <TimeAgo ms={content.data.asset.updated_at} />
              </span>
              <Link to={`/assets?id=${content.data.asset.id}`}>资产库 ⇢</Link>
            </div>
            <AssetContentView mime={content.data.asset.mime} path={content.data.asset.path} content={content.data.content} encoding={content.data.encoding} />
          </>
        ) : null}
      </div>
    </div>
  );
}

export function AssetContentView({ mime, path, content, encoding }: { mime: string; path: string; content: string; encoding: "utf8" | "base64" }) {
  if (encoding === "base64") {
    if (mime.startsWith("image/")) return <img src={`data:${mime};base64,${content}`} alt={path} />;
    return <div className="muted">二进制资产（{mime}），不可预览。</div>;
  }
  if (mime.includes("markdown") || /\.md$/i.test(path)) return <Markdown text={content} />;
  if (mime.includes("json") || /\.json$/i.test(path)) return <JsonView value={content} />;
  return <pre className="code-block">{content}</pre>;
}

// ───────── 定时任务表 ─────────
export function ScheduleTable({ schedules, showOwner }: { schedules: Schedule[]; showOwner?: boolean }) {
  if (schedules.length === 0) return <Empty text="无定时任务" seal="时" />;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>名目</th>
            {showOwner && <th>归属</th>}
            <th>规则</th>
            <th>下次</th>
            <th className="num">已行</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => {
            const st = SCHEDULE_STATUS[s.status] ?? { label: s.status, tone: "" as const };
            return (
              <tr key={s.id}>
                <td>
                  <div className="serif">{s.title}</div>
                  <div className="muted small clamp-2" title={s.payload}>
                    {s.payload}
                  </div>
                </td>
                {showOwner && (
                  <td>
                    <Addr a={s.owner} />
                  </td>
                )}
                <td className="small">{describeSpec(s.spec)}</td>
                <td className="small">{s.next_run_at ? <TimeAgo ms={s.next_run_at} /> : "—"}</td>
                <td className="num">
                  {s.run_count}
                  {s.missed_count > 0 && <span style={{ color: "var(--bad)" }}> / 误{s.missed_count}</span>}
                </td>
                <td>
                  <Tag tone={st.tone}>{st.label}</Tag>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────── 用量：按小时（近 24h）补零 ─────────
const HOUR = 3_600_000;
export function hourSeries(rows: { ts: number; tokens: number }[], hours = 24, now = Date.now()) {
  const end = Math.floor(now / HOUR) * HOUR;
  const xs = Array.from({ length: hours }, (_, i) => end - (hours - 1 - i) * HOUR);
  const vals = xs.map(() => 0);
  for (const r of rows) {
    const i = Math.floor((r.ts - xs[0]) / HOUR);
    if (i >= 0 && i < hours) vals[i] += r.tokens;
  }
  return { xs, vals };
}
export const hourLabel = (x: number) => `${fmtTime(x).slice(0, 2)}时`;

export function HourlyTokens({ rows }: { rows: LedgerSummaryRow[] }) {
  // hub 的时辰键为北京时间 "YYYY-MM-DD HH:00"
  const { xs, vals } = hourSeries(
    rows.flatMap((r) => {
      const ts = hourKeyMs(r.key);
      return ts === undefined ? [] : [{ ts, tokens: r.total_tokens }];
    }),
  );
  if (vals.every((v) => v === 0)) return <Empty text="近一日无用量" seal="俸" />;
  return <TimeChart xs={xs} series={[{ key: "t", label: "tokens", values: vals }]} xLabel={hourLabel} height={150} />;
}

export function LedgerPanel({ entries }: { entries: LedgerEntry[] }) {
  const { xs, vals } = hourSeries(entries.map((e) => ({ ts: e.ts, tokens: e.total_tokens })));
  const byModel = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(`${e.provider}/${e.model}`, (m.get(`${e.provider}/${e.model}`) ?? 0) + e.total_tokens);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: k.split("/")[1] ?? k, value: v }));
  }, [entries]);
  const tot = entries.reduce((s, e) => s + e.total_tokens, 0);
  const cost = entries.reduce((s, e) => s + e.cost, 0);
  const errs = entries.filter((e) => !e.ok).length;
  if (entries.length === 0) return <Empty text="近一日无用量" seal="俸" />;
  return (
    <div className="stack">
      <div className="grid g4">
        <div className="stat">
          <div className="stat-label">调用</div>
          <div className="stat-value">{entries.length}</div>
        </div>
        <div className="stat red">
          <div className="stat-label">tokens</div>
          <div className="stat-value">{fmtTokens(tot)}</div>
        </div>
        <div className="stat jade">
          <div className="stat-label">花费</div>
          <div className="stat-value">{fmtCost(cost)}</div>
        </div>
        <div className="stat azure">
          <div className="stat-label">出错</div>
          <div className="stat-value">{errs}</div>
        </div>
      </div>
      <div>
        <h3 style={{ marginBottom: 6 }}>近二十四时 · tokens</h3>
        <TimeChart xs={xs} series={[{ key: "t", label: "tokens", values: vals }]} xLabel={hourLabel} height={160} />
      </div>
      <div>
        <h3 style={{ marginBottom: 6 }}>按模型</h3>
        <BarList data={byModel} format={fmtTokens} color="var(--series-2)" />
      </div>
    </div>
  );
}

export { QueryView };
