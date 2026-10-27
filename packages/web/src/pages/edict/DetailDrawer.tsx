// 节点详情抽屉：span 树（轮次→LLM/工具→消息）、事件、草稿正文与 diff、封驳意见与回应、任务详情、服务回执。
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { EdictDetail } from "@court/shared/api";
import type { CourtEvent, Span } from "@court/shared/types";
import { hub } from "../../api/client.ts";
import { Addr, TimeAgo } from "../../components/Addr.tsx";
import { DiffView } from "../../components/DiffView.tsx";
import { Drawer } from "../../components/Overlay.tsx";
import { Seal } from "../../components/Seal.tsx";
import { Empty, QueryView } from "../../components/States.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { Tag, TaskStateTag } from "../../components/Tag.tsx";
import { JsonView } from "../../components/JsonView.tsx";
import { useQuery } from "../../hooks/useQuery.ts";
import { DEPT_NAMES, SPAN_KIND, SPAN_STATUS } from "../../lib/labels.ts";
import { fmtCost, fmtDateTime, fmtDuration, fmtTime, fmtTokens } from "../../lib/format.ts";
import { nodeDuration, statusSeal, STATUS_LABEL, isErrorEvent, type MacroGraph, type MacroNode } from "./model.ts";

type TabKey = "detail" | "spans" | "events";

export function DetailDrawer({
  g,
  node,
  detail,
  events,
  focusSpan,
  onClose,
  now,
}: {
  g: MacroGraph;
  node: MacroNode | undefined;
  detail: EdictDetail | undefined;
  events: CourtEvent[];
  focusSpan?: string;
  onClose: () => void;
  now: number;
}) {
  const [tab, setTab] = useState<TabKey>(focusSpan ? "spans" : "detail");
  const spanSet = useMemo(() => new Set(node?.allSpans ?? []), [node]);
  const nodeEvents = useMemo(() => events.filter((e) => e.span_id && spanSet.has(e.span_id)), [events, spanSet]);
  if (!node) return null;
  const seal = statusSeal(node);
  const d = nodeDuration(node, now);
  return (
    <Drawer
      open
      onClose={onClose}
      width={720}
      title={
        <span className="row" style={{ gap: 12 }}>
          <Seal text={seal.text} tone={seal.tone} size={34} stamp />
          <span className="col" style={{ gap: 0 }}>
            <span className="small muted serif">{node.label}</span>
            <span className="ellipsis" style={{ maxWidth: 520 }}>
              {node.title}
            </span>
          </span>
        </span>
      }
    >
      <dl className="kv dd-meta">
        <dt>经手</dt>
        <dd>{node.actor ? <Addr a={node.actor} /> : node.dept ? (DEPT_NAMES[node.dept] ?? node.dept) : "—"}</dd>
        <dt>状态</dt>
        <dd>
          <Tag tone={seal.tone === "ink" ? "" : seal.tone}>{STATUS_LABEL[node.status]}</Tag>
        </dd>
        <dt>起讫</dt>
        <dd>
          {fmtDateTime(node.started_at)} → {node.ended_at ? fmtTime(node.ended_at) : "进行中"}　<span className="muted">({fmtDuration(d)})</span>
        </dd>
        <dt>用量</dt>
        <dd className="num">
          {fmtTokens(node.tokens)} tokens · {fmtCost(node.cost)} · {node.calls} 次调用
        </dd>
      </dl>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "detail", label: "公文" },
          { key: "spans", label: "执行树", count: node.allSpans.length },
          { key: "events", label: "事件", count: nodeEvents.length },
        ]}
      />
      {tab === "detail" && <KindDetail node={node} detail={detail} g={g} />}
      {tab === "spans" && <SpanTree g={g} node={node} focus={focusSpan} now={now} />}
      {tab === "events" && <EventList events={nodeEvents} />}
    </Drawer>
  );
}

