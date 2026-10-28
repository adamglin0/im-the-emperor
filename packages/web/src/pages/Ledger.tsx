// 户部账本：用量与成本（按部门/官员/模型/诏令/时辰/用途），预算（可改），审批
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Approval, Budget } from "@court/shared/types";
import type { LedgerSummaryQuery, LedgerSummaryRow } from "@court/shared/api";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo } from "../components/Addr.tsx";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { BarList, TimeChart, type SeriesDef } from "../components/charts.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { useConfirm } from "../components/Overlay.tsx";
import { PostPicker } from "../components/PostPicker.tsx";
import { Empty, QueryView } from "../components/States.tsx";
import { Seg } from "../components/Tabs.tsx";
import { Tag } from "../components/Tag.tsx";
import { useToast } from "../components/Toast.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useNow } from "../hooks/useNow.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { fmtCompact, fmtCost, fmtDateTime, fmtPct, fmtTokens, hourKeyMs, startOfTodayShanghai } from "../lib/format.ts";
import type { Tone } from "../lib/labels.ts";
import "../styles/pages/ops.css";

type Range = "today" | "24h" | "7d";
type Group = LedgerSummaryQuery["group"];
type Metric = "tokens" | "cost";

const GROUPS: { key: Group; label: string }[] = [
  { key: "dept", label: "部门" },
  { key: "post", label: "官员" },
  { key: "model", label: "模型" },
  { key: "trace", label: "诏令" },
  { key: "hour", label: "时辰" },
  { key: "purpose", label: "用途" },
];
const PURPOSE: Record<string, string> = { turn: "办事轮次", compaction: "压缩记忆", exam: "科举应试", grading: "阅卷", other: "其他" };
const APPROVAL_TYPE: Record<Approval["type"], string> = {
  config_change: "改配置",
  personnel: "人事",
  schedule: "定时",
  asset_access: "阅私产",
  budget: "预算",
  new_official: "增员",
  mcp_config: "MCP 配置",
};
const APPROVAL_STATUS: Record<Approval["status"], { label: string; tone: Tone }> = {
  pending: { label: "待批", tone: "gold" },
  approved: { label: "已准", tone: "jade" },
  rejected: { label: "已驳", tone: "red" },
};
const HOUR = 3_600_000;

function useSince(range: Range): number {
  const tick = useNow(300_000);
  return useMemo(() => (range === "today" ? startOfTodayShanghai(tick) : tick - (range === "24h" ? 24 : 168) * HOUR), [range, tick]);
}

