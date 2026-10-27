// 颁旨 · 口谕 · 私聊
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { Message } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo } from "../components/Addr.tsx";
import { Card, PageHead } from "../components/Card.tsx";
import { useConfirm } from "../components/Overlay.tsx";
import { PostPicker } from "../components/PostPicker.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading } from "../components/States.tsx";
import { Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { fmtTokens } from "../lib/format.ts";
import { MESSAGE_KIND } from "../lib/labels.ts";
import "../styles/pages/home.css";

export default function DecreePage() {
  const [sp, setSp] = useSearchParams();
  const chatPost = sp.get("chat") ?? "";
  const setChat = (post: string) => {
    const next = new URLSearchParams(sp);
    if (post) next.set("chat", post);
    else next.delete("chat");
    setSp(next, { replace: true });
  };
  return (
    <div className="page">
      <PageHead title="颁旨 · 口谕 · 私聊" lede="圣旨经中书起草、门下审核、尚书分派；口谕直达其人其司；私聊只在君臣之间" />
      <div className="decree-grid">
        <EdictForm initTitle={sp.get("title") ?? ""} initIntent={sp.get("intent") ?? ""} deliberationId={sp.get("delib") ?? undefined} />
        <OralForm />
      </div>
      <div style={{ marginTop: 18 }}>
        <PrivateChat post={chatPost} onPost={setChat} />
      </div>
    </div>
  );
}

// ───────── 颁旨 ─────────
function EdictForm({ initTitle, initIntent, deliberationId }: { initTitle: string; initIntent: string; deliberationId?: string }) {
  const nav = useNavigate();
  const confirm = useConfirm();
  const { run, pending } = useAction();
  const [title, setTitle] = useState(initTitle);
  const [intent, setIntent] = useState(initIntent);
  const [budget, setBudget] = useState("");
  const [deadline, setDeadline] = useState("");
  const [skip, setSkip] = useState(false);
  useEffect(() => {
    if (initTitle) setTitle(initTitle);
    if (initIntent) setIntent(initIntent);
  }, [initTitle, initIntent]);

  const budgetN = budget ? Number(budget) : undefined;
  const deadlineN = deadline ? Number(deadline) : undefined;
  const invalid = !title.trim() || !intent.trim() || (budgetN !== undefined && !(budgetN > 0)) || (deadlineN !== undefined && !(deadlineN > 0));

  const submit = async () => {
    if (invalid) return;
    if (skip) {
      const ok = await confirm({
        title: "以墨敕颁行？",
        body: "墨敕不经门下审核，直接交尚书省分派执行。此举留痕，并抄送御史台。",
        okText: "墨敕颁行",
        danger: true,
      });
      if (!ok) return;
    }
    const e = await run(
      () =>
        hub.emperorEdict({
          title: title.trim(),
          intent: intent.trim(),
          deliberation_id: deliberationId,
          skip_review: skip || undefined,
          budget_tokens: budgetN,
          deadline_minutes: deadlineN,
        }),
      "圣旨已颁",
    );
    if (e) nav(`/edicts/${e.id}`);
  };

  return (
    <Card title="颁旨" sub="交中书起草" memorial className="edict-form">
      {deliberationId && (
        <div className="small muted" style={{ marginBottom: 8 }}>
          承政事堂议事 <Link to={`/council?id=${deliberationId}`}>{deliberationId}</Link>
        </div>
      )}
      <label className="field">
        <span className="label">诏题</span>
        <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：撰《贞观律令摘要》并译为英文" maxLength={80} />
      </label>
      <label className="field intent-box">
        <span className="label">旨意（目标、验收、约束，朕之原话）</span>
        <textarea value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="朕欲……着有司……务求……" />
        <span className="hint">中书据此起草正式诏书，写明目标、约束、验收标准、期限、预算与承办部门。</span>
      </label>
      <div className="grid g2" style={{ gap: 12 }}>
        <label className="field">
          <span className="label">预算上限（token）</span>
          <input type="number" min={1} step={10000} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="不填则依全局预算" />
          {budgetN ? <span className="hint">约 {fmtTokens(budgetN)}</span> : null}
        </label>
        <label className="field">
          <span className="label">期限（分钟）</span>
          <input type="number" min={1} step={30} value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder="不填则不限" />
          {deadlineN ? <span className="hint">约 {deadlineN >= 60 ? `${(deadlineN / 60).toFixed(1)} 小时` : `${deadlineN} 分钟`}后</span> : null}
        </label>
      </div>
      <label className={`mochi ${skip ? "on" : ""}`}>
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
        <div>
          <div className="serif">
            <b>墨敕</b>（绕过门下审核）
          </div>
          <div className="small muted">不经封驳，直交尚书省。</div>
          {skip && <div className="warn">⚠ 墨敕留痕：此旨将抄送御史台备查，门下省不得封驳。慎用。</div>}
        </div>
      </label>
      <div className="row">
        <span className="grow muted small">流转：中书起草 → {skip ? "（墨敕跳过门下）" : "门下审核 →"} 尚书分派 → 六部执行 → 复奏</span>
        <button className="btn primary" disabled={invalid || pending} onClick={submit}>
          <span className="display">敕</span> {skip ? "墨敕颁行" : "颁旨"}
        </button>
      </div>
    </Card>
  );
}

// ───────── 口谕 ─────────
function OralForm() {
  const r = useRegistry();
  const [to, setTo] = useState("");
  const [content, setContent] = useState("");
  const [reply, setReply] = useState(true);
  const { run, pending } = useAction();
  const [sent, setSent] = useState<{ to: string; routed: string[] } | null>(null);
  const send = async () => {
    if (!to || !content.trim()) return;
    const res = await run(() => hub.emperorOral({ to, content: content.trim(), requires_reply: reply }), "口谕已传");
    if (res) {
      setSent({ to, routed: res.routed_to });
      setContent("");
    }
  };
  return (
    <Card title="口谕" sub="直达一人或一司">
      <div className="field">
        <span className="label">传谕于</span>
        <PostPicker value={to} onChange={setTo} placeholder="搜索职位、官员或部门（部门按路由分派）" />
      </div>
      <label className="field">
        <span className="label">谕旨</span>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="今日各部用度几何？速报。" />
      </label>
      <div className="row">
        <label className="row small grow">
          <input type="checkbox" checked={reply} onChange={(e) => setReply(e.target.checked)} /> 须回奏（唤醒并等待答复）
        </label>
        <button className="btn primary" disabled={!to || !content.trim() || pending} onClick={send}>
          <span className="display">谕</span> 传谕
        </button>
      </div>
      {sent && (
        <div className="small" style={{ marginTop: 10, padding: "8px 10px", background: "var(--jade-soft)", borderRadius: 3 }}>
          已传至 <Addr a={sent.to} />
          {sent.routed.length > 0 && <> → 实际承接：{sent.routed.map((p) => r.postLabel(p)).join("、")}</>}
          。回奏将见于御书房「御前来信」。
        </div>
      )}
      <hr />
      <div className="small muted serif">
        口谕不经三省，不入诏令流程；若需多部协同、验收与复奏，请颁旨。
      </div>
    </Card>
  );
}

// ───────── 私聊 ─────────
function PrivateChat({ post, onPost }: { post: string; onPost: (p: string) => void }) {
  const r = useRegistry();
  const inbox = useQuery(() => hub.emperorInbox({ limit: 100 }), [], { watch: ["message."] });
  const contacts = useMemo(() => {
    const seen = new Map<string, number>();
    for (const m of inbox.data ?? []) {
      if (m.from.startsWith("post:")) {
        const p = m.from.slice(5);
        seen.set(p, Math.max(seen.get(p) ?? 0, m.created_at));
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [inbox.data]);
  return (
    <Card title="私聊" sub="君臣对语，不入公文" flush>
      <div className="chat-panel">
        <div className="chat-contacts">
          <PostPicker mode="post" value={post} onChange={onPost} includeDepts={false} placeholder="召见某官…" />
          <div className="muted small serif" style={{ marginTop: 4 }}>
            近来往来
          </div>
          {contacts.length === 0 && <div className="muted small">尚无</div>}
          {contacts.map(([p, at]) => (
            <div key={p} className={`chat-contact ${p === post ? "active" : ""}`} onClick={() => onPost(p)}>
              <Seal text={(r.officialOf(p)?.name ?? r.post(p)?.title ?? "臣").slice(0, 1)} tone="gold" size={24} />
              <span className="grow ellipsis">{r.postLabel(p)}</span>
              <span className="muted small">
                <TimeAgo ms={at} />
              </span>
            </div>
          ))}
        </div>
        {post ? <ChatWindow post={post} /> : <Empty seal="召" text="择一臣以召对" />}
      </div>
    </Card>
  );
}

function ChatWindow({ post }: { post: string }) {
  const r = useRegistry();
  const q = useQuery(() => hub.emperorChat(post, 200), [post], { watch: ["message."], interval: 20_000 });
  const [text, setText] = useState("");
  const [reply, setReply] = useState(true);
  const { run, pending } = useAction();
  const logRef = useRef<HTMLDivElement>(null);
  const msgs = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.created_at - b.created_at), [q.data]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);
  const send = async () => {
    const content = text.trim();
    if (!content) return;
    const res = await run(() => hub.emperorOral({ to: `post:${post}`, content, requires_reply: reply }));
    if (res) {
      setText("");
      q.setData((d) => [...(d ?? []), res.message]);
      setTimeout(q.reload, 600);
    }
  };
  const p = r.post(post);
  return (
    <div className="chat-main">
      <div className="chat-head">
        <Seal text={(r.officialOf(post)?.name ?? p?.title ?? "臣").slice(0, 1)} tone="gold" size={28} />
        <div className="grow">
          <Link to={`/officials/${post}`} className="serif" style={{ fontWeight: 600 }}>
            {r.postLabel(post)}
          </Link>
          <div className="small muted">
            {r.deptName(p?.dept)} · {p?.rank}
          </div>
        </div>
      </div>
      <div className="chat-log transcript" ref={logRef}>
        {q.initial ? (
          <Loading />
        ) : !q.data && q.error ? (
          <ErrorBox error={q.error} onRetry={q.reload} />
        ) : msgs.length === 0 ? (
          <Empty seal="对" text="尚无对语" />
        ) : (
          msgs.map((m) => <ChatBubble key={m.id} m={m} />)
        )}
      </div>
      <div className="composer">
        <textarea
          placeholder="卿以为如何？"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="row">
          <label className="row small grow">
            <input type="checkbox" checked={reply} onChange={(e) => setReply(e.target.checked)} /> 须回奏 · ⌘/Ctrl + Enter 发送
          </label>
          <button className="btn primary" disabled={pending || !text.trim()} onClick={send}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ m }: { m: Message }) {
  const r = useRegistry();
  const mine = m.from === "emperor";
  const author = mine ? undefined : m.from.startsWith("post:") ? m.from.slice(5) : m.from;
  return (
    <div className={`speech ${mine ? "emperor" : ""}`}>
      {mine ? (
        <Seal text="朕" tone="red" solid size={30} rotate={4} className="avatar" />
      ) : (
        <Seal text={(r.officialOf(author ?? "")?.name ?? "臣").slice(0, 1)} tone="gold" size={30} className="avatar" />
      )}
      <div className="bubble">
        <div className="who">
          {mine ? (
            <>
              <TimeAgo ms={m.created_at} />
              {m.requires_reply && <Tag tone="red">须回奏</Tag>}
              {m.kind !== "chat" && <Tag>{MESSAGE_KIND[m.kind]}</Tag>}
              <b>陛下</b>
            </>
          ) : (
            <>
              <b>{r.addrLabel(m.from)}</b>
              {m.kind !== "chat" && <Tag>{MESSAGE_KIND[m.kind]}</Tag>}
              <TimeAgo ms={m.created_at} />
            </>
          )}
        </div>
        <div className="text">{m.body}</div>
      </div>
    </div>
  );
}
