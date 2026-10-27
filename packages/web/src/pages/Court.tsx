// 朝堂：部门 × 官员牌（实时状态）、部门健康、近时消息流热力
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { CourtEvent, OfficialState } from "@court/shared/types";
import "../styles/pages/court.css";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { HeatGrid } from "../components/charts.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading } from "../components/States.tsx";
import { Seg } from "../components/Tabs.tsx";
import { useQuery } from "../hooks/useQuery.ts";
import { useStatuses } from "../hooks/useStatuses.ts";
import { useNow } from "../hooks/useNow.ts";
import { fmtAgo, fmtTokens } from "../lib/format.ts";
import { DEPT_GROUP, DEPT_NAMES, DEPT_ORDER, DEPT_SEAL, OFFICIAL_STATE } from "../lib/labels.ts";
import { OfficialCard, STATE_ORDER, STATE_VAR, statusForPost } from "./court/shared.tsx";

const GROUPS = ["中枢", "三省", "六部", "台"];

export default function CourtPage() {
  const r = useRegistry();
  const statusesQ = useStatuses(15_000);
  const ov = useQuery(() => hub.overview(), [], { watch: ["dept.", "court.halt"], interval: 30_000 });
  const [hidden, setHidden] = useState<Set<OfficialState>>(new Set());
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    return r.posts.map((p) => ({ post: p, status: statusForPost(p, statusesQ.data, !!r.officialOf(p.post_id)) }));
  }, [r, statusesQ.data]);

  const counts = useMemo(() => {
    const c: Partial<Record<OfficialState, number>> = {};
    for (const x of rows) c[x.status.state] = (c[x.status.state] ?? 0) + 1;
    return c;
  }, [rows]);

  const kw = q.trim().toLowerCase();
  const visible = rows.filter((x) => !hidden.has(x.status.state) && (!kw || `${x.post.title}${r.officialOf(x.post.post_id)?.name ?? ""}${x.post.post_id}${x.status.status_text ?? ""}`.toLowerCase().includes(kw)));

  const tokensToday = rows.reduce((s, x) => s + (x.status.tokens_today ?? 0), 0);
  const active = (counts.thinking ?? 0) + (counts.tool ?? 0);

  const toggle = (s: OfficialState) => {
    const n = new Set(hidden);
    if (n.has(s)) n.delete(s);
    else n.add(s);
    setHidden(n);
  };
  const only = (s: OfficialState) => setHidden(new Set(STATE_ORDER.filter((x) => x !== s)));

  if (r.loading && !r.registry) return <div className="page"><Loading /></div>;
  if (!r.registry) return <div className="page"><ErrorBox error={r.error} onRetry={r.reload} /></div>;

  return (
    <div className="page">
      <PageHead
        title="朝堂"
        lede={`文武百官 ${r.posts.length} 职 · 在任 ${r.posts.length - (counts.vacant ?? 0)} 员 · 理事 ${active} 员`}
        actions={
          <input type="search" placeholder="寻官：职衔、姓名、事由…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        }
      />

      <div className="court-summary">
        <Stat label="理事中" value={active} unit="员" tone="red" sub={`思考 ${counts.thinking ?? 0} · 办事 ${counts.tool ?? 0}`} />
        <Stat label="候命" value={(counts.waiting ?? 0) + (counts.idle ?? 0)} unit="员" sub={`等待 ${counts.waiting ?? 0} · 闲 ${counts.idle ?? 0}`} />
        <Stat label="安寝" value={counts.sleeping ?? 0} unit="员" tone="azure" />
        <Stat label="异常" value={(counts.suspended ?? 0) + (counts.sick ?? 0) + (counts.offline ?? 0) + (counts.paused ?? 0)} unit="员" sub={`停俸 ${counts.suspended ?? 0} · 抱病 ${counts.sick ?? 0} · 离线 ${counts.offline ?? 0}`} />
        <Stat label="今日俸禄" value={fmtTokens(tokensToday)} unit="tokens" tone="jade" />
      </div>

      <div className="court-filter" role="group" aria-label="按状态筛选">
        {STATE_ORDER.map((s) => (
          <button
            key={s}
            className={`state-chip ${hidden.has(s) ? "off" : ""}`}
            style={{ ["--st" as string]: STATE_VAR[s] }}
            onClick={() => toggle(s)}
            onDoubleClick={() => only(s)}
            title="单击切换，双击只看此状态"
          >
            <span className="chip-icon">{OFFICIAL_STATE[s].icon}</span>
            {OFFICIAL_STATE[s].label}
            <span className="num">{counts[s] ?? 0}</span>
          </button>
        ))}
        {hidden.size > 0 && (
          <button className="btn ghost sm" onClick={() => setHidden(new Set())}>
            全显
          </button>
        )}
        {statusesQ.error !== undefined && <span className="small" style={{ color: "var(--bad)" }}>心跳取不到，显示名册</span>}
      </div>

      {GROUPS.map((g) => {
        const depts = r.depts.filter((d) => (DEPT_GROUP[d.id] ?? "六部") === g);
        if (depts.length === 0) return null;
        return (
          <section key={g} className="court-group">
            <h2 className="court-group-title">{g}</h2>
            <div className="court-depts">
              {depts.map((d) => {
                const all = rows.filter((x) => x.post.dept === d.id);
                const shown = visible.filter((x) => x.post.dept === d.id);
                const health = ov.data?.depts_health?.[d.id];
                const busy = all.filter((x) => x.status.state === "thinking" || x.status.state === "tool").length;
                const tok = all.reduce((s, x) => s + x.status.tokens_today, 0);
                return (
                  <Card
                    key={d.id}
                    className="dept-block"
                    style={depts.length === 1 ? { gridColumn: "1 / -1" } : undefined}
                    title={
                      <span className="row" style={{ gap: 10 }}>
                        <Seal text={DEPT_SEAL[d.id] ?? d.name[0]} tone="red" size={30} solid />
                        <span>
                          <Link to={`/depts/${d.id}`} className="dept-name">
                            {d.name}
                          </Link>
                          <div className="dept-brief">{d.brief}</div>
                        </span>
                      </span>
                    }
                    actions={
                      <div className="col" style={{ alignItems: "flex-end", gap: 2 }}>
                        <span className={`health ${health ? (health.ok ? "ok" : "bad") : ""}`} title={health ? `最近心跳 ${fmtAgo(health.last_seen)}` : "无健康数据"}>
                          {health ? (health.ok ? "署衙安" : `署衙失联 · ${fmtAgo(health.last_seen)}`) : "—"}
                        </span>
                        <span className="dept-counts">
                          <span>
                            理事 <b>{busy}</b>/{all.length}
                          </span>
                          <span>
                            俸 <b>{fmtTokens(tok)}</b>
                          </span>
                        </span>
                      </div>
                    }
                  >
                    {shown.length === 0 ? (
                      <div className="muted small serif">无合乎筛选者</div>
                    ) : (
                      <div className="officials-grid">
                        {shown.map((x) => (
                          <OfficialCard key={x.post.post_id} post={x.post} status={x.status} />
                        ))}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}

      <MessageFlow />
    </div>
  );
}

// ───────── 部门间消息流量热力 ─────────
function deptOf(addr: unknown): string | undefined {
  if (typeof addr !== "string") return undefined;
  if (addr === "emperor") return "emperor";
  const [kind, id] = addr.split(":");
  if (!id) return addr.includes(".") ? addr.split(".")[0] : undefined;
  if (kind === "post") return id.split(".")[0];
  if (kind === "dept") return id;
  return undefined;
}

function MessageFlow() {
  const [win, setWin] = useState<"1h" | "24h">("1h");
  const now = useNow(60_000);
  const evq = useQuery(() => hub.events({ type: "message.", limit: 1000 }), [], { watch: ["message."], interval: 60_000 });
  const since = now - (win === "1h" ? 3_600_000 : 86_400_000);
  const { matrix, total, keys } = useMemo(() => {
    const m = new Map<string, number>();
    let total = 0;
    const used = new Set<string>();
    for (const e of (evq.data ?? []) as CourtEvent[]) {
      if (e.ts < since) continue;
      const from = deptOf(e.actor) ?? e.dept;
      const to = deptOf(e.data?.to);
      if (!from || !to) continue;
      m.set(`${from}>${to}`, (m.get(`${from}>${to}`) ?? 0) + 1);
      used.add(from);
      used.add(to);
      total++;
    }
    const keys = ["emperor", ...DEPT_ORDER].filter((k) => used.has(k) || k !== "emperor");
    return { matrix: m, total, keys };
  }, [evq.data, since]);
  const label = (k: string) => (k === "emperor" ? "御前" : (DEPT_NAMES[k] ?? k));
  const rows = keys.map((k) => ({ key: k, label: label(k) }));
  const cols = keys.map((k) => ({ key: k, label: label(k).slice(0, 2) }));

  return (
    <Card
      title="署衙往来"
      sub={`${win === "1h" ? "近一时辰" : "近一日"} · 共 ${total} 件 · 行＝发件，列＝收件`}
      actions={
        <Seg
          options={[
            { key: "1h", label: "一时辰" },
            { key: "24h", label: "一日" },
          ]}
          value={win}
          onChange={setWin}
        />
      }
    >
      {evq.initial ? (
        <Loading />
      ) : evq.error && !evq.data ? (
        <ErrorBox error={evq.error} onRetry={evq.reload} />
      ) : total === 0 ? (
        <Empty text={win === "1h" ? "此一时辰内署衙间无文书往来" : "近一日无文书往来"} seal="静">
          {win === "1h" && (
            <button className="btn sm" onClick={() => setWin("24h")}>
              看近一日
            </button>
          )}
        </Empty>
      ) : (
        <>
          <HeatGrid rows={rows} cols={cols} value={(a, b) => matrix.get(`${a}>${b}`) ?? 0} cell={30} rowLabelWidth={64} format={(n) => String(n)} />
          <div className="flow-legend" style={{ marginTop: 8 }}>
            少
            {[1, 2, 3, 4, 5].map((k) => (
              <i key={k} style={{ background: `var(--seq-${k})` }} />
            ))}
            多
          </div>
        </>
      )}
    </Card>
  );
}

