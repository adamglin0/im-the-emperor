// 官员页：头牌、状态、操作（唤醒/压缩/私聊）与各分页
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Official } from "@court/shared/types";
import type { ConfigHistoryRow } from "@court/shared/api";
import "../styles/pages/court.css";
import { hub } from "../api/client.ts";
import { live } from "../api/live.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo, TraceLink } from "../components/Addr.tsx";
import { Card, Stat } from "../components/Card.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { useConfirm } from "../components/Overlay.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { OfficialStateTag, Tag, TaskStateTag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { useStatuses } from "../hooks/useStatuses.ts";
import { fmtDateTime, fmtTokens } from "../lib/format.ts";
import { AUDIT_RULE, DEPT_SEAL, OFFICIAL_STATE, THINKING_LABEL, TOOL_GROUP_LABEL } from "../lib/labels.ts";
import { ContextView, LiveStream, LogView } from "./court/live.tsx";
import { AssetBrowser, LedgerPanel, MessageList, ScheduleTable, StateLine, TaskDrawer, statusForPost } from "./court/shared.tsx";

type TabKey = "live" | "msgs" | "ctx" | "log" | "assets" | "tasks" | "sched" | "config" | "usage" | "audit";

export default function OfficialPage() {
  const { post = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as TabKey) || "live";
  const setTab = (k: TabKey) => setSp({ tab: k }, { replace: true });
  const r = useRegistry();
  const p = r.post(post);
  const o = r.officialOf(post);
  const statuses = useStatuses(10_000);
  const confirm = useConfirm();
  const { run, pending } = useAction();

  if (r.loading && !r.registry) return <div className="page"><Loading /></div>;
  if (!p) {
    return (
      <div className="page">
        {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : <Empty text={`无此职位：${post}`} seal="迷"><Link to="/court">回朝堂</Link></Empty>}
      </div>
    );
  }
  const s = statusForPost(p, statuses.data, !!o);
  const vacant = !o;
  const deptName = r.deptName(p.dept);

  const wake = async () => {
    if (await confirm({ title: `唤醒${p.title}${o ? ` ${o.name}` : ""}？`, body: "将打断其睡眠或等待，立即开始新一轮（会消耗 token）。", okText: "宣召" })) await run(() => live.wake(post, "皇帝宣召"), "已宣召");
  };
  const compact = async () => {
    if (await confirm({ title: "强制压缩上下文？", body: "官员将以摘要替换较早的对话，保留最近若干条；完整历史仍在日志中。", okText: "压缩" })) await run(() => live.compact(post), "已令其整理上下文");
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: "live", label: "实时" },
    { key: "msgs", label: "来往文书" },
    { key: "ctx", label: "上下文" },
    { key: "log", label: "起居注" },
    { key: "assets", label: "记忆与私产" },
    { key: "tasks", label: "名下任务" },
    { key: "sched", label: "定时" },
    { key: "config", label: "配置" },
    { key: "usage", label: "用量" },
    { key: "audit", label: "考课·弹劾" },
  ];

  return (
    <div className="page">
      <div className="off-hero">
        <Seal text={DEPT_SEAL[p.dept] ?? deptName[0]} tone="red" size={64} solid rotate={-6} title={deptName} />
        <div style={{ minWidth: 0 }}>
          <div className="off-title">
            <Link to={`/depts/${p.dept}`}>{deptName}</Link> · {p.title} · {p.rank}
            {p.benguan ? ` · 本官 ${p.benguan}` : ""}
          </div>
          <div className="off-name">{vacant ? "虚位以待" : o.name}</div>
          <div className="off-tags">
            <OfficialStateTag state={s.state} />
            {o && <Tag tone="azure" title="模型">{o.model}</Tag>}
            {o && <Tag title="思考强度">{THINKING_LABEL[o.thinking] ?? o.thinking}</Tag>}
            {o && <Tag title="配置版本">配置 v{o.config_version}</Tag>}
            {o && o.status !== "active" && <Tag tone="red">{o.status === "suspended" ? "停俸" : "罢免"}</Tag>}
            {p.approval_sensitive && <Tag tone="gold" title="改其配置/人事须皇帝批准">要职</Tag>}
            {p.activity === "on_demand" && <Tag>随召</Tag>}
            <span className="mono muted small">{post}</span>
          </div>
        </div>
        <div className="off-actions">
          <button className="btn primary" onClick={wake} disabled={vacant || pending}>
            宣召（唤醒）
          </button>
          <button className="btn" onClick={compact} disabled={vacant || pending}>
            令其整理上下文
          </button>
          <Link className="btn gold" to={`/decree?chat=${encodeURIComponent(post)}`}>
            私聊
          </Link>
        </div>
      </div>

      {vacant ? (
        <Card>
          <Empty text="此职空缺，尚无官员任职。" seal="缺">
            <Link to="/libu" className="btn sm">
              往吏部铨选
            </Link>
          </Empty>
          <div className="serif small muted" style={{ marginTop: 8 }}>
            职掌：{p.duties}
          </div>
        </Card>
      ) : (
        <>
          <div className="off-status">
            <Stat label="此刻" value={<span style={{ fontSize: 15, fontFamily: "var(--font-serif)" }}>{s.status_text ?? (s.state === "waiting" || s.state === "sleeping" ? <StateLine s={s} /> : OFFICIAL_STATE[s.state].label)}</span>} sub={(s.state === "waiting" || s.state === "sleeping") && s.status_text ? <StateLine s={s} /> : undefined} />
            <Stat label="今日俸禄" value={fmtTokens(s.tokens_today)} unit="tokens" tone="red" />
            <Stat label="近一时辰轮次" value={s.turns_last_hour} tone="azure" />
            <Stat label="上下文" value={s.context_tokens ? fmtTokens(s.context_tokens) : "—"} unit="tokens" />
            <Stat
              label="当前公务"
              value={<span style={{ fontSize: 14 }}>{s.current_trace_id ? <TraceLink id={s.current_trace_id} /> : <span className="muted">—</span>}</span>}
              sub={<>最近进展 <TimeAgo ms={s.last_progress_at} /></>}
              tone="jade"
            />
          </div>

          <Tabs tabs={tabs} value={tab} onChange={setTab} />
          <div>
            {tab === "live" && <LiveStream post={post} />}
            {tab === "msgs" && <MessagesTab post={post} />}
            {tab === "ctx" && <ContextView post={post} modelKey={o.model} />}
            {tab === "log" && <LogView post={post} />}
            {tab === "assets" && <AssetsTab post={post} />}
            {tab === "tasks" && <TasksTab post={post} />}
            {tab === "sched" && <SchedTab post={post} />}
            {tab === "config" && <ConfigTab post={post} />}
            {tab === "usage" && <UsageTab post={post} />}
            {tab === "audit" && <AuditTab post={post} />}
          </div>
          <div className="serif small muted" style={{ marginTop: 18 }}>
            职掌：{p.duties}
          </div>
        </>
      )}
    </div>
  );
}

