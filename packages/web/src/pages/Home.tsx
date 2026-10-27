// 御书房：待办奏折、进行中诏令、用度与预算、告警、早朝纪要、御前来信、罢朝
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Edict, Message, Notification, OfficialStatus } from "@court/shared/types";
import type { BudgetStatus, LedgerSummaryRow, Overview } from "@court/shared/api";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo } from "../components/Addr.tsx";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { useConfirm } from "../components/Overlay.tsx";
import { Seal } from "../components/Seal.tsx";
import { StageBar } from "../components/StageBar.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { EdictStateTag, Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery, type QueryResult } from "../hooks/useQuery.ts";
import { EDICT_TERMINAL, NOTIF_CATEGORY, OFFICIAL_STATE } from "../lib/labels.ts";
import { fmtAgo, fmtCost, fmtDate, fmtPct, fmtTokens, truncate } from "../lib/format.ts";
import { NotifCard, optionSeal } from "./home/NotifCard.tsx";
import "../styles/pages/home.css";

type GroupKey = "all" | "decide" | "escalation" | "remonstrance" | "approval" | "impeachment" | "fyi";
const GROUPS: { key: Exclude<GroupKey, "all">; label: string }[] = [
  { key: "decide", label: "需决断" },
  { key: "escalation", label: "封驳升级" },
  { key: "remonstrance", label: "谏诤" },
  { key: "approval", label: "审批" },
  { key: "impeachment", label: "弹劾" },
  { key: "fyi", label: "仅知会" },
];
function groupOf(n: Notification): Exclude<GroupKey, "all"> {
  if (n.category === "escalation" || n.category === "remonstrance" || n.category === "approval" || n.category === "impeachment") return n.category;
  if (n.kind === "fyi") return "fyi";
  return "decide";
}

export default function HomePage() {
  const ov = useQuery(() => hub.overview(), [], { watch: ["notification.", "edict.", "task.state", "turn.", "court.halt", "dept."], interval: 30_000 });
  const notifs = useQuery(() => hub.notifications({ limit: 200 }), [], { watch: ["notification.", "audit.", "approval."] });
  const edicts = useQuery(() => hub.edicts({ limit: 100 }), [], { watch: ["edict.", "task.state"] });
  // hub 的 ledger/summary 默认只统计今日；诏令可跨日，取近 30 日
  const traceCost = useQuery(() => hub.ledgerSummary({ group: "trace", since: Date.now() - 30 * 86_400_000 }), [], { watch: ["llm."], interval: 60_000 });
  const budget = useQuery(() => hub.budgetStatus(), [], { watch: ["budget.", "llm."], interval: 60_000 });
  const inbox = useQuery(() => hub.emperorInbox({ limit: 30 }), [], { watch: ["message."] });

  return (
    <div className="page">
      <PageHead
        title="御书房"
        lede={`${fmtDate(Date.now())} · 万机待理，朱批在手`}
        actions={<HaltToggle overview={ov.data} reload={ov.reload} />}
      />
      {ov.error !== undefined && !ov.data && <ErrorBox error={ov.error} onRetry={ov.reload} />}
      <OverviewStats ov={ov.data} budget={budget.data} />

      <div className="home-grid">
        <div className="stack">
          <PendingNotifications q={notifs} />
          <ActiveEdicts edicts={edicts.data} error={edicts.error} loading={edicts.initial} costs={traceCost.data} budget={budget.data} />
        </div>
        <aside className="home-side">
          <BudgetGauge budget={budget.data} ov={ov.data} />
          <Alerts ov={ov.data} edicts={edicts.data} />
          <MorningBrief notifs={notifs.data} />
          <EmperorInbox q={inbox} />
        </aside>
      </div>
    </div>
  );
}

