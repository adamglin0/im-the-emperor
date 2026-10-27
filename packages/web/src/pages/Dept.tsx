// 部门页：官员、任务看板、文书、服务、资产、定时、用量、递公文
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { DeptId, Message, Schedule, ServiceDef } from "@court/shared/types";
import "../styles/pages/court.css";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr } from "../components/Addr.tsx";
import { Card } from "../components/Card.tsx";
import { BarList } from "../components/charts.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { useStatuses } from "../hooks/useStatuses.ts";
import { fmtTokens, startOfTodayShanghai } from "../lib/format.ts";
import { DEPT_GROUP, DEPT_SEAL } from "../lib/labels.ts";
import { AssetBrowser, HourlyTokens, MessageList, OfficialCard, ScheduleTable, TaskBoard, TaskDrawer, statusForPost } from "./court/shared.tsx";

export default function DeptPage() {
  const { id = "" } = useParams();
  const r = useRegistry();
  const dept = r.dept(id);
  const posts = r.postsOfDept(id);
  const postIds = posts.map((p) => p.post_id);
  const postKey = postIds.join(",");
  const [openTask, setOpenTask] = useState<string | null>(null);

  const statuses = useStatuses(15_000);
  const ov = useQuery(() => hub.overview(), [], { interval: 30_000 });
  const tasks = useQuery(() => hub.tasks({ dept: id as DeptId, limit: 200 }), [id], { watch: ["task.", "edict.dispatched"] });
  const msgs = useQuery(
    async () => {
      const lists = await Promise.all(postIds.map((p) => hub.searchMessages({ post: p, limit: 40 })));
      const seen = new Map<string, Message>();
      for (const m of lists.flat()) seen.set(m.id, m);
      return [...seen.values()].sort((a, b) => b.created_at - a.created_at);
    },
    [postKey],
    { watch: ["message."], enabled: postIds.length > 0 },
  );
  const assets = useQuery(() => hub.assets({ viewer: "emperor", owner: `dept:${id}` }), [id], { watch: ["asset."] });
  const schedules = useQuery(
    async () => {
      const lists = await Promise.all([hub.schedules({ owner: `dept:${id}` }), ...postIds.map((p) => hub.schedules({ owner: `post:${p}` }))]);
      const seen = new Map<string, Schedule>();
      for (const s of lists.flat()) seen.set(s.id, s);
      return [...seen.values()];
    },
    [id, postKey],
    { watch: ["schedule."] },
  );
  const today = startOfTodayShanghai();
  const usageByPost = useQuery(() => hub.ledgerSummary({ group: "post", filter_scope: `dept:${id}`, since: today }), [id, today], { watch: ["llm.", "ledger."], interval: 60_000 });
  const usageByHour = useQuery(() => hub.ledgerSummary({ group: "hour", filter_scope: `dept:${id}`, since: Date.now() - 24 * 3_600_000 }), [id], { watch: ["llm.", "ledger."], interval: 60_000 });

  const services = useMemo(() => {
    const out: { svc: ServiceDef; owner: string }[] = [];
    for (const s of dept?.services ?? []) out.push({ svc: s, owner: `dept:${id}` });
    for (const p of posts) for (const s of p.services ?? []) out.push({ svc: s, owner: `post:${p.post_id}` });
    return out;
  }, [dept, posts, id]);

  if (r.loading && !r.registry) return <div className="page"><Loading /></div>;
  if (!dept) {
    return (
      <div className="page">
        {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : <Empty text={`无此部门：${id}`} seal="迷"><Link to="/court">回朝堂</Link></Empty>}
      </div>
    );
  }

  const health = ov.data?.depts_health?.[id];
  const tokToday = (usageByPost.data ?? []).reduce((s, x) => s + x.total_tokens, 0);
  const openTasks = (tasks.data ?? []).filter((t) => !["done", "cancelled", "failed"].includes(t.state)).length;
  const vacant = posts.filter((p) => !r.officialOf(p.post_id)).length;

  return (
    <div className="page">
      <div className="dept-hero">
        <Seal text={DEPT_SEAL[id] ?? dept.name[0]} tone="red" size={64} solid rotate={-6} />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <h1>{dept.name}</h1>
            <Tag>{DEPT_GROUP[id] ?? ""}</Tag>
            <span className={`health ${health ? (health.ok ? "ok" : "bad") : ""}`}>{health ? (health.ok ? "署衙安" : "署衙失联") : "健康未知"}</span>
          </div>
          <div className="hero-brief">{dept.brief}</div>
          <details>
            <summary>部门职掌</summary>
            <div className="duties">{dept.duties}</div>
          </details>
        </div>
        <div className="hero-stats">
          <div>
            <div className="k">员额</div>
            <div className="v">
              {posts.length - vacant}/{posts.length}
            </div>
          </div>
          <div>
            <div className="k">未结任务</div>
            <div className="v">{openTasks}</div>
          </div>
          <div>
            <div className="k">今日俸禄</div>
            <div className="v">{fmtTokens(tokToday)}</div>
          </div>
          <div>
            <div className="k">服务</div>
            <div className="v">{services.length}</div>
          </div>
        </div>
      </div>

      <div className="stack">
        <Card title="本署官员" sub={`${posts.length} 职`}>
          {posts.length === 0 ? (
            <Empty text="本署无职位" />
          ) : (
            <div className="officials-grid">
              {posts.map((p) => (
                <OfficialCard key={p.post_id} post={p} status={statusForPost(p, statuses.data, !!r.officialOf(p.post_id))} />
              ))}
            </div>
          )}
        </Card>

        <Card title="任务看板" sub={`未结 ${openTasks} 件`} actions={<button className="btn sm ghost" onClick={tasks.reload}>刷新</button>}>
          <QueryView q={tasks} empty={<Empty text="本署暂无任务" seal="闲" />}>
            {(ts) => <TaskBoard tasks={ts} onOpen={setOpenTask} />}
          </QueryView>
        </Card>

        <div className="grid g2" style={{ alignItems: "start" }}>
          <Card title="往来文书" sub="本署官员收发（近况）">
            <QueryView q={msgs} empty={<Empty text="尚无文书往来" seal="牍" />}>
              {(ms) => <MessageList messages={ms} self={[`dept:${id}`, ...postIds.map((p) => `post:${p}`)]} limit={30} />}
            </QueryView>
          </Card>
          <div className="stack">
            <OralForm deptId={id} deptName={dept.name} />
            <Card title="服务" sub="可被他署调用的能力">
              {services.length === 0 ? (
                <Empty text="本署未设服务" />
              ) : (
                services.map(({ svc, owner }) => (
                  <div key={`${owner}:${svc.name}`} className="svc-row">
                    <div className="row">
                      <span className="svc-name">{svc.name}</span>
                      <span className="muted small">
                        SLA {Math.round(svc.sla_seconds / 60)} 分
                      </span>
                      <span className="grow" />
                      <span className="small">
                        <Addr a={owner} />
                      </span>
                    </div>
                    <div className="serif small">{svc.description}</div>
                    {svc.route_roles && svc.route_roles.length > 0 && <div className="muted small">路由角色：{svc.route_roles.join("、")}</div>}
                  </div>
                ))
              )}
            </Card>
          </div>
        </div>

        <div className="grid g2" style={{ alignItems: "start" }}>
          <Card title="今日用量" sub="按官员">
            <QueryView q={usageByPost} empty={<Empty text="今日尚无用量" seal="俸" />}>
              {(rows) => (
                <BarList
                  data={rows.map((x) => ({ key: x.key, label: r.postLabel(x.key), value: x.total_tokens, tip: <>{r.postLabel(x.key)}：{fmtTokens(x.total_tokens)} tokens · {x.calls} 次</> }))}
                  format={fmtTokens}
                />
              )}
            </QueryView>
          </Card>
          <Card title="近一日" sub="每时辰 tokens">
            <QueryView q={usageByHour} empty={<Empty text="近一日无用量" seal="俸" />}>
              {(rows) => <HourlyTokens rows={rows} />}
            </QueryView>
          </Card>
        </div>

        <Card title="部门资产" sub="部门私有 + 公开" actions={<Link to="/assets" className="small">资产库 ⇢</Link>}>
          <QueryView q={assets} empty={<Empty text="本署尚无资产" seal="藏" />}>
            {(as) => <AssetBrowser assets={as} />}
          </QueryView>
        </Card>

        <Card title="定时任务" sub="部门及本署官员" actions={<Link to="/schedules" className="small">司辰 ⇢</Link>}>
          <QueryView q={schedules} empty={<Empty text="无定时任务" seal="时" />}>
            {(ss) => <ScheduleTable schedules={ss} showOwner />}
          </QueryView>
        </Card>
      </div>

      <TaskDrawer id={openTask} onClose={() => setOpenTask(null)} />
    </div>
  );
}

function OralForm({ deptId, deptName }: { deptId: string; deptName: string }) {
  const [content, setContent] = useState("");
  const [reply, setReply] = useState(true);
  const { run, pending } = useAction();
  const submit = async () => {
    if (!content.trim()) return;
    const res = await run(() => hub.emperorOral({ to: `dept:${deptId}`, content: content.trim(), requires_reply: reply }), `口谕已递${deptName}`);
    if (res) setContent("");
  };
  return (
    <Card title="递公文" sub={`口谕直达${deptName}，由本署按路由分派`} memorial>
      <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder={`朕谕${deptName}：…`} rows={4} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()} />
      <div className="row" style={{ marginTop: 8 }}>
        <label className="small">
          <input type="checkbox" checked={reply} onChange={(e) => setReply(e.target.checked)} /> 须回奏
        </label>
        <span className="grow" />
        <button className="btn primary" disabled={pending || !content.trim()} onClick={submit}>
          {pending ? "递送中…" : "下口谕"}
        </button>
      </div>
    </Card>
  );
}