function MessagesTab({ post }: { post: string }) {
  const q = useQuery(() => hub.searchMessages({ post, limit: 200 }), [post], { watch: ["message."] });
  const [dir, setDir] = useState<"all" | "in" | "out">("all");
  const me = `post:${post}`;
  return (
    <Card
      title="来往文书"
      actions={
        <div className="seg">
          {(["all", "in", "out"] as const).map((k) => (
            <button key={k} className={dir === k ? "active" : ""} onClick={() => setDir(k)}>
              {{ all: "全部", in: "收", out: "发" }[k]}
            </button>
          ))}
        </div>
      }
    >
      <QueryView q={q} empty={<Empty text="尚无文书往来" seal="牍" />}>
        {(ms) => <MessageList messages={ms.filter((m) => dir === "all" || (dir === "out" ? m.from === me : m.from !== me))} self={[me]} limit={200} />}
      </QueryView>
    </Card>
  );
}

function AssetsTab({ post }: { post: string }) {
  const q = useQuery(() => hub.assets({ viewer: "emperor", owner: `post:${post}` }), [post], { watch: ["asset."] });
  return (
    <Card title="记忆与私产" sub="官员私有资产（仅本人与陛下可见）">
      <QueryView q={q} empty={<Empty text="尚无私产，亦无 memory.md" seal="藏" />}>
        {(as) => <AssetBrowser assets={as} />}
      </QueryView>
    </Card>
  );
}

