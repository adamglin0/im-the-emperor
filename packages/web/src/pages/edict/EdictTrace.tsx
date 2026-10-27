// 诏令调查（核心）：宏观执行图 + 泳道时序 + 节点详情抽屉。实时随驿报刷新。
import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { EdictDetail, EmperorEdictActionReq } from "@court/shared/api";
import type { CourtEvent, Span } from "@court/shared/types";
import { ApiError, hub } from "../../api/client.ts";
import { useRegistry } from "../../api/registry.tsx";
import { TimeAgo } from "../../components/Addr.tsx";
import { Card } from "../../components/Card.tsx";
import { useConfirm } from "../../components/Overlay.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Seal } from "../../components/Seal.tsx";
import { StageBar } from "../../components/StageBar.tsx";
import { Empty, ErrorBox, Loading } from "../../components/States.tsx";
import { EdictStateTag, Tag } from "../../components/Tag.tsx";
import { useAction } from "../../hooks/useAction.ts";
import { useNow } from "../../hooks/useNow.ts";
import { useQuery } from "../../hooks/useQuery.ts";
import { DEPT_NAMES, DEPT_ORDER, EDICT_TERMINAL } from "../../lib/labels.ts";
import { fmtCost, fmtDateTime, fmtDuration, fmtPct, fmtTokens } from "../../lib/format.ts";
import { Dag } from "./Dag.tsx";
import { DetailDrawer, EventList } from "./DetailDrawer.tsx";
import { buildMacroGraph, deptOfAddr, isErrorEvent, type MacroNode } from "./model.ts";
import { Swimlane } from "./Swimlane.tsx";
import "../../styles/pages/edict.css";

