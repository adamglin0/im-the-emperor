// 御史台：稽查发现（规则命中）、弹劾（待圣裁）、监察奏报
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { AuditFinding, Impeachment, Notification } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { Addr, TimeAgo, TraceLink } from "../components/Addr.tsx";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { BarList } from "../components/charts.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Seg, Tabs } from "../components/Tabs.tsx";
import { Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { AUDIT_RULE, NOTIF_CATEGORY, type Tone } from "../lib/labels.ts";
import { optionsOf } from "./home/NotifCard.tsx";
import "../styles/pages/offices.css";

const SEVERITY: Record<AuditFinding["severity"], string> = { high: "重", medium: "中", low: "轻" };
const FINDING_STATUS: Record<AuditFinding["status"], { label: string; tone: Tone }> = {
  open: { label: "未结", tone: "red" },
  reviewed: { label: "已核", tone: "azure" },
  impeached: { label: "已劾", tone: "plum" },
  dismissed: { label: "驳回", tone: "ink" },
};
const IMPEACH_STATUS: Record<Impeachment["status"], { label: string; tone: Tone }> = {
  pending: { label: "待圣裁", tone: "red" },
  dismissed: { label: "驳回", tone: "ink" },
  to_libu: { label: "交吏部", tone: "azure" },
  to_hubu: { label: "交户部", tone: "gold" },
  to_xingbu: { label: "交刑部", tone: "plum" },
};

type TabKey = "findings" | "impeach" | "reports";

export default function CensorPage() {
  const [tab, setTab] = useState<TabKey>("findings");
  const findings = useQuery(() => hub.auditFindings({ limit: 500 }), [], { watch: ["audit."] });
  const imps = useQuery(() => hub.impeachments(), [], { watch: ["audit.", "notification."] });
  const notes = useQuery(() => hub.notifications({ limit: 200 }), [], { watch: ["notification.", "audit."] });
  const reports = (notes.data ?? []).filter((n) => n.category === "audit_report");
  const f = findings.data ?? [];
  const open = f.filter((x) => x.status === "open");
  const pendingImp = (imps.data ?? []).filter((x) => x.status === "pending");
  const byRule = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of f) m.set(x.rule, (m.get(x.rule) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: AUDIT_RULE[k] ?? k, value: v }));
  }, [f]);

  return (
    <div className="page">
      <PageHead title="御史台" lede="台院弹劾、殿院查议、察院巡察。规则先筛，御史复核；证据链直达执行图。" />
      <div className="grid censor-top">
        <div className="grid g2" style={{ gap: 12 }}>
          <Stat label="未结发现" value={open.length} unit="起" tone={open.length ? "red" : undefined} sub={`共 ${f.length} 起`} />
          <Stat label="重案" value={open.filter((x) => x.severity === "high").length} unit="起" tone="red" sub="严重度「重」且未结" />
          <Stat label="弹劾待裁" value={pendingImp.length} unit="件" tone={pendingImp.length ? "red" : undefined} sub={`历来 ${imps.data?.length ?? 0} 件`} />
          <Stat label="监察奏报" value={reports.length} unit="道" tone="azure" sub={reports[0] ? `最近 ${new Date(reports[0].created_at).toLocaleDateString("zh-CN")}` : "尚无"} />
        </div>
        <Card title="规则命中" level={3}>
          {byRule.length ? <BarList data={byRule} format={(n) => `${n} 起`} color="var(--series-1)" /> : <Empty text="无命中" seal="清" />}
        </Card>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "findings", label: "稽查发现", count: open.length },
          { key: "impeach", label: "弹劾", count: pendingImp.length },
          { key: "reports", label: "奏报", count: reports.filter((r) => r.status === "pending").length },
        ]}
      />
      {tab === "findings" && <FindingsTab q={findings} />}
      {tab === "impeach" && (
        <QueryView q={imps} empty={<Empty text="朝野清明，并无弹劾" seal="清" />}>
          {(rows) => (
            <div className="col" style={{ gap: 14 }}>
              {[...rows]
                .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.created_at - a.created_at)
                .map((x) => (
                  <ImpeachCard key={x.id} x={x} onResolved={() => (imps.reload(), notes.reload())} />
                ))}
            </div>
          )}
        </QueryView>
      )}
      {tab === "reports" &&
        (notes.initial ? (
          <Loading />
        ) : notes.error && !notes.data ? (
          <ErrorBox error={notes.error} onRetry={notes.reload} />
        ) : reports.length === 0 ? (
          <Empty text="御史台尚未奏报" seal="宪" />
        ) : (
          <div className="col" style={{ gap: 14 }}>
            {reports.map((n) => (
              <ReportCard key={n.id} n={n} onResolved={notes.reload} />
            ))}
          </div>
        ))}
    </div>
  );
}