function TasksTab({ post }: { post: string }) {
  const q = useQuery(() => hub.tasks({ assignee: post, limit: 200 }), [post], { watch: ["task."] });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="名下任务">
      <QueryView q={q} empty={<Empty text="名下无任务" seal="闲" />}>
        {(ts) => (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>任务</th>
                  <th>诏令</th>
                  <th>期限</th>
                  <th>更新</th>
                </tr>
              </thead>
              <tbody>
                {[...ts]
                  .sort((a, b) => b.updated_at - a.updated_at)
                  .map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => setOpen(t.id)}>
                      <td>
                        <TaskStateTag state={t.state} />
                      </td>
                      <td>
                        <div className="serif">
                          {t.parent_id && <span className="muted">↳ </span>}
                          {t.title}
                        </div>
                        {t.block_reason && t.state === "blocked" && <div className="small" style={{ color: "var(--bad)" }}>阻：{t.block_reason}</div>}
                      </td>
                      <td>{t.edict_id ? <TraceLink id={t.edict_id} /> : "—"}</td>
                      <td className="small">{fmtDateTime(t.deadline)}</td>
                      <td className="small">
                        <TimeAgo ms={t.updated_at} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
      <TaskDrawer id={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

function SchedTab({ post }: { post: string }) {
  const q = useQuery(() => hub.schedules({ owner: `post:${post}` }), [post], { watch: ["schedule."] });
  return (
    <Card title="定时任务" actions={<Link to="/schedules" className="small">司辰 ⇢</Link>}>
      <QueryView q={q} empty={<Empty text="无定时任务" seal="时" />}>
        {(ss) => <ScheduleTable schedules={ss} />}
      </QueryView>
    </Card>
  );
}

function configText(o: Official): string {
  return [
    `模型：${o.model}`,
    `思考：${THINKING_LABEL[o.thinking] ?? o.thinking}（${o.thinking}）`,
    `加授工具组：${o.extra_tool_groups.join("、") || "（无）"}`,
    `禁用工具组：${o.disabled_tool_groups.join("、") || "（无）"}`,
    `状态：${o.status}`,
    "—— 个人提示词 ——",
    o.prompt_overrides || "（无）",
  ].join("\n");
}

function ConfigTab({ post }: { post: string }) {
  const cfg = useQuery(() => hub.officialConfig(post), [post], { watch: ["config."] });
  const hist = useQuery(() => hub.configHistory(post), [post], { watch: ["config."] });
  const [showPrompt, setShowPrompt] = useState(false);
  const versions = useMemo(() => [...(hist.data ?? [])].sort((a, b) => b.version - a.version), [hist.data]);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const newer: ConfigHistoryRow | undefined = versions.find((v) => v.version === b) ?? versions[0];
  const older: ConfigHistoryRow | undefined = versions.find((v) => v.version === a) ?? versions.find((v) => v.version < (newer?.version ?? 0));
  return (
    <div className="stack">
      <Card title="现行配置" actions={<Link to={`/libu?post=${post}`} className="small">吏部改制 ⇢</Link>}>
        <QueryView q={cfg}>
          {(c) => (
            <div className="stack">
              <dl className="kv">
                <dt>模型</dt>
                <dd className="mono">{c.official.model}</dd>
                <dt>思考</dt>
                <dd>{THINKING_LABEL[c.official.thinking] ?? c.official.thinking}</dd>
                <dt>有效工具组</dt>
                <dd className="row wrap" style={{ gap: 4 }}>
                  {c.effective_tool_groups.map((g) => (
                    <Tag key={g} tone={c.official.extra_tool_groups.includes(g) ? "gold" : c.post.tool_groups.includes(g) ? "azure" : ""} title={g}>
                      {TOOL_GROUP_LABEL[g] ?? g}
                    </Tag>
                  ))}
                  {c.official.disabled_tool_groups.map((g) => (
                    <Tag key={g} outline title="已禁用">
                      <s>{TOOL_GROUP_LABEL[g] ?? g}</s>
                    </Tag>
                  ))}
                </dd>
                <dt>个人提示词</dt>
                <dd className="serif" style={{ whiteSpace: "pre-wrap" }}>
                  {c.official.prompt_overrides || <span className="muted">（无）</span>}
                </dd>
                <dt>可打断睡眠</dt>
                <dd>{c.post.interruptible_by.join("、")}</dd>
                <dt>默认等待</dt>
                <dd>{Math.round(c.post.default_wait_seconds / 60)} 分</dd>
              </dl>
              <div>
                <button className="btn sm" onClick={() => setShowPrompt(!showPrompt)}>
                  {showPrompt ? "收起" : "展开"}完整系统提示
                </button>
                {showPrompt && <pre className="code-block" style={{ marginTop: 8 }}>{c.system_prompt}</pre>}
              </div>
            </div>
          )}
        </QueryView>
      </Card>
      <Card title="改制沿革" sub="配置历史与差异">
        <QueryView q={hist} empty={<Empty text="尚无配置历史" seal="制" />}>
          {() => (
            <div className="stack">
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>版本</th>
                      <th>改动者</th>
                      <th>事由</th>
                      <th>时间</th>
                      <th>对比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id} className={v.version === newer?.version || v.version === older?.version ? "selected" : ""}>
                        <td className="mono">v{v.version}</td>
                        <td>
                          <Addr a={v.actor} />
                        </td>
                        <td className="serif">{v.reason}</td>
                        <td className="small">{fmtDateTime(v.at)}</td>
                        <td>
                          <div className="btn-row">
                            <button className="btn sm" onClick={() => setA(v.version)} disabled={v.version === older?.version}>
                              旧
                            </button>
                            <button className="btn sm" onClick={() => setB(v.version)} disabled={v.version === newer?.version}>
                              新
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {newer && older ? (
                <DiffView before={configText(older.snapshot)} after={configText(newer.snapshot)} labels={[`v${older.version}`, `v${newer.version}`]} />
              ) : (
                <div className="muted small">仅一版，无可对比。</div>
              )}
            </div>
          )}
        </QueryView>
      </Card>
    </div>
  );
}

function UsageTab({ post }: { post: string }) {
  const q = useQuery(() => hub.ledger({ post, since: Date.now() - 24 * 3_600_000, limit: 5000 }), [post], { watch: ["llm.", "ledger."], interval: 60_000 });
  return (
    <Card title="用量" sub="近二十四时">
      <QueryView q={q} empty={<Empty text="近一日无用量" seal="俸" />}>
        {(es) => <LedgerPanel entries={es} />}
      </QueryView>
    </Card>
  );
}

function AuditTab({ post }: { post: string }) {
  const me = `post:${post}`;
  const f = useQuery(() => hub.auditFindings({ subject: me, limit: 100 }), [me], { watch: ["audit."] });
  const im = useQuery(() => hub.impeachments(), [], { watch: ["audit."] });
  const mine = (im.data ?? []).filter((x) => x.target === me);
  return (
    <div className="grid g2" style={{ alignItems: "start" }}>
      <Card title="稽查发现" actions={<Link to="/censor" className="small">御史台 ⇢</Link>}>
        <QueryView q={f} empty={<Empty text="未见稽查发现，考课清白" seal="清" />}>
          {(fs) => (
            <div className="col">
              {fs.map((x) => (
                <div key={x.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--rule)" }}>
                  <div className="row wrap">
                    <Tag tone={x.severity === "high" ? "red" : x.severity === "medium" ? "gold" : ""}>{AUDIT_RULE[x.rule] ?? x.rule}</Tag>
                    <Tag outline>{{ open: "待查", reviewed: "已核", impeached: "已劾", dismissed: "已驳" }[x.status]}</Tag>
                    <span className="grow" />
                    <span className="small muted">
                      <TimeAgo ms={x.created_at} />
                    </span>
                  </div>
                  <div className="serif" style={{ marginTop: 3 }}>
                    {x.summary}
                  </div>
                  {x.trace_id && (
                    <div className="small">
                      <TraceLink id={x.trace_id} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </QueryView>
      </Card>
      <Card title="弹劾记录">
        {im.initial ? (
          <Loading />
        ) : im.error && !im.data ? (
          <ErrorBox error={im.error} onRetry={im.reload} />
        ) : mine.length === 0 ? (
          <Empty text="未受弹劾" seal="清" />
        ) : (
          mine.map((x) => (
            <div key={x.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--rule)" }}>
              <div className="row wrap">
                <Seal text="劾" tone="red" size={22} />
                <span className="serif">{x.charges}</span>
                <span className="grow" />
                <Tag tone={x.status === "pending" ? "gold" : x.status === "dismissed" ? "" : "red"}>
                  {{ pending: "待圣裁", dismissed: "驳回", to_libu: "交吏部", to_hubu: "交户部", to_xingbu: "交刑部" }[x.status]}
                </Tag>
              </div>
              <div className="small muted">
                <Addr a={x.by} /> 劾 · <TimeAgo ms={x.created_at} />
              </div>
              <div className="small serif">{x.evidence}</div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
