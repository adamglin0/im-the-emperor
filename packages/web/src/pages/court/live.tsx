// 官员实时：思考流、上下文查看器、JSONL 日志
import { useEffect, useMemo, useRef, useState } from "react";
import { live, type LogLine } from "../../api/live.ts";
import { useRegistry } from "../../api/registry.tsx";
import { JsonView } from "../../components/JsonView.tsx";
import { Empty, ErrorBox, Loading } from "../../components/States.tsx";
import { Tag } from "../../components/Tag.tsx";
import { fmtTime, fmtTokens, isoDate, truncate } from "../../lib/format.ts";
import { useLiveQuery } from "./shared.tsx";

// ───────── 实时流 ─────────
type Block =
  | { kind: "think"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; args: unknown; result?: unknown; isError?: boolean; done: boolean; startedAt: number; endedAt?: number }
  | { kind: "raw"; data: unknown };
interface Turn {
  id: number;
  startedAt: number;
  done: boolean;
  blocks: Block[];
}

const MAX_TURNS = 40;

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 把一条流事件并入轮次列表（纯函数，便于暂停时缓存后批量回放） */
/** 官员不在轮次中的状态：收到即视为本轮结束 */
const RESTING = new Set(["idle", "sleeping", "waiting", "paused", "suspended", "sick", "offline", "vacant"]);

function reduce(turns: Turn[], raw: unknown): Turn[] {
  let d = (raw && typeof raw === "object" ? raw : { type: "text", data: raw }) as Record<string, any>;
  // 部门实时流信封：{type, post, ts, data:{...}} → 摊平
  if (typeof d.post === "string" && d.data && typeof d.data === "object" && !Array.isArray(d.data)) d = { ...d.data, type: d.type, ts: d.ts };
  let type: string = d.type ?? "";
  let delta: string | undefined = typeof d.delta === "string" ? d.delta : undefined;
  // 部门实时流事件 → 本组件的规范事件
  switch (type) {
    case "status": // 连接时的首帧（OfficialStatus），不入流
    case "ping":
    case "toolcall_delta":
    case "llm_end":
      return turns;
    case "state": {
      const st = String(d.state ?? "");
      if (st === "thinking" || st === "tool") {
        const last = turns[turns.length - 1];
        if (last && !last.done) return turns;
        type = "turn_start";
      } else if (RESTING.has(st)) type = "turn_end";
      else return turns;
      break;
    }
    case "tool_start":
      type = "tool_execution_start";
      d = { toolCallId: d.tool_call_id, toolName: d.tool, args: d.args };
      break;
    case "tool_end":
      type = "tool_execution_end";
      d = { toolCallId: d.tool_call_id, toolName: d.tool, result: d.result, isError: d.is_error };
      break;
    case "user_message":
      raw = `【简报/来信】${String(d.text ?? "")}`;
      break;
    case "message_out":
      raw = `【发信】${d.to ? `→ ${String(d.to)} ` : ""}${String(d.subject ?? d.message_id ?? "")}`;
      break;
    case "compact":
      raw = `【压缩上下文】${d.tokens_before ?? "?"} → ${d.tokens_after ?? "?"} tokens`;
      break;
  }
  // pi Agent message_update：{assistantMessageEvent:{type:text_delta|thinking_delta, delta}}
  if (type === "message_update" && d.assistantMessageEvent) {
    const ame = d.assistantMessageEvent;
    if (ame.type === "text_delta" || ame.type === "thinking_delta") {
      type = ame.type;
      delta = ame.delta;
    } else return turns;
  }
  const next = turns.slice();
  const newTurn = (): Turn => ({ id: Date.now() + Math.random(), startedAt: Date.now(), done: false, blocks: [] });
  let cur = next[next.length - 1];
  const ensure = () => {
    if (!cur || cur.done) {
      cur = newTurn();
      next.push(cur);
    } else {
      cur = { ...cur, blocks: cur.blocks.slice() };
      next[next.length - 1] = cur;
    }
    return cur;
  };
  switch (type) {
    case "agent_start":
    case "turn_start": {
      if (cur && !cur.done && cur.blocks.length === 0) return turns;
      if (cur && !cur.done) next[next.length - 1] = { ...cur, done: true };
      next.push(newTurn());
      break;
    }
    case "turn_end":
    case "agent_end": {
      if (cur && !cur.done) next[next.length - 1] = { ...cur, done: true };
      break;
    }
    case "thinking_delta":
    case "text_delta": {
      const t = ensure();
      const k = type === "thinking_delta" ? "think" : "text";
      const last = t.blocks[t.blocks.length - 1];
      if (last && last.kind === k) t.blocks[t.blocks.length - 1] = { ...last, text: last.text + (delta ?? "") };
      else t.blocks.push({ kind: k, text: delta ?? "" });
      break;
    }
    case "tool_execution_start": {
      const t = ensure();
      t.blocks.push({ kind: "tool", id: String(d.toolCallId ?? Math.random()), name: String(d.toolName ?? "?"), args: d.args, done: false, startedAt: Date.now() });
      break;
    }
    case "tool_execution_end": {
      const t = ensure();
      const i = t.blocks.findIndex((b) => b.kind === "tool" && b.id === String(d.toolCallId));
      if (i >= 0) {
        const b = t.blocks[i] as Extract<Block, { kind: "tool" }>;
        t.blocks[i] = { ...b, done: true, result: d.result, isError: !!d.isError, endedAt: Date.now() };
      } else t.blocks.push({ kind: "tool", id: String(d.toolCallId), name: String(d.toolName ?? "?"), args: d.args, result: d.result, isError: !!d.isError, done: true, startedAt: Date.now(), endedAt: Date.now() });
      break;
    }
    case "message_start":
    case "message_end":
    case "tool_execution_update":
      return turns;
    default: {
      const t = ensure();
      t.blocks.push({ kind: "raw", data: raw });
    }
  }
  return next.slice(-MAX_TURNS);
}