function FindingsTab({ q }: { q: ReturnType<typeof useQuery<AuditFinding[]>> }) {
  const [status, setStatus] = useState<"all" | AuditFinding["status"]>("open");
  const [rule, setRule] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const { run, pending } = useAction();
  const update = async (f: AuditFinding, st: AuditFinding["status"]) => {
    const res = await run(() => hub.updateFinding(f.id, { actor: "emperor", status: st, note: "陛下亲核" }), st === "dismissed" ? "已驳回" : "已核");
    if (res) q.setData((d) => d?.map((x) => (x.id === res.id ? res : x)));
  };
  return (
    <Card flush>
      <div className="toolbar" style={{ padding: "10px 14px 0" }}>
        <Seg
          value={status}
          onChange={setStatus}
          options={[
            { key: "open", label: "未结" },
            { key: "reviewed", label: "已核" },
            { key: "impeached", label: "已劾" },
            { key: "dismissed", label: "驳回" },
            { key: "all", label: "全部" },
          ]}
        />
        <select value={rule} onChange={(e) => setRule(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">全部规则</option>
          {Object.entries(AUDIT_RULE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <QueryView q={q} empty={<Empty text="稽查规则无一命中" seal="清" />}>
        {(rows) => {
          const list = rows.filter((x) => (status === "all" || x.status === status) && (!rule || x.rule === rule)).sort((a, b) => b.created_at - a.created_at);
          if (!list.length) return <Empty text="无符合条件之发现" />;
          return (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>规则</th>
                    <th>严重</th>
                    <th>对象</th>
                    <th style={{ width: "34%" }}>摘要</th>
                    <th>执行图</th>
                    <th>状态</th>
                    <th>时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((x) => (
                    <FindingRow key={x.id} x={x} open={open === x.id} onToggle={() => setOpen(open === x.id ? null : x.id)} onUpdate={update} pending={pending} />
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}

function FindingRow({
  x,
  open,
  onToggle,
  onUpdate,
  pending,
}: {
  x: AuditFinding;
  open: boolean;
  onToggle: () => void;
  onUpdate: (f: AuditFinding, s: AuditFinding["status"]) => void;
  pending: boolean;
}) {
  const st = FINDING_STATUS[x.status];
  return (
    <>
      <tr className="clickable finding-row" onClick={onToggle}>
        <td>
          <Tag tone="plum">{AUDIT_RULE[x.rule] ?? x.rule}</Tag>
        </td>
        <td>
          <span className={`sev ${x.severity}`}>
            <i />
            {SEVERITY[x.severity]}
          </span>
        </td>
        <td>
          <Addr a={x.subject} />
        </td>
        <td className="small serif">{x.summary}</td>
        <td className="small">{x.trace_id ? <TraceLink id={x.trace_id}>查看</TraceLink> : <span className="muted">—</span>}</td>
        <td>
          <Tag tone={st.tone}>{st.label}</Tag>
        </td>
        <td className="small">
          <TimeAgo ms={x.created_at} />
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {x.status === "open" && (
            <div className="btn-row" style={{ flexWrap: "nowrap" }}>
              <button className="btn sm jade" disabled={pending} onClick={() => onUpdate(x, "reviewed")}>
                核
              </button>
              <button className="btn sm danger" disabled={pending} onClick={() => onUpdate(x, "dismissed")}>
                驳
              </button>
            </div>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ background: "var(--panel-2)" }}>
            <div className="small muted" style={{ marginBottom: 4 }}>
              证据 · <span className="mono">{x.id}</span>
            </div>
            <JsonView value={x.evidence} maxHeight={260} />
          </td>
        </tr>
      )}
    </>
  );
}

/** 以待办的选项批复（弹劾 / 奏报） */
function ResolveBox({ notificationId, onResolved }: { notificationId: string; onResolved: () => void }) {
  const n = useQuery(() => hub.notification(notificationId), [notificationId], { interval: 0 });
  const [comment, setComment] = useState("");
  const { run, pending } = useAction();
  if (n.initial) return <Loading text="取待办" />;
  if (!n.data) return <ErrorBox error={n.error} onRetry={n.reload} />;
  if (n.data.status !== "pending")
    return (
      <div className="small muted">
        已批：{n.data.options.find((o) => o.id === n.data!.resolution?.option)?.label ?? (n.data.status === "dismissed" ? "已阅" : n.data.resolution?.option)}
        {n.data.resolution?.comment ? ` · ${n.data.resolution.comment}` : ""}
      </div>
    );
  const resolve = async (option: string) => {
    const res = await run(() => hub.resolveNotification(notificationId, { option, comment: comment.trim() || undefined }), "已批复");
    if (res) {
      n.reload();
      onResolved();
    }
  };
  return (
    <div className="resolve-box">
      <textarea rows={2} placeholder="朱批（可空）" value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginBottom: 8, minHeight: 48 }} />
      <div className="btn-row">
        {optionsOf(n.data).map((o, i) => (
          <button key={o.id} className={`btn ${i === 0 ? "gold" : ""}`} disabled={pending} onClick={() => void resolve(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ImpeachCard({ x, onResolved }: { x: Impeachment; onResolved: () => void }) {
  const st = IMPEACH_STATUS[x.status];
  return (
    <section className={`card memorial ${x.status === "pending" ? "urgent" : ""} impeach-card`}>
      <div className="impeach-head">
        <Seal text="劾" tone={x.status === "pending" ? "red" : "ink"} size={40} stamp={x.status === "pending"} />
        <span className="who">
          <Addr a={x.by} />
        </span>
        <span className="arrow">劾</span>
        <span className="who">
          <Addr a={x.target} />
        </span>
        <Tag tone={st.tone}>{st.label}</Tag>
        <span className="muted small" style={{ marginLeft: "auto" }}>
          <TimeAgo ms={x.created_at} />
        </span>
      </div>
      <div className="charges">罪状：{x.charges}</div>
      <div className="prose small" style={{ whiteSpace: "pre-wrap" }}>
        {x.evidence}
      </div>
      {x.finding_ids.length > 0 && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <span className="muted small">所据稽查：</span>
          {x.finding_ids.map((id) => (
            <Tag key={id}>
              <span className="mono">{id}</span>
            </Tag>
          ))}
          {x.target.startsWith("post:") && (
            <Link className="btn sm ghost" to={`/officials/${x.target.slice(5)}`}>
              查其行状 →
            </Link>
          )}
        </div>
      )}
      {x.status === "pending" && x.notification_id && <ResolveBox notificationId={x.notification_id} onResolved={onResolved} />}
    </section>
  );
}

function ReportCard({ n, onResolved }: { n: Notification; onResolved: () => void }) {
  const cat = NOTIF_CATEGORY[n.category];
  return (
    <section className="card memorial impeach-card">
      <div className="impeach-head">
        <Seal text={cat.seal} tone="plum" size={36} />
        <span className="who serif">{n.title}</span>
        <span className="muted small">
          <Addr a={n.from} /> · <TimeAgo ms={n.created_at} />
        </span>
        <Tag tone={n.status === "pending" ? "gold" : "ink"}>{n.status === "pending" ? "未览" : "已览"}</Tag>
      </div>
      <div className="memorial-body">
        <Markdown text={n.body} />
      </div>
      {n.status === "pending" && <ResolveBox notificationId={n.id} onResolved={onResolved} />}
    </section>
  );
}