export default function EdictTracePage() {
  const { id = "" } = useParams();
  const now = useNow(5_000);
  const r = useRegistry();
  const watch = useCallback((e: CourtEvent) => e.trace_id === id || e.subject_id === id, [id]);
  // 诏令 id 以 ed_ 开头；其余（tr_…，定时/服务/来信的追踪）只查追踪，不去撞 404
  const isEdict = id.startsWith("ed_");
  const detailQ = useQuery(() => hub.edict(id), [id], { watch, interval: 30_000, enabled: isEdict });
  const traceQ = useQuery(() => hub.trace(id), [id], { watch, interval: 30_000 });
  const ledgerQ = useQuery(() => hub.ledgerTrace(id), [id], { watch: (e) => e.trace_id === id && (e.type.startsWith("llm.") || e.type.startsWith("turn.")), interval: 60_000 });

  const [selected, setSelected] = useState<string | undefined>();
  const [focusSpan, setFocusSpan] = useState<string | undefined>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [fDept, setFDept] = useState("");
  const [fPost, setFPost] = useState("");
  const [fType, setFType] = useState("");
  const [fErr, setFErr] = useState(false);
  const [showLinks, setShowLinks] = useState(true);

  const detail = detailQ.data;
  const trace = traceQ.data;
  const g = useMemo(() => buildMacroGraph(id, detail, trace, ledgerQ.data, now), [id, detail, trace, ledgerQ.data, now]);
  const events = trace?.events ?? [];

  // 过滤项来源
  const actors = useMemo(() => {
    const set = new Set<string>();
    for (const s of g.spanById.values()) if (s.actor?.startsWith("post:")) set.add(s.actor.slice(5));
    for (const e of events) if (e.actor?.startsWith("post:")) set.add(e.actor.slice(5));
    return [...set].sort();
  }, [g, events]);
  const depts = useMemo(() => [...new Set(actors.map((a) => a.split(".")[0]))].sort((a, b) => DEPT_ORDER.indexOf(a as never) - DEPT_ORDER.indexOf(b as never)), [actors]);
  const types = useMemo(() => [...new Set(events.map((e) => e.type.split(".")[0]))].sort(), [events]);

  const matchActor = useCallback(
    (actor?: string, dept?: string) => {
      if (fPost && actor !== `post:${fPost}`) return false;
      if (fDept && (dept ?? deptOfAddr(actor)) !== fDept) return false;
      return true;
    },
    [fDept, fPost],
  );
  const filterSpan = useCallback((s: Span) => matchActor(s.actor) && (!fErr || s.status === "error" || s.status === "rejected" || s.kind === "turn"), [matchActor, fErr]);
  const filterEvent = useCallback((e: CourtEvent) => matchActor(e.actor, e.dept) && (!fType || e.type.startsWith(fType + ".")) && (!fErr || isErrorEvent(e)), [matchActor, fType, fErr]);
  const matches = useCallback(
    (n: MacroNode) => {
      const anyFilter = fDept || fPost || fErr;
      if (!anyFilter) return true;
      const errOk = !fErr || n.status === "error" || n.status === "rejected" || n.status === "blocked" || n.allSpans.some((sid) => g.spanById.get(sid)?.status === "error");
      if (!errOk) return false;
      if (!fDept && !fPost) return true;
      if (matchActor(n.actor, n.dept)) return true;
      return n.allSpans.some((sid) => matchActor(g.spanById.get(sid)?.actor));
    },
    [fDept, fPost, fErr, matchActor, g],
  );
  const filteredEvents = useMemo(() => events.filter(filterEvent).filter((e) => cursor === null || e.ts <= cursor), [events, filterEvent, cursor]);

  const selectSpan = (sid: string) => {
    const nid = g.spanNode.get(sid);
    if (nid) {
      setSelected(nid);
      setFocusSpan(sid);
    }
  };

  const notFound = !isEdict || ((detailQ.error instanceof ApiError || detailQ.error instanceof Error) && (detailQ.error as { status?: number }).status === 404);
  if ((isEdict && detailQ.initial) || (traceQ.initial && !detail)) return <div className="page"><Loading text="调阅卷宗" /></div>;
  if (!detail && !trace) {
    return (
      <div className="page">
        <Link to="/edicts" className="muted small">← 诏令</Link>
        {detailQ.error || traceQ.error ? <ErrorBox error={detailQ.error ?? traceQ.error} onRetry={() => (detailQ.reload(), traceQ.reload())} /> : <Empty text={`无此诏令或追踪：${id}`} seal="无" />}
      </div>
    );
  }

  const selNode = selected ? g.nodeById.get(selected) : undefined;

  return (
    <div className="page edict-page">
      <div className="row small" style={{ marginBottom: 8 }}>
        <Link to="/edicts" className="muted">← 诏令</Link>
        <span className="muted">/</span>
        <span className="mono muted">{id}</span>
        {(detailQ.loading || traceQ.loading) && <span className="muted">· 刷新中…</span>}
      </div>
      {notFound &&
        (isEdict ? (
          <div className="err-box" style={{ marginBottom: 12 }}><Seal text="缺" tone="gold" size={22} />此诏令已不存，仅显示执行轨迹。</div>
        ) : (
          <div className="muted small" style={{ marginBottom: 12 }}>此为非诏令追踪（定时、服务、来信等），仅显示执行轨迹。</div>
        ))}
      {detail ? <EdictHeader detail={detail} g={g} now={now} /> : <TraceHeader title={g.nodeById.get(g.rootId)?.title ?? id} g={g} />}

      <div className="toolbar edict-filters">
        <span className="serif small muted">筛</span>
        <select value={fDept} onChange={(e) => (setFDept(e.target.value), setFPost(""))} aria-label="部门">
          <option value="">全部部门</option>
          {depts.map((d) => (
            <option key={d} value={d}>{r.deptName(d) ?? DEPT_NAMES[d]}</option>
          ))}
        </select>
        <select value={fPost} onChange={(e) => setFPost(e.target.value)} aria-label="官员">
          <option value="">全部官员</option>
          {actors.filter((a) => !fDept || a.startsWith(fDept + ".")).map((a) => (
            <option key={a} value={a}>{r.postLabel(a)}</option>
          ))}
        </select>
        <select value={fType} onChange={(e) => setFType(e.target.value)} aria-label="事件类型">
          <option value="">全部事件</option>
          {types.map((t) => (
            <option key={t} value={t}>{t}.*</option>
          ))}
        </select>
        <label className="row small"><input type="checkbox" checked={fErr} onChange={(e) => setFErr(e.target.checked)} /> 只看出错</label>
        <label className="row small"><input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} /> 消息连线</label>
        {(fDept || fPost || fType || fErr) && (
          <button className="btn sm ghost" onClick={() => (setFDept(""), setFPost(""), setFType(""), setFErr(false))}>清除</button>
        )}
      </div>

      <Card
        title="执行图"
        sub={`${g.nodes.length} 节点 · 关键路径 ${g.critical.nodes.size} 步`}
        actions={
          <span className="legend small dag-legend">
            <span><i style={{ background: "var(--jade)" }} />成</span>
            <span><i style={{ background: "var(--azure)" }} />办</span>
            <span><i style={{ background: "var(--vermilion)" }} />驳/阻/误</span>
            <span><i style={{ background: "var(--gold)" }} />待</span>
            <span><i style={{ background: "var(--gold-bright)", height: 3, width: 14 }} />关键路径</span>
          </span>
        }
        flush
      >
        {g.nodes.length <= 1 && !detail ? (
          <Empty text="追踪里只有根节点，尚无下游执行" seal="寂" />
        ) : (
          <Dag g={g} selected={selected} onSelect={(nid) => (setSelected(nid), setFocusSpan(undefined))} matches={matches} cursor={cursor} showLinks={showLinks} now={now} />
        )}
      </Card>

      <Card title="泳道时序" sub="按部门分道 · 箭头为消息与服务调用" style={{ marginTop: 16 }}>
        <Swimlane g={g} events={events} cursor={cursor} setCursor={setCursor} onSelectSpan={selectSpan} filterSpan={filterSpan} filterEvent={filterEvent} now={now} />
      </Card>

      <Card title="事件" sub={`${filteredEvents.length} / ${events.length}${cursor !== null ? " · 截至游标" : ""}`} style={{ marginTop: 16 }}>
        <div className="ev-scroll">
          <EventList events={filteredEvents} onPick={(e) => e.span_id && selectSpan(e.span_id)} />
        </div>
      </Card>

      {selNode && (
        <DetailDrawer
          key={selNode.id + (focusSpan ?? "")}
          g={g}
          node={selNode}
          detail={detail}
          events={events}
          focusSpan={focusSpan}
          onClose={() => (setSelected(undefined), setFocusSpan(undefined))}
          now={now}
        />
      )}
    </div>
  );
}

