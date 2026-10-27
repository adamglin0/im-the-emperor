// 驿报：全朝实时事件流（SSE）。首屏以 /api/events 与本地缓冲补齐，之后实时追加。
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { CourtEvent } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { courtBus, useCourtEvent, useSse } from "../api/events.tsx";
import { useRegistry } from "../api/registry.tsx";
import { Addr } from "../components/Addr.tsx";
import { Card, PageHead } from "../components/Card.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { PostPicker } from "../components/PostPicker.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading } from "../components/States.tsx";
import { Tag } from "../components/Tag.tsx";
import { fmtDateTime, fmtTime } from "../lib/format.ts";
import type { Tone } from "../lib/labels.ts";
import "../styles/pages/offices.css";

const CAP = 1000;

/** 事件族 → 中文与色调 */
const FAMILY: Record<string, { label: string; tone: Tone }> = {
  message: { label: "消息", tone: "azure" },
  edict: { label: "诏令", tone: "red" },
  task: { label: "任务", tone: "gold" },
  council: { label: "议事", tone: "red" },
  deliberation: { label: "议事", tone: "red" },
  approval: { label: "审批", tone: "azure" },
  court: { label: "朝政", tone: "red" },
  registry: { label: "名册", tone: "" },
  dept: { label: "署衙", tone: "" },
  acl: { label: "越权", tone: "red" },
  gateway: { label: "网关", tone: "" },
  turn: { label: "轮次", tone: "" },
  llm: { label: "LLM", tone: "" },
  tool: { label: "工具", tone: "jade" },
  service: { label: "服务", tone: "azure" },
  schedule: { label: "定时", tone: "plum" },
  notification: { label: "待办", tone: "gold" },
  audit: { label: "稽查", tone: "plum" },
  budget: { label: "预算", tone: "red" },
  config: { label: "配置", tone: "azure" },
  personnel: { label: "人事", tone: "azure" },
  exam: { label: "科举", tone: "jade" },
  model: { label: "模型", tone: "jade" },
  asset: { label: "资产", tone: "" },
  delivery: { label: "投递", tone: "red" },
  emperor: { label: "御", tone: "red" },
};
const CORE_FAMILIES = ["message", "edict", "task", "turn", "llm", "tool", "schedule", "notification", "audit"];
/** 同义族合并（council.entry 与 deliberation.state 同属议事） */
const FAMILY_ALIAS: Record<string, string> = { council: "deliberation" };
const familyOf = (type: string) => {
  const f = type.split(".")[0];
  return FAMILY_ALIAS[f] ?? f;
};
const isErr = (e: CourtEvent) => /error|fail|dead|reject|timeout/i.test(e.type);
const keyOf = (e: CourtEvent) => e.uid || String(e.id);

function mergeEvents(a: CourtEvent[], b: CourtEvent[]): CourtEvent[] {
  const m = new Map<string, CourtEvent>();
  // 不入库的轻量事件（status.changed，id<0）不进驿报：太频繁且无法回查
  for (const e of [...a, ...b]) if (!(e.id < 0)) m.set(keyOf(e), e);
  return [...m.values()].sort((x, y) => y.ts - x.ts || y.id - x.id).slice(0, CAP);
}

