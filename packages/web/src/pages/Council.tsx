// 政事堂议事厅：议事列表 · 实录（朕居右，宰相居左）· 发言轮次 · 宰相立场 · 结论与圣裁
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { CouncilEntry, Deliberation, Notification } from "@court/shared/types";
import type { DeliberationDetail } from "@court/shared/api";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo } from "../components/Addr.tsx";
import { AttachButton, AttachmentList, attachmentRefs, useAttachments } from "../components/Attachments.tsx";
import { Card, PageHead } from "../components/Card.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading } from "../components/States.tsx";
import { Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery, type QueryResult } from "../hooks/useQuery.ts";
import { fmtPct, fmtTokens, fmtDateTime } from "../lib/format.ts";
import { STANCE } from "../lib/labels.ts";
import { optionSeal } from "./home/NotifCard.tsx";
import "../styles/pages/home.css";

const NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const cn = (n: number) => (n <= 10 ? NUM[n] : String(n));
const DELIB_STATE: Record<Deliberation["state"], { label: string; tone: "red" | "gold" | "ink" | "jade" }> = {
  open: { label: "议中", tone: "red" },
  concluded: { label: "议毕待裁", tone: "gold" },
  closed: { label: "已结", tone: "ink" },
};
const WATCH = ["council.", "deliberation.", "notification."];