export default function LedgerPage() {
  const r = useRegistry();
  const nav = useNavigate();
  const [range, setRange] = useState<Range>("today");
  const [group, setGroup] = useState<Group>("dept");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [stacked, setStacked] = useState(true);
  const since = useSince(range);
  const watch = ["ledger.", "llm."];

  const summary = useQuery(() => hub.ledgerSummary({ group, since }), [group, since], { watch, interval: 60_000 });
  const entries = useQuery(() => hub.ledger({ since, limit: 5000 }), [since], { watch, interval: 120_000 });
  const hourly = useQuery(
    async () => {
      const total = await hub.ledgerSummary({ group: "hour", since });
      if (!stacked) return { total, parts: [] as { key: string; rows: LedgerSummaryRow[] }[] };
      const depts = await hub.ledgerSummary({ group: "dept", since });
      const top = [...depts].sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 3);
      const parts = await Promise.all(top.map((d) => hub.ledgerSummary({ group: "hour", since, filter_scope: `dept:${d.key}` }).then((rows) => ({ key: d.key, rows }))));
      return { total, parts };
    },
    [since, stacked],
    { watch, interval: 60_000 },
  );
  const edicts = useQuery(() => hub.edicts({ limit: 300 }), [], { watch: ["edict."], interval: 0 });
  const edictTitle = useMemo(() => new Map((edicts.data ?? []).map((e) => [e.id, e.title])), [edicts.data]);

  const totals = useMemo(() => {
    const rows = summary.data ?? [];
    return rows.reduce((a, x) => ({ tokens: a.tokens + x.total_tokens, cost: a.cost + x.cost, calls: a.calls + x.calls, input: a.input + x.input, output: a.output + x.output }), {
      tokens: 0,
      cost: 0,
      calls: 0,
      input: 0,
      output: 0,
    });
  }, [summary.data]);
  const errStats = useMemo(() => {
    const es = entries.data ?? [];
    const fail = es.filter((e) => !e.ok).length;
    return { n: es.length, fail, rate: es.length ? fail / es.length : undefined };
  }, [entries.data]);

  const label = (k: string): string => {
    switch (group) {
      case "dept":
        return r.deptName(k);
      case "post":
        return r.postLabel(k);
      case "official": {
        const o = r.officialById(k);
        return o ? o.name : k;
      }
      case "trace":
        return k ? (edictTitle.get(k) ?? k) : "（无追踪）";
      case "hour": {
        const t = hourKeyMs(k);
        return t ? fmtDateTime(t) : k;
      }
      case "purpose":
        return PURPOSE[k] ?? k;
      default:
        return k;
    }
  };
  const hrefOf = (k: string): string | undefined => {
    if (group === "dept") return `/depts/${k}`;
    if (group === "post") return `/officials/${k}`;
    if (group === "trace" && k && k !== "—") return `/edicts/${k}`;
    return undefined;
  };

  // 逐时序列
  const chart = useMemo(() => {
    const d = hourly.data;
    if (!d) return null;
    const start = Math.floor(since / HOUR) * HOUR;
    const end = Math.floor(Date.now() / HOUR) * HOUR;
    const xs: number[] = [];
    for (let t = start; t <= end; t += HOUR) xs.push(t);
    const pick = (rows: LedgerSummaryRow[]) => {
      const m = new Map<number, number>();
      for (const x of rows) {
        const t = hourKeyMs(x.key);
        if (t === undefined) continue;
        const h = Math.floor(t / HOUR) * HOUR;
        m.set(h, (m.get(h) ?? 0) + (metric === "tokens" ? x.total_tokens : x.cost));
      }
      return xs.map((h) => m.get(h) ?? 0);
    };
    const total = pick(d.total);
    if (!stacked || d.parts.length === 0) return { xs, series: [{ key: "all", label: metric === "tokens" ? "token" : "花费", values: total }] as SeriesDef[] };
    const parts = d.parts.map((p) => ({ key: p.key, label: r.deptName(p.key), values: pick(p.rows) }));
    const other = total.map((v, i) => Math.max(0, v - parts.reduce((s, p) => s + p.values[i], 0)));
    const series: SeriesDef[] = [...parts];
    if (other.some((v) => v > 0)) series.push({ key: "other", label: "其他各部", values: other });
    return { xs, series };
  }, [hourly.data, since, stacked, metric, r]);

  const rows = useMemo(() => [...(summary.data ?? [])].sort((a, b) => (group === "hour" ? (hourKeyMs(a.key) ?? 0) - (hourKeyMs(b.key) ?? 0) : b.total_tokens - a.total_tokens)), [summary.data, group]);
  const val = (x: LedgerSummaryRow) => (metric === "tokens" ? x.total_tokens : x.cost);
  const fmtVal = metric === "tokens" ? fmtTokens : fmtCost;

  return (
    <div className="page ops-page">
      <PageHead title="户部账本" lede="度支郎中掌之：每次 LLM 调用一行，按网关权威记账。" />

      <div className="toolbar ledger-filters">
        <span className="muted small serif">时段</span>
        <Seg<Range>
          options={[
            { key: "today", label: "今日" },
            { key: "24h", label: "近一日" },
            { key: "7d", label: "近七日" },
          ]}
          value={range}
          onChange={setRange}
        />
        <span className="muted small serif" style={{ marginLeft: 12 }}>
          分组
        </span>
        <Seg<Group> options={GROUPS} value={group} onChange={setGroup} />
        <span className="muted small serif" style={{ marginLeft: 12 }}>
          度量
        </span>
        <Seg<Metric>
          options={[
            { key: "tokens", label: "token" },
            { key: "cost", label: "花费" },
          ]}
          value={metric}
          onChange={setMetric}
        />
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="用量" value={fmtTokens(totals.tokens)} unit="token" sub={`入 ${fmtCompact(totals.input)} · 出 ${fmtCompact(totals.output)}`} tone="red" />
        <Stat label="花费" value={fmtCost(totals.cost)} sub={totals.calls ? `每次约 ${fmtCost(totals.cost / totals.calls)}` : undefined} />
        <Stat label="调用" value={totals.calls.toLocaleString("zh-CN")} unit="次" sub={totals.calls ? `每次约 ${fmtTokens(totals.tokens / totals.calls)} token` : undefined} tone="azure" />
        <Stat
          label="失败率"
          value={errStats.rate === undefined ? "—" : fmtPct(errStats.rate, 1)}
          sub={errStats.n ? `${errStats.fail} / ${errStats.n} 次失败${errStats.n >= 5000 ? "（取样）" : ""}` : "无记录"}
          tone={errStats.rate && errStats.rate > 0.05 ? "red" : "jade"}
        />
      </div>

      <Card
        title="逐时用量"
        sub={stacked ? "前三部门堆叠，余者并入「其他各部」" : "全朝合计"}
        actions={
          <label className="row small">
            <input type="checkbox" checked={stacked} onChange={(e) => setStacked(e.target.checked)} /> 按部门堆叠
          </label>
        }
        style={{ marginBottom: 16 }}
      >
        <QueryView q={hourly} isEmpty={(d) => d.total.length === 0} empty={<Empty text="此时段尚无用量" seal="账" />}>
          {() =>
            chart && (
              <TimeChart
                xs={chart.xs}
                series={chart.series}
                kind="bar"
                stacked={stacked}
                height={200}
                format={metric === "tokens" ? fmtCompact : (n) => fmtCost(n)}
                xLabel={(x) => {
                  const s = fmtDateTime(x);
                  return range === "7d" ? s.slice(0, 5) + " " + s.slice(-5, -3) + "时" : s.slice(-5, -3) + "时";
                }}
              />
            )
          }
        </QueryView>
      </Card>

      <div className="grid ledger-split" style={{ marginBottom: 16 }}>
        <Card title={`按${GROUPS.find((g) => g.key === group)?.label}`} sub={`${rows.length} 项`}>
          <QueryView q={summary} empty={<Empty text="此时段尚无用量" seal="账" />}>
            {() => (
              <BarList
                data={[...rows]
                  .sort((a, b) => (group === "hour" ? 0 : val(b) - val(a)))
                  .map((x) => ({
                    key: x.key,
                    label: label(x.key),
                    value: val(x),
                    tip: (
                      <>
                        <div>{label(x.key)}</div>
                        <div>
                          {fmtTokens(x.total_tokens)} token · {fmtCost(x.cost)} · {x.calls} 次
                        </div>
                      </>
                    ),
                  }))}
                format={fmtVal}
                limit={group === "hour" ? 48 : 16}
                onClick={(d) => {
                  const h = hrefOf(d.key);
                  if (h) nav(h);
                }}
              />
            )}
          </QueryView>
        </Card>
        <Card title="明细" flush>
          <QueryView q={summary} empty={<Empty text="无" />}>
            {() => (
              <div className="table-wrap" style={{ maxHeight: 420 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{GROUPS.find((g) => g.key === group)?.label}</th>
                      <th className="num">次</th>
                      <th className="num">入</th>
                      <th className="num">出</th>
                      <th className="num">合计</th>
                      <th className="num">花费</th>
                      <th className="num">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => {
                      const h = hrefOf(x.key);
                      return (
                        <tr key={x.key} className={h ? "clickable" : ""} onClick={() => h && nav(h)}>
                          <td className="ellipsis" style={{ maxWidth: 220 }} title={x.key}>
                            {label(x.key)}
                          </td>
                          <td className="num">{x.calls}</td>
                          <td className="num">{fmtCompact(x.input)}</td>
                          <td className="num">{fmtCompact(x.output)}</td>
                          <td className="num">{fmtTokens(x.total_tokens)}</td>
                          <td className="num">{fmtCost(x.cost)}</td>
                          <td className="num muted">{totals.tokens ? fmtPct(x.total_tokens / totals.tokens, 1) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        </Card>
      </div>

      <BudgetsCard edictTitle={edictTitle} />
      <ApprovalsCard />
    </div>
  );
}

// ───────── 预算 ─────────
const SCOPE_ORDER = ["global", "dept", "post", "trace"];
const SCOPE_KIND: Record<string, string> = { global: "全朝", dept: "部门", post: "官员", trace: "诏令" };

function BudgetsCard({ edictTitle }: { edictTitle: Map<string, string> }) {
  const r = useRegistry();
  const toast = useToast();
  const { run, pending } = useAction();
  const q = useQuery(() => hub.budgetStatus(), [], { watch: ["budget.", "ledger."], interval: 60_000 });
  const [edit, setEdit] = useState<{ scope: string; tokens: string; cost: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const scopeLabel = (s: string) => {
    if (s === "global") return "全朝";
    const [k, ...rest] = s.split(":");
    const id = rest.join(":");
    if (k === "dept") return r.deptName(id);
    if (k === "post") return r.postLabel(id);
    if (k === "trace") return edictTitle.get(id) ?? id;
    return s;
  };
  const save = async (scope: string, tokens: string, cost: string) => {
    const res = await run(() =>
      hub.setBudget({ actor: "emperor", scope, daily_tokens: tokens.trim() === "" ? null : Number(tokens), daily_cost: cost.trim() === "" ? null : Number(cost) }),
    );
    if (!res) return false;
    if ("status" in res && res.status === "pending_approval") toast("预算调整已呈请批准", "info");
    else toast("预算已定", "ok");
    setEdit(null);
    q.reload();
    return true;
  };

  return (
    <Card
      title="预算"
      sub="日额：token 与花费双维度；超额则停俸或诏令阻塞"
      flush
      style={{ marginBottom: 16 }}
      actions={
        <button className={`btn sm ${adding ? "gold" : ""}`} onClick={() => setAdding(!adding)}>
          {adding ? "收起" : "＋ 增设预算"}
        </button>
      }
    >
      {adding && <AddBudget onSave={async (s, t, c) => (await save(s, t, c)) && setAdding(false)} pending={pending} />}
      <QueryView q={q} isEmpty={(d) => d.budgets.length === 0} empty={<Empty text="尚未设预算：一切调用不设上限" seal="俸" />}>
        {(d) => {
          const sorted = [...d.budgets].sort((a, b) => SCOPE_ORDER.indexOf(a.scope.split(":")[0]) - SCOPE_ORDER.indexOf(b.scope.split(":")[0]) || a.scope.localeCompare(b.scope));
          return (
            <div className="table-wrap">
              <table className="tbl budget-tbl">
                <thead>
                  <tr>
                    <th>类</th>
                    <th>范围</th>
                    <th className="num">日额 token</th>
                    <th className="num">日额花费</th>
                    <th className="num">今日已用</th>
                    <th style={{ minWidth: 180 }}>进度</th>
                    <th>改者</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((b) => {
                    const u = d.usage_today[b.scope] ?? { tokens: 0, cost: 0 };
                    const ratio = budgetRatio(b, u);
                    const editing = edit?.scope === b.scope;
                    const [kind, ...rest] = b.scope.split(":");
                    const href = kind === "dept" ? `/depts/${rest.join(":")}` : kind === "post" ? `/officials/${rest.join(":")}` : kind === "trace" ? `/edicts/${rest.join(":")}` : undefined;
                    return (
                      <tr key={b.scope}>
                        <td>
                          <Tag tone={kind === "global" ? "red" : kind === "trace" ? "gold" : kind === "dept" ? "azure" : ""}>{SCOPE_KIND[kind] ?? kind}</Tag>
                        </td>
                        <td className="ellipsis" style={{ maxWidth: 260 }}>
                          {href ? <Link to={href}>{scopeLabel(b.scope)}</Link> : scopeLabel(b.scope)}
                        </td>
                        <td className="num">
                          {editing ? (
                            <input type="number" min={0} className="budget-input" value={edit.tokens} onChange={(e) => setEdit({ ...edit, tokens: e.target.value })} placeholder="不限" />
                          ) : b.daily_tokens ? (
                            fmtTokens(b.daily_tokens)
                          ) : (
                            <span className="muted">不限</span>
                          )}
                        </td>
                        <td className="num">
                          {editing ? (
                            <input type="number" min={0} step="0.01" className="budget-input" value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} placeholder="不限" />
                          ) : b.daily_cost ? (
                            fmtCost(b.daily_cost)
                          ) : (
                            <span className="muted">不限</span>
                          )}
                        </td>
                        <td className="num">
                          {fmtTokens(u.tokens)}
                          <div className="muted small">{fmtCost(u.cost)}</div>
                        </td>
                        <td>
                          {ratio === undefined ? (
                            <span className="muted small">—</span>
                          ) : (
                            <div className={`budget-bar ${ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok"}`} title={fmtPct(ratio, 1)}>
                              <div className="bb-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                              <span className="bb-text num">
                                {fmtPct(ratio, 0)}
                                {ratio >= 1 ? " 已超" : ratio >= 0.8 ? " 将尽" : ""}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="small">
                          <Addr a={b.updated_by} />
                          <div className="muted">
                            <TimeAgo ms={b.updated_at} />
                          </div>
                        </td>
                        <td>
                          {editing ? (
                            <div className="btn-row" style={{ flexWrap: "nowrap" }}>
                              <button className="btn sm primary" disabled={pending} onClick={() => save(b.scope, edit.tokens, edit.cost)}>
                                定
                              </button>
                              <button className="btn sm ghost" onClick={() => setEdit(null)}>
                                罢
                              </button>
                            </div>
                          ) : (
                            <button className="btn sm ghost" onClick={() => setEdit({ scope: b.scope, tokens: b.daily_tokens ? String(b.daily_tokens) : "", cost: b.daily_cost ? String(b.daily_cost) : "" })}>
                              改
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}

function budgetRatio(b: Budget, u: { tokens: number; cost: number }): number | undefined {
  const rs: number[] = [];
  if (b.daily_tokens) rs.push(u.tokens / b.daily_tokens);
  if (b.daily_cost) rs.push(u.cost / b.daily_cost);
  return rs.length ? Math.max(...rs) : undefined;
}

function AddBudget({ onSave, pending }: { onSave: (scope: string, tokens: string, cost: string) => void; pending: boolean }) {
  const r = useRegistry();
  const [kind, setKind] = useState<"global" | "dept" | "post" | "trace">("dept");
  const [target, setTarget] = useState("");
  const [tokens, setTokens] = useState("");
  const [cost, setCost] = useState("");
  const edicts = useQuery(() => hub.edicts({ limit: 200 }), [], { enabled: kind === "trace", interval: 0 });
  const scope = kind === "global" ? "global" : target ? `${kind}:${target}` : "";
  return (
    <div className="add-budget">
      <label className="field">
        <span className="label">类</span>
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setTarget("");
          }}
        >
          <option value="global">全朝</option>
          <option value="dept">部门</option>
          <option value="post">官员</option>
          <option value="trace">诏令</option>
        </select>
      </label>
      <div className="field" style={{ minWidth: 240, flex: 2 }}>
        <span className="label">范围</span>
        {kind === "global" && <div className="muted serif" style={{ padding: "6px 0" }}>全朝总额</div>}
        {kind === "dept" && (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">择部门…</option>
            {r.depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        {kind === "post" && <PostPicker value={target} onChange={setTarget} mode="post" includeDepts={false} />}
        {kind === "trace" && (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">择诏令…</option>
            {(edicts.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        )}
      </div>
      <label className="field">
        <span className="label">日额 token</span>
        <input type="number" min={0} value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="不限" />
      </label>
      <label className="field">
        <span className="label">日额花费（$）</span>
        <input type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="不限" />
      </label>
      <button className="btn primary" disabled={!scope || pending || (!tokens && !cost)} onClick={() => onSave(scope, tokens, cost)}>
        设预算
      </button>
    </div>
  );
}

// ───────── 审批 ─────────
/** 审批内容的人话摘要；原始 payload 折叠在下 */
function ApprovalSummary({ a }: { a: Approval }) {
  const r = useRegistry();
  const p = a.payload as Record<string, any>;
  const post = (x: unknown) => (typeof x === "string" ? r.addrLabel(x.includes(":") ? x : `post:${x}`) : "");
  let text: React.ReactNode = null;
  try {
    switch (a.type) {
      case "config_change": {
        const ch = (p.changes ?? {}) as Record<string, unknown>;
        const parts = Object.entries(ch).map(([k, v]) =>
          k === "thinking" ? `思考强度 → ${String(v)}` : k === "prompt_overrides" ? "改个人提示词" : k === "extra_tool_groups" ? `加授工具组 ${(v as string[]).join("、")}` : k === "disabled_tool_groups" ? `禁用工具组 ${(v as string[]).join("、")}` : `${k} → ${JSON.stringify(v)}`,
        );
        text = <>改 <b>{post(p.target_post)}</b> 配置：{parts.join("；") || "—"}</>;
        break;
      }
      case "budget":
        text = <>预算 <b>{String(p.scope ?? "")}</b>：日额 {p.daily_tokens ? `${fmtTokens(p.daily_tokens)} token` : "—"}{p.daily_cost ? ` · ${fmtCost(p.daily_cost)}` : ""}</>;
        break;
      case "schedule":
        text = <>定时 {String(p.title ?? p.schedule_id ?? "")}{p.every_seconds ? `：每 ${Math.round(p.every_seconds / 60)} 分钟` : p.spec?.cron ? `：${p.spec.cron}` : ""}</>;
        break;
      case "personnel":
      case "new_official":
        text = <>{String(p.action ?? a.type)} {post(p.post_id ?? p.to_post_id)} {p.official_id ? `（${p.official_id}）` : ""} {p.model ? `模型 ${p.model}` : ""}</>;
        break;
      case "asset_access":
        text = <>阅 {String(p.asset_id ?? p.path ?? "私产")}</>;
        break;
      case "mcp_config": {
        const s = (p.server ?? p.config ?? {}) as Record<string, unknown>;
        const sid = String(s.id ?? p.id ?? p.server_id ?? "");
        text = <>MCP 服务器 <b>{String(s.name ?? sid)}</b>{sid ? <span className="mono small"> {sid}</span> : null}{p.op || p.action ? `：${String(p.op ?? p.action)}` : ""}</>;
        break;
      }
    }
  } catch {
    text = null;
  }
  return (
    <div>
      {text && <div className="serif">{text}</div>}
      {(p.reason as string) && <div className="muted small">事由：{String(p.reason)}</div>}
      <details className="approval-raw">
        <summary className="small muted">原文</summary>
        <JsonView value={a.payload} maxHeight={160} />
      </details>
    </div>
  );
}

function ApprovalsCard() {
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const q = useQuery(() => hub.approvals(status === "all" ? undefined : status), [status], { watch: ["approval.", "notification.", "config.", "personnel.", "budget.", "schedule.", "mcp."] });
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const decide = async (a: Approval, option: "approve" | "reject") => {
    if (option === "reject" && !(await confirm({ title: "驳回呈请", body: `驳回「${APPROVAL_TYPE[a.type] ?? a.type}」之请？`, okText: "驳", danger: true }))) return;
    const res = await run(() => hub.resolveNotification(a.notification_id, { option }), option === "approve" ? "准" : "已驳");
    if (res) q.reload();
  };
  return (
    <Card
      title="审批"
      sub="配置、人事、定时、预算、阅私产等须御批之事"
      flush
      actions={
        <Seg<"pending" | "all">
          options={[
            { key: "pending", label: "待批" },
            { key: "all", label: "全部" },
          ]}
          value={status}
          onChange={setStatus}
        />
      }
    >
      <QueryView q={q} empty={<Empty text={status === "pending" ? "无待批之事" : "尚无审批记录"} seal="批" />}>
        {(list) => (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>类</th>
                  <th style={{ width: "42%" }}>所请</th>
                  <th>呈请</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...list]
                  .sort((a, b) => b.created_at - a.created_at)
                  .map((a) => {
                    const st = APPROVAL_STATUS[a.status];
                    return (
                      <tr key={a.id}>
                        <td>
                          <Tag tone="azure">{APPROVAL_TYPE[a.type] ?? a.type}</Tag>
                        </td>
                        <td>
                          <ApprovalSummary a={a} />
                        </td>
                        <td>
                          <Addr a={a.requested_by} />
                        </td>
                        <td>
                          <Tag tone={st.tone}>{st.label}</Tag>
                          {a.decided_at && (
                            <div className="muted small">
                              <TimeAgo ms={a.decided_at} />
                            </div>
                          )}
                        </td>
                        <td className="small">
                          <TimeAgo ms={a.created_at} />
                        </td>
                        <td>
                          {a.status === "pending" && (
                            <div className="btn-row" style={{ flexWrap: "nowrap" }}>
                              <button className="btn sm primary" disabled={pending} onClick={() => decide(a, "approve")}>
                                准
                              </button>
                              <button className="btn sm danger" disabled={pending} onClick={() => decide(a, "reject")}>
                                驳
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
    </Card>
  );
}