// ───────── 罢朝 ─────────
function HaltToggle({ overview, reload }: { overview?: Overview; reload: () => void }) {
  const confirm = useConfirm();
  const { run, pending } = useAction();
  const halted = !!overview?.halted;
  const toggle = async () => {
    const ok = await confirm(
      halted
        ? { title: "复朝？", body: "百官将恢复办事，网关重新放行模型调用。", okText: "复朝" }
        : {
            title: "罢朝？",
            body: (
              <>
                罢朝为全局急停：<b>网关拒绝一切模型调用</b>，百官暂停新的轮次，进行中的流程停泊待命。确认罢朝？
              </>
            ),
            okText: "罢朝",
            danger: true,
          },
    );
    if (!ok) return;
    const r = await run(() => hub.halt(!halted), halted ? "已复朝" : "已罢朝");
    if (r) reload();
  };
  return (
    <button className={`btn halt-btn ${halted ? "on" : "danger"}`} onClick={toggle} disabled={pending || !overview} title="全局急停">
      <span className="display">{halted ? "复" : "罢"}</span>
      {halted ? "复朝" : "罢朝"}
    </button>
  );
}

// ───────── 概览 ─────────
function countStates(sts: OfficialStatus[]) {
  const c = { busy: 0, waiting: 0, sleeping: 0, trouble: 0, vacant: 0, total: sts.length };
  for (const s of sts) {
    if (s.state === "thinking" || s.state === "tool") c.busy++;
    // 与朝堂一致：候命 = 等待 + 闲（例行候命），眠 = 主动就寝
    else if (s.state === "waiting" || s.state === "idle") c.waiting++;
    else if (s.state === "sleeping") c.sleeping++;
    else if (s.state === "vacant") c.vacant++;
    else c.trouble++;
  }
  return c;
}

function OverviewStats({ ov, budget }: { ov?: Overview; budget?: BudgetStatus }) {
  const c = countStates(ov?.statuses ?? []);
  const g = budget?.budgets.find((b) => b.scope === "global");
  return (
    <div className="grid g4 home-stats">
      <Stat
        label="今日用度"
        value={ov ? fmtTokens(ov.tokens_today) : "—"}
        unit="token"
        sub={
          <>
            折银 {ov ? fmtCost(ov.cost_today) : "—"}
            {g?.daily_tokens && ov ? ` · 日额 ${fmtPct(ov.tokens_today / g.daily_tokens)}` : ""}
          </>
        }
      />
      <Stat label="进行中诏令" value={ov?.edicts_active ?? "—"} unit="道" tone="red" sub={<Link to="/edicts">诏令调查 →</Link>} />
      <Stat label="未结任务" value={ov?.tasks_open ?? "—"} unit="件" tone="azure" sub={`待办 ${ov?.pending_notifications ?? "—"} 件`} />
      <Stat
        label="百官动静"
        value={
          <>
            <span title="思考或办事中">{c.busy}</span>
            <span className="stat-unit">思</span> {c.waiting}
            <span className="stat-unit">候</span> {c.sleeping}
            <span className="stat-unit">眠</span>
          </>
        }
        tone="jade"
        sub={
          <>
            共 {c.total} 职{c.trouble ? ` · 异常 ${c.trouble}` : ""}
            {c.vacant ? ` · 空缺 ${c.vacant}` : ""} · <Link to="/court">朝堂 →</Link>
          </>
        }
      />
    </div>
  );
}