export default function CouncilPage() {
  const [sp, setSp] = useSearchParams();
  const list = useQuery(() => hub.deliberations(), [], { watch: WATCH });
  const paramId = sp.get("id");
  const newMode = sp.get("new") === "1";
  const id = useMemo(() => {
    if (newMode) return null;
    if (paramId) return paramId;
    const ds = list.data ?? [];
    return (ds.find((d) => d.state === "open") ?? ds[0])?.id ?? null;
  }, [paramId, newMode, list.data]);
  const detail = useQuery(() => hub.deliberation(id!), [id], { watch: WATCH, enabled: !!id, interval: 30_000 });
  const notifs = useQuery(() => hub.notifications({ limit: 200 }), [], { watch: ["notification."] });

  const select = (d: string | null) => setSp(d ? { id: d } : { new: "1" });

  return (
    <div className="page">
      <PageHead
        title="政事堂议事厅"
        lede="宰相联席，执政事笔主持；各相每轮一言，至多两轮，议毕奏请圣裁"
        actions={
          <button className="btn gold" onClick={() => select(null)}>
            <span className="display">议</span> 另开新议
          </button>
        }
      />
      <div className="council">
        <DelibList list={list} activeId={id} onSelect={select} />
        <Hall id={id} detail={detail.data} error={detail.error} loading={detail.initial} onCreated={(nid) => setSp({ id: nid })} reload={detail.reload} />
        <div className="council-side stack">
          {detail.data && !newMode ? (
            <>
              <TurnPanel d={detail.data.deliberation} />
              <MemberStances d={detail.data.deliberation} entries={detail.data.entries} />
              <Conclusion d={detail.data.deliberation} notifs={notifs.data} reload={() => (notifs.reload(), detail.reload())} />
            </>
          ) : (
            <Card title="议事规则">
              <ol className="small serif" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.9 }}>
                <li>陛下发言，开一场次；主持（执政事笔）开议。</li>
                <li>宰相按序各言一次，示立场：赞成 / 反对 / 保留 / 弃权。</li>
                <li>主持可开第二轮，至多两轮。</li>
                <li>主持总结结论、异议与拟旨，奏请陛下：照准颁旨 / 再议 / 搁置。</li>
              </ol>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────── 议事列表 ─────────
function DelibList({ list, activeId, onSelect }: { list: QueryResult<Deliberation[]>; activeId: string | null; onSelect: (id: string | null) => void }) {
  const sorted = useMemo(() => [...(list.data ?? [])].sort((a, b) => b.updated_at - a.updated_at), [list.data]);
  return (
    <Card title="议事" sub={list.data ? `${list.data.length} 场` : undefined} flush className="delib-card">
      {list.initial ? (
        <Loading />
      ) : list.data === undefined && list.error ? (
        <div style={{ padding: 12 }}>
          <ErrorBox error={list.error} onRetry={list.reload} />
        </div>
      ) : sorted.length === 0 ? (
        <Empty seal="议" text="政事堂尚无议事。于右侧上谕开议。" />
      ) : (
        <div className="delib-list">
          {sorted.map((d) => (
            <div key={d.id} className={`delib-item ${d.id === activeId ? "active" : ""}`} onClick={() => onSelect(d.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(d.id)}>
              <div className="di-topic clamp-2">{d.topic || "（未定议题）"}</div>
              <div className="di-meta">
                <Tag tone={DELIB_STATE[d.state].tone}>{DELIB_STATE[d.state].label}</Tag>
                <span>
                  第{cn(d.session_no)}场 · {cn(d.round)}/{cn(d.max_rounds)}轮
                </span>
                <span style={{ marginLeft: "auto" }}>
                  <TimeAgo ms={d.updated_at} />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ───────── 议事厅（实录 + 上谕） ─────────
function Hall({
  id,
  detail,
  error,
  loading,
  onCreated,
  reload,
}: {
  id: string | null;
  detail?: DeliberationDetail;
  error: unknown;
  loading: boolean;
  onCreated: (id: string) => void;
  reload: () => void;
}) {
  const r = useRegistry();
  const scroller = useRef<HTMLDivElement>(null);
  const d = id ? detail?.deliberation : undefined;
  const entries = id ? (detail?.entries ?? []) : [];
  const sorted = useMemo(() => [...entries].sort((a, b) => a.created_at - b.created_at), [entries]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sorted.length, id]);

  let lastKey = "";
  return (
    <section className="card hall">
      <header className="hall-head">
        {d ? (
          <>
            <Seal text="议" tone={DELIB_STATE[d.state].tone} size={30} />
            <div className="grow">
              <h2>{d.topic || "（未定议题）"}</h2>
              <div className="small muted">
                主持 <Addr a={`post:${d.chair_post}`} /> · 开议于 {fmtDateTime(d.created_at)} · 耗 {fmtTokens(d.token_spent)} token
              </div>
            </div>
            <Tag tone={DELIB_STATE[d.state].tone}>{DELIB_STATE[d.state].label}</Tag>
            <Link to={`/edicts/${d.trace_id}`} className="btn ghost sm">
              追踪
            </Link>
          </>
        ) : (
          <>
            <Seal text="新" tone="gold" size={30} />
            <div className="grow">
              <h2>另开新议</h2>
              <div className="small muted">陛下所言即为议题，政事堂诸相将依序议之</div>
            </div>
          </>
        )}
      </header>
      <div className="transcript" ref={scroller}>
        {id && loading ? (
          <Loading />
        ) : id && !detail && error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : sorted.length === 0 ? (
          <Empty seal="堂" text={id ? "尚无发言" : "朕有一事，与诸卿议之……"} />
        ) : (
          sorted.map((e) => {
            const key = `${e.session_no}-${e.round}`;
            const divider = key !== lastKey;
            lastKey = key;
            return (
              <div key={e.id}>
                {divider && (
                  <div className="round-divider">
                    第{cn(e.session_no)}场 · 第{cn(e.round)}轮
                  </div>
                )}
                <Speech e={e} chair={d?.chair_post} />
              </div>
            );
          })
        )}
        {d?.state === "open" && d.current_speaker && (
          <div className="speaking-now">
            <span className="ink-dots">
              <span />
              <span />
              <span />
            </span>
            {r.postLabel(d.current_speaker)} 执笔中
          </div>
        )}
      </div>
      <Composer deliberation={d} onCreated={onCreated} onSent={reload} />
    </section>
  );
}

function Speech({ e, chair }: { e: CouncilEntry; chair?: string }) {
  const r = useRegistry();
  if (e.author === "emperor") {
    return (
      <div className="speech emperor">
        <Seal text="朕" tone="red" solid size={34} rotate={4} className="avatar" />
        <div className="bubble">
          <div className="who">
            <TimeAgo ms={e.created_at} />
            <b>陛下</b>
          </div>
          <div className="text">{e.content}</div>
        </div>
      </div>
    );
  }
  const post = e.author.startsWith("post:") ? e.author.slice(5) : e.author;
  const p = r.post(post);
  const o = r.officialOf(post);
  const st = e.stance ? STANCE[e.stance] : undefined;
  return (
    <div className="speech">
      <Seal text={(o?.name ?? p?.title ?? "臣").slice(0, 1)} tone={post === chair ? "red" : "gold"} size={34} rotate={-3} className="avatar" />
      <div className="bubble">
        <div className="who">
          <b>{p?.title ?? post}</b>
          {o && <span>{o.name}</span>}
          {p?.benguan && <span>· {p.benguan}</span>}
          {post === chair && <Tag tone="red">执政事笔</Tag>}
          {st && <Tag tone={st.tone}>{st.label}</Tag>}
          <span>
            <TimeAgo ms={e.created_at} />
          </span>
        </div>
        <div className="text">{e.content}</div>
      </div>
      {st && <Seal text={st.seal} tone={st.tone} size={30} className="stance" title={st.label} />}
    </div>
  );
}

function Composer({ deliberation, onCreated, onSent }: { deliberation?: Deliberation; onCreated: (id: string) => void; onSent: () => void }) {
  const [text, setText] = useState("");
  const att = useAttachments("council");
  const { run, pending } = useAction();
  const hasReady = att.list.some((a) => a.state === "ready");
  const canSend = !pending && !att.uploading && (!!text.trim() || hasReady);
  const send = async () => {
    if (!canSend) return;
    const refs = attachmentRefs(att.list);
    const content = (text.trim() || "朕附文书数件，诸卿阅之。") + refs;
    const res = await run(() => hub.emperorCouncil({ content, deliberation_id: deliberation?.id }), deliberation ? "圣谕已宣于堂" : "已开新议");
    if (!res) return;
    setText("");
    att.clear();
    if (!deliberation || res.deliberation.id !== deliberation.id) onCreated(res.deliberation.id);
    else onSent();
  };
  const hint = deliberation
    ? deliberation.state === "open"
      ? "陛下续言将开启新一场次，诸相重议"
      : "议已毕；陛下再言则就此续议"
    : "陛下所言即为议题";
  return (
    <div className={`composer ${att.dragging ? "dragging" : ""}`} {...att.dropProps}>
      <textarea
        placeholder={deliberation ? "朕意如何……" : "朕有一事，与诸卿议之……"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={att.onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <AttachmentList list={att.list} onRemove={att.remove} />
      <div className="row">
        <span className="muted small grow">{hint} · 可粘贴或拖入文件 · ⌘/Ctrl + Enter 宣谕</span>
        <AttachButton onFiles={att.add} />
        <button className="btn primary" disabled={!canSend} onClick={send}>
          <span className="display">谕</span> {deliberation ? "宣谕于堂" : "开议"}
        </button>
      </div>
    </div>
  );
}

// ───────── 发言轮次 ─────────
function TurnPanel({ d }: { d: Deliberation }) {
  const r = useRegistry();
  return (
    <Card title="发言轮次" className="turn-panel" sub={`耗 ${fmtTokens(d.token_spent)} token`}>
      <div className="tp-row">
        <span className="muted serif">场次</span>
        <span className="display">第{cn(d.session_no)}场</span>
      </div>
      <div className="tp-row">
        <span className="muted serif">轮次</span>
        <span>
          <span className="display">第{cn(d.round)}轮</span> <span className="muted small">/ 至多{cn(d.max_rounds)}轮</span>
        </span>
      </div>
      <div className="tp-row">
        <span className="muted serif">当前发言</span>
        {d.state === "open" && d.current_speaker ? (
          <span className="row">
            <span className="dot-state pulse" style={{ color: "var(--vermilion)" }} />
            <Addr a={`post:${d.current_speaker}`} />
          </span>
        ) : (
          <span className="muted">{d.state === "open" ? "候主持" : DELIB_STATE[d.state].label}</span>
        )}
      </div>
      {d.state === "open" && (
        <>
          <div className="muted small serif" style={{ marginTop: 6 }}>
            候发言（{d.speaker_queue.length}）
          </div>
          <div className="queue">
            {d.speaker_queue.length === 0 ? (
              <span className="muted small">本轮已遍，候主持总结或开二轮</span>
            ) : (
              d.speaker_queue.map((p, i) => (
                <Tag key={p} outline>
                  {i + 1}. {r.postLabel(p)}
                </Tag>
              ))
            )}
          </div>
        </>
      )}
    </Card>
  );
}

// ───────── 宰相立场 ─────────
function MemberStances({ d, entries }: { d: Deliberation; entries: CouncilEntry[] }) {
  const r = useRegistry();
  const latest = new Map<string, CouncilEntry>();
  for (const e of [...entries].sort((a, b) => a.created_at - b.created_at)) {
    if (e.session_no === d.session_no && e.author.startsWith("post:")) latest.set(e.author.slice(5), e);
  }
  return (
    <Card title="诸相立场" sub={`本场 ${latest.size}/${d.members.length} 已言`}>
      {d.members.map((m) => {
        const p = r.post(m);
        const o = r.officialOf(m);
        const e = latest.get(m);
        const st = e?.stance ? STANCE[e.stance] : undefined;
        return (
          <div key={m} className={`member-card ${d.state === "open" && d.current_speaker === m ? "speaking" : ""}`}>
            <Seal text={(o?.name ?? p?.title ?? "相").slice(0, 1)} tone={m === d.chair_post ? "red" : "gold"} size={30} />
            <div style={{ minWidth: 0 }}>
              <div className="mc-name">
                <Link to={`/officials/${m}`}>
                  {p?.title ?? m} {o?.name}
                </Link>
              </div>
              <div className="mc-sub ellipsis">
                {m === d.chair_post ? "执政事笔 · " : ""}
                {p?.benguan ?? p?.rank ?? ""}
                {e ? ` · ${e.content.slice(0, 18)}…` : " · 尚未发言"}
              </div>
            </div>
            {st ? <Seal text={st.seal} tone={st.tone} size={28} title={st.label} /> : <span className="muted small">{d.state === "open" && d.current_speaker === m ? "执笔" : "—"}</span>}
          </div>
        );
      })}
    </Card>
  );
}

// ───────── 结论 ─────────
function Conclusion({ d, notifs, reload }: { d: Deliberation; notifs?: Notification[]; reload: () => void }) {
  const [comment, setComment] = useState("");
  const [stamp, setStamp] = useState<ReturnType<typeof optionSeal> | null>(null);
  const { run, pending } = useAction();
  const c = d.conclusion;
  const related = (notifs ?? [])
    .filter((n) => n.category === "council_conclusion" && (n.related?.id === d.id || (n.trace_id && n.trace_id === d.trace_id)))
    .sort((a, b) => b.created_at - a.created_at);
  const pendingN = related.find((n) => n.status === "pending");
  const resolvedN = related.find((n) => n.status === "resolved");

  if (!c) {
    return (
      <Card title="结论">
        <Empty seal="待" text={d.state === "open" ? "议犹未毕，候主持总结" : "无结论"} />
      </Card>
    );
  }
  const resolve = async (opt: string, label: string) => {
    if (!pendingN) return;
    const res = await run(() => hub.resolveNotification(pendingN.id, { option: opt, comment: comment.trim() || undefined }), `已批：${label}`);
    if (res) {
      setStamp(optionSeal(opt, label));
      setComment("");
      setTimeout(reload, 900);
    }
  };
  const resolvedOpt = resolvedN?.options.find((o) => o.id === resolvedN.resolution?.option);
  return (
    <Card title="议事结论" memorial className="conclusion" sub={<>主持 <Addr a={`post:${c.concluded_by}`} /></>}>
      <div className="cc-summary">{c.summary}</div>
      {c.dissent && (
        <div className="cc-block">
          <div className="cc-label">异议</div>
          <div className="serif small">{c.dissent}</div>
        </div>
      )}
      {c.proposed_edict && (
        <div className="cc-block">
          <div className="cc-label">拟旨</div>
          <div className="serif" style={{ fontWeight: 600 }}>
            {c.proposed_edict.title}
          </div>
          <div className="small muted">{c.proposed_edict.intent}</div>
        </div>
      )}
      <div className="cc-block">
        <div className="cc-label">
          置信 <span className="num">{fmtPct(c.confidence)}</span>
        </div>
        <div className="confidence">
          <i style={{ width: `${Math.round(c.confidence * 100)}%` }} />
        </div>
      </div>
      <hr />
      {stamp ? (
        <div className="row" style={{ justifyContent: "center", padding: 8 }}>
          <Seal text={stamp.text} tone={stamp.tone} size={64} stamp solid={stamp.tone === "red"} rotate={-10} />
        </div>
      ) : pendingN ? (
        <div className="col">
          <textarea placeholder="朱批（可选）" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 44 }} />
          <div className="btn-row">
            {pendingN.options.map((o, i) => (
              <button key={o.id} className={`btn ${i === 0 ? "primary" : ""}`} disabled={pending} onClick={() => resolve(o.id, o.label)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : resolvedN ? (
        <div className="row">
          <Seal text={optionSeal(resolvedN.resolution?.option ?? "", resolvedOpt?.label ?? "").text} tone="red" size={30} />
          <div className="small">
            陛下已批：<b>{resolvedOpt?.label ?? resolvedN.resolution?.option}</b>
            {resolvedN.resolution?.comment && <div className="muted">朱批：{resolvedN.resolution.comment}</div>}
          </div>
        </div>
      ) : (
        <div className="col">
          <div className="btn-row">
            <button className="btn primary" disabled title="待政事堂奏上结论待办">
              照准颁旨
            </button>
            <button className="btn" disabled>
              再议
            </button>
            <button className="btn" disabled>
              搁置
            </button>
          </div>
          <span className="muted small">尚未收到结论奏本（待办），稍候即至。</span>
        </div>
      )}
      {c.proposed_edict && (
        <div style={{ marginTop: 10 }}>
          <Link
            className="btn ghost sm"
            to={`/decree?${new URLSearchParams({ title: c.proposed_edict.title, intent: c.proposed_edict.intent, delib: d.id }).toString()}`}
          >
            依此拟旨亲颁 →
          </Link>
        </div>
      )}
    </Card>
  );
}