function TraceHeader({ title, g }: { title: string; g: ReturnType<typeof buildMacroGraph> }) {
  return (
    <section className="card memorial edict-head">
      <div className="eh-main">
        <h1 className="eh-title">{title}</h1>
        <div className="muted small">仅追踪 · {fmtTokens(g.totalTokens)} tokens · {fmtCost(g.totalCost)}</div>
      </div>
    </section>
  );
}

function EdictHeader({ detail, g, now }: { detail: EdictDetail; g: ReturnType<typeof buildMacroGraph>; now: number }) {
  const e = detail.edict;
  const confirm = useConfirm();
  const act = useAction();
  const terminal = EDICT_TERMINAL.includes(e.state);
  const tasksDone = detail.tasks.filter((t) => t.state === "done").length;
  const budgetRatio = e.budget_tokens ? g.totalTokens / e.budget_tokens : undefined;
  const elapsed = (terminal ? e.state_entered_at : now) - e.created_at;

  const toast = useToast();
  const [note, setNote] = useState("");
  const doAction = async (action: EmperorEdictActionReq["action"], title: string, body: string, danger = false) => {
    // hub：revise 须在 comment 中写明朕意，否则 400
    if (action === "revise" && !note.trim()) {
      toast("请先在朱批中写明修改之意", "bad");
      return;
    }
    const ok = await confirm({ title, body, okText: "钦此", danger });
    if (!ok) return;
    const res = await act.run(() => hub.emperorEdictAction(e.id, { action, comment: note.trim() || undefined }), `${title}，已下`);
    if (res) setNote("");
  };

  return (
    <section className={`card memorial edict-head ${e.state === "escalated" || e.state === "blocked_budget" ? "urgent" : ""}`}>
      <div className="eh-grid">
        <div className="eh-main">
          <div className="row wrap" style={{ gap: 10 }}>
            <EdictStateTag state={e.state} />
            {e.skip_review && <Tag tone="ink">墨敕</Tag>}
            {e.reject_count > 0 && <Tag tone="red">封驳 ×{e.reject_count}</Tag>}
            {e.remonstrated_draft_nos.length > 0 && <Tag tone="plum">谏 ×{e.remonstrated_draft_nos.length}</Tag>}
            <span className="muted small">颁于 {fmtDateTime(e.created_at)} · 历时 {fmtDuration(elapsed)}</span>
          </div>
          <h1 className="eh-title">{e.title}</h1>
          <blockquote className="eh-intent">「{e.intent}」</blockquote>
          <div style={{ maxWidth: 640 }}>
            <StageBar edict={e} />
          </div>
        </div>
        <div className="eh-side">
          <div className="eh-metric">
            <div className="eh-k">用度</div>
            <div className="eh-v num">
              {fmtTokens(g.totalTokens)}
              {e.budget_tokens ? <span className="muted small"> / {fmtTokens(e.budget_tokens)}</span> : null}
            </div>
            {budgetRatio !== undefined && (
              <div className="meter" title={`已用 ${fmtPct(budgetRatio)}`}>
                <div className={`meter-fill ${budgetRatio > 0.9 ? "hot" : budgetRatio > 0.7 ? "warm" : ""}`} style={{ width: `${Math.min(100, budgetRatio * 100)}%` }} />
              </div>
            )}
            <div className="muted small num">{fmtCost(g.totalCost)}</div>
          </div>
          <div className="eh-metric">
            <div className="eh-k">任务</div>
            <div className="eh-v num">
              {tasksDone}<span className="muted small"> / {detail.tasks.length}</span>
            </div>
            <div className="muted small">{detail.tasks.filter((t) => t.state === "blocked").length > 0 ? <span style={{ color: "var(--vermilion)" }}>{detail.tasks.filter((t) => t.state === "blocked").length} 项受阻</span> : "办结 / 总数"}</div>
          </div>
          <div className="eh-metric">
            <div className="eh-k">期限</div>
            <div className="eh-v">{e.deadline ? <TimeAgo ms={e.deadline} /> : <span className="muted">—</span>}</div>
            <div className="muted small">{e.deadline ? fmtDateTime(e.deadline) : "未定"}</div>
          </div>
        </div>
      </div>
      {!terminal && (
        <div className="eh-actions btn-row">
          <input
            placeholder={e.state === "remonstrated" || e.state === "escalated" ? "朱批（修改旨意时必填）" : "朱批（可选）"}
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            style={{ flex: "1 1 220px", maxWidth: 360 }}
            aria-label="朱批"
          />
          {(e.state === "escalated" || e.state === "remonstrated") && (
            <button className="btn primary" disabled={act.pending} onClick={() =>
                e.state === "escalated"
                  ? doAction("force_approve", "照准原案", "绕过门下封驳，照准现行草稿，交尚书省分派。此举留痕并抄送御史台。")
                  : doAction("insist", "坚持原旨", "不从谏言，坚持现行草稿。")
              }>
              {e.state === "escalated" ? "照准原案" : "坚持原旨"}
            </button>
          )}
          {e.state === "remonstrated" && (
            <button className="btn gold" disabled={act.pending} onClick={() => doAction("revise", "从谏修改", "发回中书，依谏言重拟。")}>
              从谏修改
            </button>
          )}
          {e.state === "escalated" && (
            <button className="btn gold" disabled={act.pending} onClick={() => doAction("revise", "发回重拟", "发回中书重新起草。")}>
              发回重拟
            </button>
          )}
          {e.state === "reported" && (
            <button className="btn primary" disabled={act.pending} onClick={() => doAction("accept_report", "御览准奏", "复奏已览，诏令办结。")}>
              御览准奏
            </button>
          )}
          {e.state === "blocked_budget" && (
            <button className="btn gold" disabled={act.pending} onClick={() => doAction("retry", "重试", "预算已调整，令其续办。")}>
              续办
            </button>
          )}
          <span className="grow" />
          <button className="btn danger" disabled={act.pending} onClick={() => doAction("withdraw", "撤回诏令", "撤回后所有未结任务级联取消，不可恢复。", true)}>
            撤回
          </button>
        </div>
      )}
      {e.state === "failed" && (
        <div className="eh-actions btn-row">
          <button className="btn gold" disabled={act.pending} onClick={() => doAction("retry", "重试", "令有司重新办理。")}>
            重试
          </button>
        </div>
      )}
    </section>
  );
}