// ───────── 待办 ─────────
function PendingNotifications({ q }: { q: QueryResult<Notification[]> }) {
  const [tab, setTab] = useState<GroupKey>("all");
  // 盖印动画期间保留已批之卡（事件驱动的重取可能先一步把它移走）
  const [holding, setHolding] = useState<Record<string, Notification>>({});
  const hold = (n: Notification) => setHolding((h) => ({ ...h, [n.id]: n }));
  const done = () => {
    setHolding({});
    q.reload();
  };
  const pending = useMemo(() => {
    const live = (q.data ?? []).filter((n) => n.status === "pending");
    const ids = new Set(live.map((n) => n.id));
    return [...live, ...Object.values(holding).filter((n) => !ids.has(n.id))].sort((a, b) => b.created_at - a.created_at);
  }, [q.data, holding]);
  const resolved = useMemo(() => (q.data ?? []).filter((n) => n.status !== "pending").sort((a, b) => (b.resolution?.at ?? b.created_at) - (a.resolution?.at ?? a.created_at)).slice(0, 15), [q.data]);
  const byGroup = useMemo(() => {
    const m = new Map<GroupKey, Notification[]>();
    for (const n of pending) {
      const g = groupOf(n);
      m.set(g, [...(m.get(g) ?? []), n]);
    }
    return m;
  }, [pending]);
  const actionCount = pending.filter((n) => n.kind === "action_required").length;

  return (
    <Card
      title="待办奏折"
      sub={pending.length ? `${actionCount} 件待决断 · ${pending.length - actionCount} 件知会` : undefined}
      actions={
        <button className="btn ghost sm" onClick={q.reload} disabled={q.loading}>
          刷新
        </button>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[{ key: "all" as GroupKey, label: "全部", count: pending.length }, ...GROUPS.map((g) => ({ key: g.key as GroupKey, label: g.label, count: byGroup.get(g.key)?.length ?? 0 }))]}
      />
      {q.initial ? (
        <Loading />
      ) : q.data === undefined && q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : pending.length === 0 ? (
        <Empty seal="清" text="案无积牍，四海晏然。" />
      ) : tab === "all" ? (
        GROUPS.filter((g) => byGroup.get(g.key)?.length).map((g) => (
          <section key={g.key} className="notif-section">
            <h3 className="notif-section-title">
              {g.label}
              <span className="count-badge">{byGroup.get(g.key)!.length}</span>
            </h3>
            <div className="notif-list">
              {byGroup.get(g.key)!.map((n) => (
                <NotifCard key={n.id} n={n} onResolved={done} onHold={hold} />
              ))}
            </div>
          </section>
        ))
      ) : (byGroup.get(tab) ?? []).length === 0 ? (
        <Empty seal="清" text="此类暂无待办" />
      ) : (
        <div className="notif-list">
          {byGroup.get(tab)!.map((n) => (
            <NotifCard key={n.id} n={n} onResolved={done} onHold={hold} />
          ))}
        </div>
      )}
      {resolved.length > 0 && (
        <details className="resolved-list" style={{ marginTop: 14 }}>
          <summary>近来已批 {resolved.length} 件</summary>
          {resolved.map((n) => {
            const opt = n.options.find((o) => o.id === n.resolution?.option);
            const s = optionSeal(n.resolution?.option ?? "", opt?.label ?? "");
            return (
              <div key={n.id} className="resolved-row">
                <Seal text={n.status === "dismissed" ? "略" : s.text} tone={s.tone} size={22} />
                <div className="ellipsis">
                  <Tag tone={NOTIF_CATEGORY[n.category]?.tone}>{NOTIF_CATEGORY[n.category]?.label ?? n.category}</Tag> {n.title}
                  {n.resolution?.comment && <span className="muted"> — 朱批：{n.resolution.comment}</span>}
                </div>
                <span className="small">{opt?.label ?? n.resolution?.option ?? n.status}</span>
                <span className="muted small">
                  <TimeAgo ms={n.resolution?.at ?? n.created_at} />
                </span>
              </div>
            );
          })}
        </details>
      )}
    </Card>
  );
}

// ───────── 进行中诏令 ─────────
const BLOCKED_STATES = new Set(["blocked_budget", "escalated", "remonstrated", "awaiting_sign"]);