export function LiveStream({ post }: { post: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conn, setConn] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const buffer = useRef<unknown[]>([]);
  const [buffered, setBuffered] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setTurns([]);
    setConn(null);
    let close: () => void = () => {};
    try {
      close = live.stream(
        post,
        (d) => {
          if (pausedRef.current) {
            buffer.current.push(d);
            setBuffered(buffer.current.length);
            return;
          }
          setTurns((ts) => reduce(ts, d));
        },
        (open) => setConn(open),
      );
    } catch {
      setConn(false);
    }
    return () => close();
  }, [post]);

  useEffect(() => {
    const el = paneRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const togglePause = () => {
    if (pausedRef.current) {
      const buf = buffer.current;
      buffer.current = [];
      setBuffered(0);
      setTurns((ts) => buf.reduce<Turn[]>((acc, d) => reduce(acc, d), ts));
    }
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };

  return (
    <div>
      <div className="toolbar">
        <span className={`live-lamp ${conn ? "on" : conn === false ? "off" : ""}`}>
          <span className="dot" />
          <span className="label">{conn ? "实时流已连通" : conn === false ? "实时流未连通（部门署衙或官员不可达，自动重连中）" : "连接中"}</span>
        </span>
        <span className="grow" />
        {paused && buffered > 0 && <span className="small muted">已缓存 {buffered} 条</span>}
        <button className="btn sm" onClick={togglePause}>
          {paused ? "续看" : "暂停"}
        </button>
        <button className="btn sm ghost" onClick={() => setTurns([])}>
          清屏
        </button>
      </div>
      <div
        className="live-pane"
        ref={paneRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {turns.length === 0 ? (
          <Empty text={conn ? "静候官员下一轮思考……" : "尚无实时数据"} seal="候" />
        ) : (
          turns.map((t, ti) => (
            <div key={t.id} className={`live-turn ${t.done ? "" : "active"}`}>
              <div className="live-turn-head">
                第 {ti + 1} 轮 · {fmtTime(t.startedAt)} {t.done ? "· 毕" : "· 进行中"}
              </div>
              {t.blocks.map((b, i) => {
                if (b.kind === "think") return <div key={i} className="live-think">{b.text}</div>;
                if (b.kind === "text")
                  return (
                    <div key={i} className="live-text">
                      {b.text}
                      {!t.done && i === t.blocks.length - 1 && <span className="caret" />}
                    </div>
                  );
                if (b.kind === "tool")
                  return (
                    <div key={i} className={`live-tool ${b.isError ? "err" : ""}`}>
                      <span>{b.done ? (b.isError ? "✕" : "✓") : <span className="pulse">◌</span>}</span>
                      <span className="tn">{b.name}</span>
                      <span className="ta">{truncate(str(b.args), 160)}</span>
                      {b.done && <span className="ta">⇒ {truncate(str(b.result), 200)}</span>}
                      {b.endedAt && <span className="muted">{((b.endedAt - b.startedAt) / 1000).toFixed(1)}s</span>}
                    </div>
                  );
                return (
                  <div key={i} className="live-raw">
                    {truncate(str(b.data), 400)}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ───────── 上下文查看器 ─────────
type Part = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown; id?: string };
function parts(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as Part[];
  if (content && typeof content === "object") return [content as Part];
  return [];
}
const ROLE_LABEL: Record<string, string> = { user: "简报/来信", assistant: "官员", toolResult: "工具回执", system: "系统" };

export function ContextView({ post, modelKey }: { post: string; modelKey?: string }) {
  const r = useRegistry();
  const q = useLiveQuery(() => live.context(post), [post]);
  const [showSys, setShowSys] = useState(false);
  const win = r.registry?.models.find((m) => m.key === modelKey)?.context_window ?? 128_000;
  if (q.loading && !q.data) return <Loading text="调阅上下文" />;
  if (q.error && !q.data) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const c = q.data;
  const pct = Math.min(100, (c.context_tokens / win) * 100);
  return (
    <div className="stack">
      <div>
        <div className="row between small" style={{ marginBottom: 4 }}>
          <span>
            上下文 <span className="num">{fmtTokens(c.context_tokens)}</span> / {fmtTokens(win)} tokens（{pct.toFixed(0)}%）· {c.messages.length} 条
          </span>
          <span className="muted">虚线＝自动压缩阈值 60%</span>
          <button className="btn sm ghost" onClick={q.reload}>
            刷新
          </button>
        </div>
        <div className={`ctx-meter ${pct > 60 ? "hot" : ""}`}>
          <i style={{ width: `${pct}%` }} />
          <span className="mark" style={{ left: "60%" }} />
        </div>
      </div>
      <div>
        <button className="btn sm" onClick={() => setShowSys(!showSys)}>
          {showSys ? "收起" : "展开"}系统提示（{fmtTokens(c.system_prompt.length)} 字）
        </button>
        {showSys && <pre className="code-block" style={{ marginTop: 8 }}>{c.system_prompt}</pre>}
      </div>
      <div>
        {c.messages.length === 0 && <Empty text="上下文为空" />}
        {c.messages.map((m, i) => {
          const msg = (m ?? {}) as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
          const role = msg.role ?? "?";
          return (
            <div key={i} className={`ctx-msg ${role}`}>
              <div className="ctx-msg-head">
                <Tag tone={role === "assistant" ? "red" : role === "toolResult" ? "azure" : "gold"}>{ROLE_LABEL[role] ?? role}</Tag>
                {msg.toolName && <span className="mono">{msg.toolName}</span>}
                {msg.isError && <Tag tone="red">出错</Tag>}
                <span className="grow" />
                <span className="muted mono">#{i + 1}</span>
              </div>
              <div className="ctx-msg-body">
                {parts(msg.content).map((p, j) => {
                  if (p.type === "thinking") return <div key={j} className="live-think">{p.thinking ?? p.text}</div>;
                  if (p.type === "toolCall")
                    return (
                      <div key={j} className="live-tool">
                        <span className="tn">{p.name}</span>
                        <span className="ta">{truncate(str(p.arguments), 400)}</span>
                      </div>
                    );
                  if (p.type === "text") return <div key={j} className="live-text" style={{ fontSize: 13 }}>{truncate(p.text ?? "", 4000)}</div>;
                  if (p.type === "image") return <div key={j} className="muted">[图像]</div>;
                  return <JsonView key={j} value={p} maxHeight={200} />;
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────── JSONL 日志 ─────────
const LOG_TONE: Record<string, "red" | "gold" | "jade" | "azure" | "plum" | "ink" | ""> = {
  wake: "gold",
  turn_start: "jade",
  turn_end: "jade",
  llm_start: "",
  llm_end: "",
  tool_call: "azure",
  tool_result: "azure",
  message_out: "red",
  message_in: "red",
  sleep: "ink",
  wait: "ink",
  compact: "plum",
  error: "red",
  budget_block: "red",
  config_reload: "plum",
};
const LOG_LABEL: Record<string, string> = {
  wake: "醒",
  turn_start: "轮始",
  turn_end: "轮终",
  llm_start: "问模",
  llm_end: "模答",
  tool_call: "用器",
  tool_result: "器回",
  message_out: "发信",
  message_in: "收信",
  sleep: "眠",
  wait: "候",
  compact: "压缩",
  error: "误",
  config_reload: "改制",
  budget_block: "停俸",
};

function summarizeLog(l: LogLine): string {
  const skip = new Set(["ts", "type", "official_id", "post_id", "dept", "trace_id", "span_id", "turn_id"]);
  const bits: string[] = [];
  for (const [k, v] of Object.entries(l)) {
    if (skip.has(k) || v === undefined || v === null) continue;
    bits.push(`${k}=${truncate(str(v), 80)}`);
  }
  return bits.join("  ");
}

export function LogView({ post }: { post: string }) {
  const [date, setDate] = useState(() => isoDate(Date.now()));
  const [tail, setTail] = useState(300);
  const q = useLiveQuery(() => live.log(post, { date, tail }), [post, date, tail]);
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const allTypes = useMemo(() => [...new Set((q.data ?? []).map((l) => String(l.type ?? "?")))], [q.data]);
  const rows = (q.data ?? []).filter((l) => types.size === 0 || types.has(String(l.type)));
  return (
    <div>
      <div className="toolbar">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 150 }} aria-label="日期" />
        <select value={tail} onChange={(e) => setTail(Number(e.target.value))} style={{ width: 110 }} aria-label="条数">
          {[100, 300, 1000, 3000].map((n) => (
            <option key={n} value={n}>
              末 {n} 条
            </option>
          ))}
        </select>
        <button className="btn sm ghost" onClick={q.reload}>
          刷新
        </button>
        <span className="grow" />
        <span className="small muted">
          {rows.length}/{q.data?.length ?? 0} 条
        </span>
      </div>
      {allTypes.length > 0 && (
        <div className="log-chips" style={{ marginBottom: 10 }}>
          {allTypes.map((t) => (
            <button
              key={t}
              className={`log-chip ${types.has(t) ? "on" : ""}`}
              onClick={() => {
                const n = new Set(types);
                if (n.has(t)) n.delete(t);
                else n.add(t);
                setTypes(n);
              }}
            >
              {t}
            </button>
          ))}
          {types.size > 0 && (
            <button className="log-chip" onClick={() => setTypes(new Set())}>
              全部
            </button>
          )}
        </div>
      )}
      {q.loading && !q.data ? (
        <Loading text="调阅起居注" />
      ) : q.error && !q.data ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : rows.length === 0 ? (
        <Empty text="此日无起居注" seal="录" />
      ) : (
        <div className="card" style={{ maxHeight: "62vh", overflow: "auto" }}>
          {rows.map((l, i) => {
            const t = String(l.type ?? "?");
            return (
              <div key={i} className={`log-row ${open === i ? "open" : ""}`} onClick={() => setOpen(open === i ? null : i)}>
                <span className="lt">{typeof l.ts === "number" ? fmtTime(l.ts) : "—"}</span>
                <span className="ly">
                  <Tag tone={LOG_TONE[t] ?? ""}>
                    {LOG_LABEL[t] ? `${LOG_LABEL[t]} ` : ""}
                    {t}
                  </Tag>
                </span>
                <span className="ls">{summarizeLog(l)}</span>
                {open === i && (
                  <div className="log-detail" onClick={(e) => e.stopPropagation()}>
                    <JsonView value={l} maxHeight={300} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