export default function FeedPage() {
  const r = useRegistry();
  const { state } = useSse();
  const [events, setEvents] = useState<CourtEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<unknown>(undefined);
  const [paused, setPaused] = useState(false);
  const buffer = useRef<CourtEvent[]>([]);
  const [buffered, setBuffered] = useState(0);
  const fresh = useRef(new Set<string>());
  const [fams, setFams] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [dept, setDept] = useState("");
  const [trace, setTrace] = useState("");
  const [actor, setActor] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const seed = () => {
    setLoading(true);
    hub
      .events({ limit: 300 })
      .then((list) => {
        setEvents((cur) => mergeEvents(cur, mergeEvents(list, courtBus.recent)));
        setErr(undefined);
      })
      .catch((e) => {
        setErr(e);
        setEvents((cur) => mergeEvents(cur, courtBus.recent));
      })
      .finally(() => setLoading(false));
  };
  useEffect(seed, []);

  useCourtEvent((e) => {
    if (paused) {
      buffer.current.push(e);
      setBuffered(buffer.current.length);
      return;
    }
    fresh.current.add(keyOf(e));
    setEvents((cur) => mergeEvents([e], cur));
  });

  const resume = () => {
    const b = buffer.current;
    buffer.current = [];
    setBuffered(0);
    for (const e of b) fresh.current.add(keyOf(e));
    setEvents((cur) => mergeEvents(b, cur));
    setPaused(false);
  };

  const seenFams = useMemo(() => {
    // 常设诸族 + 实际出现过的族
    const s = new Set(CORE_FAMILIES);
    for (const e of events) s.add(familyOf(e.type));
    for (const f of fams) s.add(f);
    return [...s];
  }, [events, fams]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events) m[familyOf(e.type)] = (m[familyOf(e.type)] ?? 0) + 1;
    return m;
  }, [events]);

  const filtered = useMemo(() => {
    const k = text.trim().toLowerCase();
    const t = trace.trim();
    return events.filter(
      (e) =>
        (fams.length === 0 || fams.includes(familyOf(e.type))) &&
        (!dept || e.dept === dept || e.actor.startsWith(`post:${dept}.`) || e.actor === `dept:${dept}`) &&
        (!t || (e.trace_id ?? "").includes(t)) &&
        (!actor || e.actor === actor || (actor.startsWith("dept:") && e.actor.startsWith(`post:${actor.slice(5)}.`))) &&
        (!k || `${e.type} ${e.summary} ${e.actor} ${r.addrLabel(e.actor)} ${e.subject_id ?? ""}`.toLowerCase().includes(k)),
    );
  }, [events, fams, text, dept, trace, actor, r]);
  const dead = events.filter((e) => e.type.startsWith("delivery.dead"));
  const anyFilter = fams.length || text || dept || trace || actor;

  return (
    <div className="page">
      <PageHead
        title="驿报"
        lede="八百里加急：全朝事件实时传驿。点一行展开细节，点 trace 直达执行图。"
        actions={
          <>
            <span className={`live-lamp ${state === "open" ? "on" : state === "closed" ? "off" : ""}`}>
              <span className="dot" />
              {state === "open" ? "驿路通" : state === "connecting" ? "连接中" : "驿路断绝（轮询兜底）"}
            </span>
            {paused ? (
              <button className="btn primary" onClick={resume}>
                续传{buffered ? `（积 ${buffered}）` : ""}
              </button>
            ) : (
              <button className="btn" onClick={() => setPaused(true)}>
                暂停
              </button>
            )}
            <button
              className="btn ghost"
              onClick={() => {
                setEvents([]);
                fresh.current.clear();
              }}
            >
              清屏
            </button>
            <button className="btn ghost" onClick={seed}>
              补取
            </button>
          </>
        }
      />

      <div className="feed-shell">
        <Card level={3}>
          <div className="feed-filters">
            <div className="fam-chips">
              <button className={`chip ${fams.length === 0 ? "on" : ""}`} onClick={() => setFams([])}>
                全部 <span className="muted num">{events.length}</span>
              </button>
              {seenFams.map((f) => {
                const on = fams.includes(f);
                const meta = FAMILY[f] ?? { label: f, tone: "" as Tone };
                return (
                  <button key={f} className={`chip ${on ? "on" : ""}`} onClick={() => setFams(on ? fams.filter((x) => x !== f) : [...fams, f])} title={`${f}.*`}>
                    <span className="sw" style={{ background: meta.tone ? `var(--${meta.tone === "red" ? "vermilion" : meta.tone})` : "var(--ink-3)" }} />
                    {meta.label}
                    <span className="muted num">{counts[f] ?? 0}</span>
                  </button>
                );
              })}
            </div>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <input type="search" placeholder="检索摘要、类型…" value={text} onChange={(e) => setText(e.target.value)} style={{ maxWidth: 220 }} />
              <select value={dept} onChange={(e) => setDept(e.target.value)} style={{ maxWidth: 140 }}>
                <option value="">全部部门</option>
                {r.depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <input type="search" className="mono" placeholder="trace_id" value={trace} onChange={(e) => setTrace(e.target.value)} style={{ maxWidth: 180 }} />
              <div style={{ width: 240 }}>
                <PostPicker value={actor} onChange={setActor} placeholder="发起者（官员/部门）" />
              </div>
              {anyFilter ? (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setFams([]);
                    setText("");
                    setDept("");
                    setTrace("");
                    setActor("");
                  }}
                >
                  清除筛选
                </button>
              ) : null}
              <span className="muted small" style={{ marginLeft: "auto" }}>
                显示 {filtered.length} / {events.length}（至多 {CAP}）
              </span>
            </div>
          </div>
        </Card>

        {dead.length > 0 && (
          <Card title="死信" sub="投递失败、无人收取的公文" urgent memorial>
            {dead.slice(0, 20).map((e) => (
              <div key={keyOf(e)} className="row" style={{ padding: "4px 0", borderBottom: "1px dashed var(--rule)" }}>
                <span className="mono small muted">{fmtDateTime(e.ts)}</span>
                <Addr a={e.actor} />
                <span className="grow small">{e.summary}</span>
                <button className="btn sm" disabled title="hub 尚未提供重投接口">
                  重投（待后端支持）
                </button>
              </div>
            ))}
          </Card>
        )}

        <Card flush>
          {paused && (
            <div className="paused-bar">
              <Seal text="停" tone="gold" size={22} />
              驿报已暂停{buffered ? `，积压 ${buffered} 件` : ""}。
              <button className="btn sm primary" onClick={resume}>
                续传
              </button>
            </div>
          )}
          {err !== undefined && (
            <div style={{ padding: 10 }}>
              <ErrorBox error={err} onRetry={seed} />
            </div>
          )}
          <div className="feed-head" role="row">
            <span>时刻</span>
            <span>类型</span>
            <span>发起</span>
            <span className="dept">部门</span>
            <span>摘要</span>
            <span className="trace">trace</span>
          </div>
          {loading && events.length === 0 ? (
            <Loading text="候驿" />
          ) : filtered.length === 0 ? (
            <Empty text={events.length ? "无符合筛选之事件" : "驿路静谧，尚无事件"} seal="驿" />
          ) : (
            <div className="feed-list">
              {filtered.map((e) => {
                const k = keyOf(e);
                const fam = familyOf(e.type);
                const meta = FAMILY[fam] ?? { label: fam, tone: "" as Tone };
                const isOpen = open === k;
                return (
                  <div key={k}>
                    <div className={`feed-row ${fresh.current.has(k) ? "fresh" : ""} ${isErr(e) ? "err" : ""}`} onClick={() => setOpen(isOpen ? null : k)}>
                      <span className="ts" title={fmtDateTime(e.ts)}>
                        {fmtTime(e.ts)}
                      </span>
                      <span>
                        <Tag tone={isErr(e) ? "red" : meta.tone}>
                          <span className="type" title={e.type}>{e.type}</span>
                        </Tag>
                      </span>
                      <span className="ellipsis">
                        <Addr a={e.actor} />
                      </span>
                      <span className="dept small muted">{e.dept ? r.deptName(e.dept) : ""}</span>
                      <span className="summary ellipsis" title={e.summary}>
                        {e.summary}
                      </span>
                      <span className="trace ellipsis small">
                        {e.trace_id ? (
                          <Link to={`/edicts/${e.trace_id}`} className="mono" onClick={(x) => x.stopPropagation()}>
                            {e.trace_id}
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </span>
                    </div>
                    {isOpen && (
                      <div className="feed-detail">
                        <dl className="kv" style={{ marginBottom: 8 }}>
                          <dt>事件</dt>
                          <dd className="mono small">
                            #{e.id} · {e.uid}
                          </dd>
                          <dt>时刻</dt>
                          <dd>{fmtDateTime(e.ts)}</dd>
                          {e.subject_type && (
                            <>
                              <dt>对象</dt>
                              <dd className="mono small">
                                {e.subject_type}:{e.subject_id}
                              </dd>
                            </>
                          )}
                          {e.span_id && (
                            <>
                              <dt>span</dt>
                              <dd className="mono small">
                                {e.span_id}
                                {e.parent_span_id ? ` ← ${e.parent_span_id}` : ""}
                              </dd>
                            </>
                          )}
                          <dt>摘要</dt>
                          <dd>{e.summary}</dd>
                        </dl>
                        {e.data ? <JsonView value={e.data} maxHeight={260} /> : <span className="muted small">无附加数据</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