function ActiveEdicts({
  edicts,
  error,
  loading,
  costs,
  budget,
}: {
  edicts?: Edict[];
  error: unknown;
  loading: boolean;
  costs?: LedgerSummaryRow[];
  budget?: BudgetStatus;
}) {
  const active = (edicts ?? []).filter((e) => !EDICT_TERMINAL.includes(e.state)).sort((a, b) => b.created_at - a.created_at);
  const costMap = new Map((costs ?? []).map((r) => [r.key, r]));
  return (
    <Card title="进行中诏令" sub={edicts ? `${active.length} 道` : undefined} actions={<Link to="/edicts" className="btn ghost sm">全部诏令 →</Link>}>
      {loading ? (
        <Loading />
      ) : !edicts && error ? (
        <ErrorBox error={error} />
      ) : active.length === 0 ? (
        <Empty seal="旨" text="尚无进行中的诏令。">
          <Link to="/decree" className="btn primary sm">
            颁旨
          </Link>
        </Empty>
      ) : (
        <div className="edict-cards">
          {active.map((e) => {
            const c = costMap.get(e.id);
            const used = c?.total_tokens ?? budget?.usage_today[`trace:${e.id}`]?.tokens ?? 0;
            const ratio = e.budget_tokens ? used / e.budget_tokens : 0;
            const blocked = BLOCKED_STATES.has(e.state);
            return (
              <Link key={e.id} to={`/edicts/${e.id}`} className={`card memorial edict-card ${blocked ? "blocked" : ""}`}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div className="ec-title grow">{e.title}</div>
                  <EdictStateTag state={e.state} />
                </div>
                <StageBar edict={e} compact />
                <div className="ec-meta">
                  <span>
                    颁于 <TimeAgo ms={e.created_at} />
                  </span>
                  <span>
                    此态 {fmtAgo(e.state_entered_at).replace("前", "")}
                  </span>
                  {e.deadline && <span>限 {fmtAgo(e.deadline)}</span>}
                  <span className="num">
                    {fmtTokens(used)} tok · {fmtCost(c?.cost)}
                  </span>
                  {blocked && (
                    <span style={{ color: "var(--vermilion)" }} className="pulse">
                      ● 阻塞待裁
                    </span>
                  )}
                  {e.skip_review && <Tag tone="ink">墨敕</Tag>}
                </div>
                {e.budget_tokens ? (
                  <div title={`预算 ${fmtTokens(e.budget_tokens)}，已用 ${fmtPct(ratio)}`}>
                    <div className={`budget-meter ${ratio >= 1 ? "over" : ""}`}>
                      <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                    </div>
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ───────── 预算仪表 ─────────
function BudgetGauge({ budget, ov }: { budget?: BudgetStatus; ov?: Overview }) {
  const g = budget?.budgets.find((b) => b.scope === "global");
  const usage = budget?.usage_today.global ?? (ov ? { tokens: ov.tokens_today, cost: ov.cost_today } : undefined);
  const limit = g?.daily_tokens;
  const ratio = limit && usage ? usage.tokens / limit : 0;
  const costRatio = g?.daily_cost && usage ? usage.cost / g.daily_cost : 0;
  const r = Math.max(ratio, costRatio);
  const R = 78;
  const arc = (k: number) => {
    const a = Math.PI * (1 - Math.min(1, k));
    return `${100 + R * Math.cos(a)},${100 - R * Math.sin(a)}`;
  };
  const color = r >= 1 ? "var(--bad)" : r >= 0.8 ? "var(--warn)" : "var(--jade)";
  return (
    <Card title="国用" sub="今日 · 全局日额" actions={<Link to="/ledger" className="btn ghost sm">账本 →</Link>}>
      {!budget && !ov ? (
        <Loading />
      ) : (
        <div className="gauge">
          <svg viewBox="0 0 200 112" aria-label={`今日用度占日额 ${fmtPct(r)}`}>
            <path d={`M 22 100 A ${R} ${R} 0 0 1 178 100`} fill="none" stroke="var(--rule)" strokeWidth={12} strokeLinecap="round" />
            {limit ? <path d={`M 22 100 A ${R} ${R} 0 0 1 ${arc(r)}`} fill="none" stroke={color} strokeWidth={12} strokeLinecap="round" /> : null}
            {[0.25, 0.5, 0.75].map((k) => {
              const a = Math.PI * (1 - k);
              return <line key={k} x1={100 + 64 * Math.cos(a)} y1={100 - 64 * Math.sin(a)} x2={100 + 70 * Math.cos(a)} y2={100 - 70 * Math.sin(a)} stroke="var(--rule-strong)" />;
            })}
          </svg>
          <div className="gauge-val">{limit ? fmtPct(r) : "—"}</div>
          <div className="gauge-sub">
            {fmtTokens(usage?.tokens)} / {limit ? fmtTokens(limit) : "未设日额"} token
            <br />
            {fmtCost(usage?.cost)}
            {g?.daily_cost ? ` / ${fmtCost(g.daily_cost)}` : ""}
          </div>
        </div>
      )}
    </Card>
  );
}

// ───────── 告警 ─────────
function Alerts({ ov, edicts }: { ov?: Overview; edicts?: Edict[] }) {
  const r = useRegistry();
  const items: { key: string; seal: string; tone: "red" | "plum" | "gold" | "ink"; body: React.ReactNode }[] = [];
  for (const [d, h] of Object.entries(ov?.depts_health ?? {})) {
    if (!h.ok) items.push({ key: `d-${d}`, seal: "断", tone: "red", body: <>
      <Link to={`/depts/${d}`}>{r.deptName(d)}</Link> 失联 · 最后心跳 {fmtAgo(h.last_seen)}
    </> });
  }
  for (const s of ov?.statuses ?? []) {
    if (s.state === "sick" || s.state === "suspended" || s.state === "offline") {
      const st = OFFICIAL_STATE[s.state];
      items.push({
        key: `s-${s.post_id}`,
        seal: st.icon,
        tone: s.state === "suspended" ? "red" : s.state === "sick" ? "plum" : "ink",
        body: (
          <>
            <Addr a={`post:${s.post_id}`} /> {st.label}
            {s.status_text && <span className="muted"> · {truncate(s.status_text, 24)}</span>}
          </>
        ),
      });
    }
  }
  for (const e of edicts ?? []) {
    if (e.state === "blocked_budget") items.push({ key: `e-${e.id}`, seal: "俸", tone: "gold", body: <>
      <Link to={`/edicts/${e.id}`}>{e.title}</Link> 预算熔断
    </> });
  }
  return (
    <Card title="告警" sub={items.length ? `${items.length} 起` : undefined}>
      {!ov ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty seal="安" text="诸司无恙" />
      ) : (
        items.map((it) => (
          <div key={it.key} className="alert-row">
            <Seal text={it.seal} tone={it.tone} size={22} />
            <div className="grow">{it.body}</div>
          </div>
        ))
      )}
    </Card>
  );
}

// ───────── 早朝纪要 ─────────
function MorningBrief({ notifs }: { notifs?: Notification[] }) {
  const brief = (notifs ?? [])
    .filter((n) => n.category === "progress" && n.from.startsWith("post:zhengshitang"))
    .sort((a, b) => b.created_at - a.created_at)[0];
  return (
    <Card title="早朝纪要" sub={brief ? <TimeAgo ms={brief.created_at} /> : undefined}>
      {!notifs ? (
        <Loading />
      ) : !brief ? (
        <Empty seal="朝" text="今日尚未早朝（政事堂每日辰时汇总）" />
      ) : (
        <>
          <div className="serif" style={{ fontWeight: 600, marginBottom: 4 }}>
            {brief.title}
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            <Addr a={brief.from} />
          </div>
          <Markdown text={brief.body} />
        </>
      )}
    </Card>
  );
}

// ───────── 御前来信 ─────────
function EmperorInbox({ q }: { q: QueryResult<Message[]> }) {
  return (
    <Card title="御前来信" sub={q.data ? `${q.data.length} 封` : undefined} actions={<Link to="/decree" className="btn ghost sm">私聊 →</Link>}>
      <QueryView q={q} empty={<Empty seal="函" text="尚无来信" />}>
        {(msgs) => (
          <div>
            {msgs.slice(0, 12).map((m) => {
              const post = m.from.startsWith("post:") ? m.from.slice(5) : undefined;
              return (
                <div key={m.id} className="inbox-row">
                  <div className="ir-head">
                    <Addr a={m.from} />
                    {m.requires_reply && <Tag tone="red">待复</Tag>}
                    <span className="muted small" style={{ marginLeft: "auto" }}>
                      <TimeAgo ms={m.created_at} />
                    </span>
                  </div>
                  <div className="ir-body clamp-3">
                    {m.subject && <b>{m.subject}：</b>}
                    {m.body}
                  </div>
                  <div className="row small" style={{ marginTop: 3 }}>
                    {post && <Link to={`/decree?chat=${post}`}>回复</Link>}
                    {m.trace_id && <Link to={`/edicts/${m.trace_id}`}>追踪</Link>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </QueryView>
    </Card>
  );
}