// ───────── 按类别的公文详情 ─────────
function KindDetail({ node, detail, g }: { node: MacroNode; detail: EdictDetail | undefined; g: MacroGraph }) {
  switch (node.kind) {
    case "edict":
      return <EdictPart detail={detail} />;
    case "draft":
      return <DraftPart node={node} detail={detail} />;
    case "review":
      return <ReviewPart node={node} detail={detail} />;
    case "task":
      return node.ref.task_id ? <TaskPart taskId={node.ref.task_id} /> : <SpanAttrs g={g} node={node} />;
    case "service":
      return node.ref.request_id ? <ServicePart id={node.ref.request_id} /> : <SpanAttrs g={g} node={node} />;
    case "deliberation":
      return (
        <div className="stack">
          <p className="serif">政事堂议事，结论奏请陛下定夺后颁旨。</p>
          <Link className="btn sm" to={`/council${node.ref.deliberation_id ? `?id=${node.ref.deliberation_id}` : ""}`}>
            入议事厅观其始末 →
          </Link>
        </div>
      );
    case "report":
      return detail?.edict.report ? (
        <div className="stack">
          <Section title="复奏">
            <p className="prose">{detail.edict.report.summary}</p>
          </Section>
          {detail.edict.report.failures && (
            <Section title="未竟之事">
              <p className="prose">{detail.edict.report.failures}</p>
            </Section>
          )}
          <div className="muted small">
            <Addr a={detail.edict.report.by} /> · {fmtDateTime(detail.edict.report.at)}
          </div>
        </div>
      ) : (
        <Empty text="尚未复奏" />
      );
    case "dispatch":
      return (
        <div className="stack">
          <Section title="分派任务">
            {(detail?.tasks ?? []).filter((t) => !t.parent_id).length === 0 ? (
              <Empty text="尚未分派" />
            ) : (
              <table className="tbl">
                <tbody>
                  {(detail?.tasks ?? [])
                    .filter((t) => !t.parent_id)
                    .map((t) => (
                      <tr key={t.id}>
                        <td>{DEPT_NAMES[t.dept] ?? t.dept}</td>
                        <td>{t.title}</td>
                        <td>
                          <TaskStateTag state={t.state} />
                        </td>
                        <td>{t.assignee_post ? <Addr a={`post:${t.assignee_post}`} /> : <span className="muted">待派</span>}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Section>
          <SpanAttrs g={g} node={node} />
        </div>
      );
    default:
      return <SpanAttrs g={g} node={node} />;
  }
}

function Section({ title, children, extra }: { title: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="dd-sec">
      <h3 className="dd-sec-title">
        {title}
        {extra && <span className="dd-sec-extra">{extra}</span>}
      </h3>
      {children}
    </section>
  );
}

function EdictPart({ detail }: { detail: EdictDetail | undefined }) {
  if (!detail) return <Empty text="诏令详情暂不可得（仅有追踪）" />;
  const e = detail.edict;
  return (
    <div className="stack">
      <Section title="圣意">
        <blockquote className="dd-intent">{e.intent}</blockquote>
      </Section>
      <Section title="流转">
        <ol className="dd-transitions">
          {detail.transitions.map((t) => (
            <li key={t.id}>
              <span className="mono small muted">{fmtTime(t.at)}</span>
              <span className={`tag ${t.to_state === "drafting" && t.from_state === "reviewing" ? "red" : ""}`}>
                {t.from_state || "∅"} → {t.to_state}
              </span>
              <Addr a={t.actor} />
              <span className="muted">{t.reason}</span>
            </li>
          ))}
          {detail.transitions.length === 0 && <li className="muted">无流转记录</li>}
        </ol>
      </Section>
    </div>
  );
}

function DraftPart({ node, detail }: { node: MacroNode; detail: EdictDetail | undefined }) {
  const no = node.ref.draft_no ?? 0;
  const drafts = [...(detail?.drafts ?? [])].sort((a, b) => a.no - b.no);
  const d = drafts.find((x) => x.no === no);
  const prev = drafts.filter((x) => x.no < no).at(-1);
  const [view, setView] = useState<"text" | "diff">(prev ? "diff" : "text");
  if (!d) return <Empty text="草稿尚未呈上" seal="草" />;
  const allIssues = (detail?.reviews ?? []).flatMap((r) => r.issues.map((i) => ({ ...i, draft_no: r.draft_no })));
  return (
    <div className="stack">
      <dl className="kv">
        <dt>目标</dt>
        <dd>{d.objective || "—"}</dd>
        <dt>约束</dt>
        <dd>{d.constraints || "—"}</dd>
        <dt>验收</dt>
        <dd className={d.acceptance ? "" : "dd-missing"}>{d.acceptance || "（缺）"}</dd>
        <dt>期限</dt>
        <dd>{d.deadline_text || "—"}</dd>
        <dt>预算</dt>
        <dd className="num">{d.budget_tokens ? `${fmtTokens(d.budget_tokens)} tokens` : "—"}</dd>
        <dt>承办</dt>
        <dd>{d.suggested_depts.map((x) => DEPT_NAMES[x] ?? x).join("、") || "—"}</dd>
        <dt>执笔</dt>
        <dd>
          <Addr a={`post:${d.author_post}`} />
          {d.countersigned_by && (
            <>
              　复署 <Addr a={`post:${d.countersigned_by}`} />
            </>
          )}
        </dd>
      </dl>
      {d.responses.length > 0 && (
        <Section title="逐条回应封驳">
          <ul className="dd-responses">
            {d.responses.map((r) => {
              const iss = allIssues.find((i) => i.id === r.issue_id);
              return (
                <li key={r.issue_id}>
                  <div className="small">
                    {iss ? (
                      <>
                        <Tag tone={iss.severity === "blocking" ? "red" : "gold"}>{iss.severity === "blocking" ? "必改" : "建议"}</Tag> {iss.reason} · {iss.clause}
                        <span className="muted">（v{iss.draft_no}：{iss.required_change}）</span>
                      </>
                    ) : (
                      <span className="mono muted">{r.issue_id}</span>
                    )}
                  </div>
                  <div className="serif">↳ {r.response}</div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      <Section
        title={`诏书正文 · v${d.no}`}
        extra={
          prev && (
            <span className="seg">
              <button className={view === "text" ? "active" : ""} onClick={() => setView("text")}>
                正文
              </button>
              <button className={view === "diff" ? "active" : ""} onClick={() => setView("diff")}>
                较 v{prev.no}
              </button>
            </span>
          )
        }
      >
        {view === "diff" && prev ? <DiffView before={prev.text} after={d.text} labels={[`v${prev.no}`, `v${d.no}`]} /> : <pre className="dd-edict-text">{d.text}</pre>}
      </Section>
    </div>
  );
}

function ReviewPart({ node, detail }: { node: MacroNode; detail: EdictDetail | undefined }) {
  const r = (detail?.reviews ?? []).find((x) => x.id === node.ref.review_id);
  if (!r) return <Empty text={node.status === "running" ? "门下审核中" : "无审核记录"} seal="审" />;
  const nextDraft = (detail?.drafts ?? []).find((x) => x.no === r.draft_no + 1);
  return (
    <div className="stack">
      <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
        <Seal text={r.decision === "approve" ? "准" : "驳"} tone={r.decision === "approve" ? "jade" : "red"} size={52} solid={r.decision === "reject"} />
        <div className="grow">
          <div className="serif dd-opinion">{r.opinion || "（无批语）"}</div>
          <div className="muted small">
            <Addr a={`post:${r.reviewer_post}`} /> · 审草稿 v{r.draft_no} · {fmtDateTime(r.created_at)}
          </div>
        </div>
      </div>
      {r.issues.length > 0 && (
        <Section title={`封驳条目（${r.issues.length}）`}>
          <table className="tbl">
            <thead>
              <tr>
                <th>轻重</th>
                <th>条款</th>
                <th>事由</th>
                <th>须改</th>
                <th>回应</th>
              </tr>
            </thead>
            <tbody>
              {r.issues.map((i) => {
                const resp = nextDraft?.responses.find((x) => x.issue_id === i.id);
                return (
                  <tr key={i.id}>
                    <td>
                      <Tag tone={i.severity === "blocking" ? "red" : "gold"}>{i.severity === "blocking" ? "必改" : "建议"}</Tag>
                    </td>
                    <td className="serif">{i.clause}</td>
                    <td>{i.reason}</td>
                    <td className="serif">{i.required_change}</td>
                    <td className="serif">{resp ? <span className="dd-resp">v{nextDraft!.no}：{resp.response}</span> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

function TaskPart({ taskId }: { taskId: string }) {
  const q = useQuery(() => hub.task(taskId), [taskId], { watch: (e) => e.subject_id === taskId || e.type.startsWith("task.") });
  return (
    <QueryView q={q} isEmpty={() => false}>
      {({ task: t, comments, children, transitions }) => (
        <div className="stack">
          <div className="row wrap">
            <TaskStateTag state={t.state} />
            <span>{DEPT_NAMES[t.dept] ?? t.dept}</span>
            {t.assignee_post && (
              <>
                · 承办 <Addr a={`post:${t.assignee_post}`} />
              </>
            )}
            <span className="muted small">
              · 核验：{t.verify_by === "self" ? "自验" : t.verify_by === "superior" ? "长官" : "刑部"}
            </span>
            {t.deadline && (
              <span className="muted small">
                · 限 <TimeAgo ms={t.deadline} />
              </span>
            )}
          </div>
          {t.block_reason && t.state === "blocked" && (
            <div className="err-box">
              <Seal text="阻" tone="red" size={22} />
              <div>{t.block_reason}</div>
            </div>
          )}
          <dl className="kv">
            <dt>指示</dt>
            <dd className="serif">{t.instructions || "—"}</dd>
            <dt>验收</dt>
            <dd className="serif">{t.acceptance || "—"}</dd>
            <dt>退回/改派</dt>
            <dd className="num">
              {t.return_count} / {t.reassign_count}
            </dd>
          </dl>
          {t.result && (
            <Section title="交付">
              <p className="prose">{t.result}</p>
              {t.result_assets.length > 0 && (
                <div className="row wrap">
                  {t.result_assets.map((a) => (
                    <Link key={a} className="tag azure" to={`/assets?id=${a}`}>
                      藏 {a}
                    </Link>
                  ))}
                </div>
              )}
            </Section>
          )}
          {children.length > 0 && (
            <Section title="子任务">
              <ul className="dd-list">
                {children.map((c) => (
                  <li key={c.id}>
                    <TaskStateTag state={c.state} /> {c.title} {c.assignee_post && <Addr a={`post:${c.assignee_post}`} />}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {comments.length > 0 && (
            <Section title="批注">
              <ul className="dd-list">
                {comments.map((c) => (
                  <li key={c.id}>
                    <Addr a={c.author} />：<span className="serif">{c.content}</span> <span className="muted small">{fmtTime(c.created_at)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {transitions.length > 0 && (
            <Section title="流转">
              <ol className="dd-transitions">
                {transitions.map((x) => (
                  <li key={x.id}>
                    <span className="mono small muted">{fmtTime(x.at)}</span>
                    <span className="tag">
                      {x.from_state} → {x.to_state}
                    </span>
                    <Addr a={x.actor} /> <span className="muted">{x.reason}</span>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </div>
      )}
    </QueryView>
  );
}

function ServicePart({ id }: { id: string }) {
  const q = useQuery(() => hub.serviceRequest(id), [id], { watch: (e) => e.type.startsWith("service.") });
  return (
    <QueryView q={q} isEmpty={() => false}>
      {(s) => (
        <div className="stack">
          <dl className="kv">
            <dt>服务</dt>
            <dd className="mono">{s.service}</dd>
            <dt>请求方</dt>
            <dd>
              <Addr a={s.caller} />
            </dd>
            <dt>受理</dt>
            <dd>
              <Addr a={s.target} /> {s.routed_to && <>→ <Addr a={`post:${s.routed_to}`} /></>}
            </dd>
            <dt>状态</dt>
            <dd>
              <Tag tone={s.state === "done" ? "jade" : s.state === "pending" ? "azure" : "red"}>{s.state}</Tag>
            </dd>
            <dt>时限</dt>
            <dd>{fmtDateTime(s.sla_at)}</dd>
          </dl>
          <Section title="输入">
            <JsonView value={s.input} maxHeight={200} />
          </Section>
          {s.output && (
            <Section title="回执">
              <p className="prose">{s.output}</p>
            </Section>
          )}
        </div>
      )}
    </QueryView>
  );
}

function SpanAttrs({ g, node }: { g: MacroGraph; node: MacroNode }) {
  const s = node.spanIds.map((id) => g.spanById.get(id)).find(Boolean);
  if (!s?.attrs || Object.keys(s.attrs).length === 0) return <div className="muted small">无更多属性</div>;
  return (
    <Section title="属性">
      <JsonView value={s.attrs} maxHeight={260} />
    </Section>
  );
}

// ───────── span 树 ─────────
function SpanTree({ g, node, focus, now }: { g: MacroGraph; node: MacroNode; focus?: string; now: number }) {
  const { roots, children } = useMemo(() => {
    const set = new Set(node.allSpans);
    const ch = new Map<string, Span[]>();
    const roots: Span[] = [];
    for (const id of node.allSpans) {
      const s = g.spanById.get(id);
      if (!s) continue;
      if (s.parent_span_id && set.has(s.parent_span_id)) {
        const arr = ch.get(s.parent_span_id) ?? [];
        arr.push(s);
        ch.set(s.parent_span_id, arr);
      } else roots.push(s);
    }
    const sort = (a: Span, b: Span) => a.started_at - b.started_at;
    roots.sort(sort);
    for (const v of ch.values()) v.sort(sort);
    return { roots, children: ch };
  }, [g, node]);
  if (roots.length === 0) return <Empty text="无执行记录" />;
  const render = (s: Span, depth: number): ReactNode => {
    const st = SPAN_STATUS[s.status] ?? { label: s.status, tone: "" };
    const tid = (s.attrs?.turn_id as string) ?? s.span_id;
    const u = s.kind === "turn" ? g.turnUsage.get(tid) : undefined;
    const kids = children.get(s.span_id) ?? [];
    return (
      <li key={s.span_id}>
        <div className={`st-row k-${s.kind} ${focus === s.span_id ? "focus" : ""} ${s.status === "error" ? "err" : ""}`} style={{ paddingLeft: depth * 16 + 6 }}>
          <span className={`st-kind k-${s.kind}`}>{SPAN_KIND[s.kind] ?? s.kind}</span>
          <span className="st-name ellipsis">{s.name}</span>
          <span className="st-actor ellipsis">
            <Addr a={s.actor} />
          </span>
          <span className="st-time mono">{fmtTime(s.started_at)}</span>
          <span className="st-dur mono">{fmtDuration((s.ended_at ?? now) - s.started_at)}</span>
          <span className="st-tok mono">{u ? fmtTokens(u.tokens) : ""}</span>
          <Tag tone={st.tone}>{st.label}</Tag>
        </div>
        {s.status === "error" && s.attrs?.error !== undefined && <div className="st-err" style={{ paddingLeft: depth * 16 + 28 }}>{String(s.attrs.error)}</div>}
        {kids.length > 0 && <ul>{kids.map((k) => render(k, depth + 1))}</ul>}
      </li>
    );
  };
  return <ul className="span-tree">{roots.map((s) => render(s, 0))}</ul>;
}

export function EventList({ events, onPick }: { events: CourtEvent[]; onPick?: (e: CourtEvent) => void }) {
  if (events.length === 0) return <Empty text="无事件" seal="寂" />;
  return (
    <ol className="ev-list">
      {[...events]
        .sort((a, b) => b.ts - a.ts)
        .map((e) => (
          <li key={e.id} className={`${isErrorEvent(e) ? "err" : ""} ${onPick ? "clickable" : ""}`} onClick={() => onPick?.(e)}>
            <span className="mono small muted">{fmtTime(e.ts)}</span>
            <span className={`tag ev-type t-${e.type.split(".")[0]}`} title={e.type}>{e.type}</span>
            <span className="ev-actor">
              <Addr a={e.actor} />
            </span>
            <span className="ev-sum">{e.summary}</span>
          </li>
        ))}
    </ol>
  );
}
