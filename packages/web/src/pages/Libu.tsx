// 吏部铨选：名册（配置编辑）、配置史与待批、人事任免、空缺
import { Fragment, useMemo, useState } from "react";
import type { PersonnelReq } from "@court/shared/api";
import type { PostDef } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { useFitnessThreshold } from "../api/meta.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo } from "../components/Addr.tsx";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { useConfirm } from "../components/Overlay.tsx";
import { PostPicker } from "../components/PostPicker.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { DEPT_SEAL, MODEL_STATUS, THINKING_LABEL, TOOL_GROUP_LABEL } from "../lib/labels.ts";
import { ConfigDrawer } from "./offices/ConfigDrawer.tsx";
import "../styles/pages/offices.css";

type TabKey = "roster" | "config" | "personnel" | "vacancy";
type Action = PersonnelReq["action"];

const ACTIONS: { key: Action; label: string; hint: string }[] = [
  { key: "appoint", label: "任命", hint: "将某官员授某职" },
  { key: "transfer", label: "调岗", hint: "会话与记忆随人走，注入新职职掌" },
  { key: "dismiss", label: "罢免", hint: "官员离任，职位空缺" },
  { key: "set_model", label: "换模型", hint: "适配度低于门槛者须皇帝批（朕即批）" },
  { key: "new_official", label: "新授官员", hint: "为空缺职位新生成一位官员" },
];
const ACTION_LABEL: Record<string, string> = Object.fromEntries(ACTIONS.map((a) => [a.key, a.label]));

export interface PersonnelDraft {
  action: Action;
  official_id: string;
  post_id: string;
  model: string;
  name: string;
  reason: string;
}
const emptyDraft: PersonnelDraft = { action: "appoint", official_id: "", post_id: "", model: "", name: "", reason: "" };

export default function LibuPage() {
  const r = useRegistry();
  const [tab, setTab] = useState<TabKey>("roster");
  const [editPost, setEditPost] = useState<string | null>(null);
  const [draft, setDraft] = useState<PersonnelDraft>(emptyDraft);
  const vac = useQuery(() => hub.vacancies(), [], { watch: ["personnel.", "registry."] });
  const approvals = useQuery(() => hub.approvals("pending"), [], { watch: ["approval.", "notification.", "config."] });
  const pendingCfg = (approvals.data ?? []).filter((a) => a.type === "config_change" || a.type === "personnel" || a.type === "new_official");

  const officials = r.registry?.officials ?? [];
  const active = officials.filter((o) => o.status === "active").length;

  return (
    <div className="page">
      <PageHead
        title="吏部铨选"
        lede="掌文选、勋封、考课之政。百官之提示词、思考强度、工具授权皆出于此；敏感之职须陛下亲批。"
        actions={
          <button className="btn gold" onClick={() => setTab("personnel")}>
            人事任免
          </button>
        }
      />
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="职位" value={r.posts.length} unit="员" sub={`${r.depts.length} 部门`} />
        <Stat label="在任官员" value={active} unit="人" sub={`停俸 ${officials.filter((o) => o.status === "suspended").length}`} tone="jade" />
        <Stat label="空缺" value={vac.data?.length ?? "—"} unit="缺" tone={vac.data?.length ? "red" : undefined} />
        <Stat label="待批（配置/人事）" value={pendingCfg.length} unit="件" tone={pendingCfg.length ? "red" : undefined} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "roster", label: "名册" },
          { key: "config", label: "配置", count: pendingCfg.length },
          { key: "personnel", label: "人事" },
          { key: "vacancy", label: "空缺", count: vac.data?.length },
        ]}
      />
      {tab === "roster" && <Roster onEdit={setEditPost} />}
      {tab === "config" && <ConfigTab onEdit={setEditPost} pendingApprovals={pendingCfg} />}
      {tab === "personnel" && <PersonnelTab draft={draft} setDraft={setDraft} />}
      {tab === "vacancy" && (
        <QueryView q={vac} empty={<Empty text="百官齐备，并无空缺" seal="满" />}>
          {(list) => (
            <div className="grid auto" style={{ ["--min" as string]: "300px" }}>
              {list.map((p) => (
                <VacancyCard
                  key={p.post_id}
                  post={p}
                  onFill={() => {
                    setDraft({ ...emptyDraft, action: "new_official", post_id: p.post_id, reason: `补 ${p.title} 之缺` });
                    setTab("personnel");
                  }}
                />
              ))}
            </div>
          )}
        </QueryView>
      )}
      <ConfigDrawer post={editPost} onClose={() => setEditPost(null)} />
    </div>
  );
}

function Roster({ onEdit }: { onEdit: (post: string) => void }) {
  const r = useRegistry();
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  if (r.loading && !r.registry) return <Loading />;
  if (!r.registry) return <ErrorBox error={r.error ?? "名册未载入"} onRetry={r.reload} />;
  const k = q.trim().toLowerCase();
  const match = (p: PostDef) => {
    if (dept && p.dept !== dept) return false;
    if (!k) return true;
    const o = r.officialOf(p.post_id);
    return `${p.title}${p.post_id}${o?.name ?? ""}${o?.model ?? ""}${p.rank}`.toLowerCase().includes(k);
  };
  return (
    <Card flush>
      <div className="toolbar" style={{ padding: "10px 14px 0" }}>
        <input type="search" placeholder="搜职衔、姓名、模型…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        <select value={dept} onChange={(e) => setDept(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">全部部门</option>
          {r.depts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <span className="muted small">点击一行改配置 · <span className="sensitive-mark">敏</span> 改其配置须皇帝批准</span>
      </div>
      <div className="table-wrap">
        <table className="tbl roster">
          <thead>
            <tr>
              <th>职位</th>
              <th>官员</th>
              <th>品阶</th>
              <th>模型</th>
              <th>思考</th>
              <th>工具组</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {r.depts.map((d) => {
              const posts = r.postsOfDept(d.id).filter(match);
              if (!posts.length) return null;
              return (
                <Fragment key={d.id}>
                  <tr className="dept-row">
                    <td colSpan={7}>
                      <span className="row">
                        <Seal text={DEPT_SEAL[d.id] ?? d.name[0]} tone="red" size={24} />
                        <span className="dept-name">{d.name}</span>
                        <span className="muted small">{d.brief}</span>
                      </span>
                    </td>
                  </tr>
                  {posts.map((p) => {
                    const o = r.officialOf(p.post_id);
                    const defaults = new Set(p.tool_groups);
                    const extra = o?.extra_tool_groups ?? [];
                    const disabled = new Set(o?.disabled_tool_groups ?? []);
                    return (
                      <tr key={p.post_id} className={`clickable ${o ? "" : "vacant"}`} onClick={() => onEdit(p.post_id)}>
                        <td>
                          <span className="post-title">{p.title}</span>
                          {p.approval_sensitive && <span className="sensitive-mark" title="改其配置须皇帝批准">敏</span>}
                          {p.benguan && <div className="muted small">本官 {p.benguan}</div>}
                        </td>
                        <td className="official-name">{o ? o.name : <span className="muted">（空缺）</span>}</td>
                        <td className="small">{p.rank}</td>
                        <td className="mono small">{o?.model.split("/").pop() ?? "—"}</td>
                        <td>{o ? <Tag>{THINKING_LABEL[o.thinking] ?? o.thinking}</Tag> : "—"}</td>
                        <td>
                          <div className="grp-tags">
                            {[...defaults].map((g) => (
                              <span key={g} className={`tag ${disabled.has(g) ? "struck" : ""}`} title={disabled.has(g) ? "已禁用" : "职位默认"}>
                                {TOOL_GROUP_LABEL[g] ?? g}
                              </span>
                            ))}
                            {extra
                              .filter((g) => !defaults.has(g))
                              .map((g) => (
                                <span key={g} className="tag gold" title="额外授予">
                                  {TOOL_GROUP_LABEL[g] ?? g}
                                </span>
                              ))}
                          </div>
                        </td>
                        <td>
                          {!o ? (
                            <Tag>空缺</Tag>
                          ) : o.status === "active" ? (
                            <Tag tone="jade">在任</Tag>
                          ) : o.status === "suspended" ? (
                            <Tag tone="red">停俸</Tag>
                          ) : (
                            <Tag tone="ink">罢</Tag>
                          )}
                          <span className="muted small"> v{o?.config_version ?? "—"}</span>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ConfigTab({ onEdit, pendingApprovals }: { onEdit: (post: string) => void; pendingApprovals: import("@court/shared/types").Approval[] }) {
  const hist = useQuery(() => hub.configHistory(), [], { watch: ["config."] });
  return (
    <div className="grid g2" style={{ alignItems: "start" }}>
      <Card title="配置史" sub="全朝最近变更，点击查看 diff 与回滚">
        <QueryView q={hist} empty={<Empty text="尚无配置变更" seal="史" />}>
          {(rows) => (
            <div className="table-wrap" style={{ maxHeight: 560 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>职位</th>
                    <th>版本</th>
                    <th>经手</th>
                    <th>事由</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows]
                    .sort((a, b) => b.at - a.at)
                    .slice(0, 200)
                    .map((h) => (
                      <tr key={h.id} className="clickable" onClick={() => onEdit(h.post_id)}>
                        <td className="small">
                          <TimeAgo ms={h.at} />
                        </td>
                        <td>
                          <Addr a={`post:${h.post_id}`} noLink />
                        </td>
                        <td className="mono">v{h.version}</td>
                        <td>
                          <Addr a={h.actor} noLink />
                        </td>
                        <td className="small">{h.reason}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </Card>
      <Card title="待批" sub="配置与人事，批复在御书房">
        {pendingApprovals.length === 0 ? (
          <Empty text="并无待批" seal="清" />
        ) : (
          <div className="col">
            {pendingApprovals.map((a) => {
              const target = (a.payload.target_post as string | undefined) ?? (a.payload.post_id as string | undefined);
              return (
                <div key={a.id} className="card memorial" style={{ padding: "10px 14px" }}>
                  <div className="row between">
                    <span className="serif">
                      <Tag tone="azure">{a.type === "config_change" ? "配置" : a.type === "new_official" ? "新授" : "人事"}</Tag> <Addr a={a.requested_by} /> 奏请
                    </span>
                    <span className="muted small">
                      <TimeAgo ms={a.created_at} />
                    </span>
                  </div>
                  {target && (
                    <div style={{ marginTop: 6 }}>
                      对象：
                      <button className="btn sm ghost" onClick={() => onEdit(target)}>
                        <Addr a={`post:${target}`} noLink />
                      </button>
                    </div>
                  )}
                  <pre className="code-block" style={{ marginTop: 6, maxHeight: 140 }}>
                    {JSON.stringify(a.payload, null, 2)}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function PersonnelTab({ draft, setDraft }: { draft: PersonnelDraft; setDraft: (d: PersonnelDraft) => void }) {
  const r = useRegistry();
  const models = useQuery(() => hub.models(), [], { watch: ["model."] });
  const hist = useQuery(() => hub.personnelHistory(), [], { watch: ["personnel."] });
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const [result, setResult] = useState<string | null>(null);
  const set = (p: Partial<PersonnelDraft>) => setDraft({ ...draft, ...p });
  const a = draft.action;
  const needOfficial = a !== "new_official";
  const needPost = a === "appoint" || a === "transfer" || a === "new_official";
  const needModel = a === "set_model" || a === "new_official";
  const officials = useMemo(() => [...(r.registry?.officials ?? [])].filter((o) => o.status !== "dismissed"), [r.registry]);
  const selOfficial = draft.official_id ? r.officialById(draft.official_id) : undefined;
  const curPost = draft.official_id ? r.postOfOfficial(draft.official_id) : undefined;
  const modelEntry = models.data?.find((m) => m.key === draft.model);
  const targetDept = draft.post_id ? r.post(draft.post_id)?.dept : curPost ? r.post(curPost)?.dept : undefined;
  const fit = targetDept && modelEntry?.fitness ? modelEntry.fitness[targetDept as keyof typeof modelEntry.fitness] : undefined;
  const threshold = useFitnessThreshold();

  const valid = (!needOfficial || draft.official_id) && (!needPost || draft.post_id) && (!needModel || draft.model) && draft.reason.trim();

  const submit = async () => {
    let req: PersonnelReq;
    const base = { actor: "emperor", reason: draft.reason.trim() };
    if (a === "appoint") req = { ...base, action: a, official_id: draft.official_id, post_id: draft.post_id };
    else if (a === "transfer") req = { ...base, action: a, official_id: draft.official_id, to_post_id: draft.post_id };
    else if (a === "dismiss") req = { ...base, action: a, official_id: draft.official_id };
    else if (a === "set_model") req = { ...base, action: a, official_id: draft.official_id, model: draft.model };
    else req = { ...base, action: a, post_id: draft.post_id, model: draft.model, name: draft.name.trim() || undefined };
    const ok = await confirm({
      title: `${ACTION_LABEL[a]}之诏`,
      body: (
        <>
          {selOfficial && <div>官员：{selOfficial.name}</div>}
          {needPost && draft.post_id && <div>职位：{r.postLabel(draft.post_id, false)}</div>}
          {needModel && draft.model && <div>模型：{draft.model}</div>}
          <div className="muted small" style={{ marginTop: 6 }}>事由：{draft.reason}</div>
        </>
      ),
      okText: "准",
      danger: a === "dismiss",
    });
    if (!ok) return;
    const res = await run(() => hub.personnel(req));
    if (res) {
      setResult(res.status === "applied" ? "已施行" : `已入待批 ${res.approval_id ?? ""}`);
      hist.reload();
      r.reload();
    }
  };

  return (
    <div className="grid g2" style={{ alignItems: "start" }}>
      <Card title="人事任免" memorial>
        <div className="field">
          <span className="label">事项</span>
          <div className="seg fit">
            {ACTIONS.map((x) => (
              <button key={x.key} className={a === x.key ? "active" : ""} onClick={() => (set({ action: x.key }), setResult(null))}>
                {x.label}
              </button>
            ))}
          </div>
          <span className="hint">{ACTIONS.find((x) => x.key === a)?.hint}</span>
        </div>
        {needOfficial && (
          <div className="field">
            <span className="label">官员</span>
            <select value={draft.official_id} onChange={(e) => set({ official_id: e.target.value })}>
              <option value="">— 择官员 —</option>
              {officials.map((o) => {
                const p = r.postOfOfficial(o.official_id);
                return (
                  <option key={o.official_id} value={o.official_id}>
                    {o.name} · {p ? r.postLabel(p, false) : "无职"} · {o.model.split("/").pop()}
                  </option>
                );
              })}
            </select>
            {curPost && <span className="hint">现任：{r.postLabel(curPost, false)}（{r.deptName(r.post(curPost)?.dept)}）</span>}
          </div>
        )}
        {needPost && (
          <div className="field">
            <span className="label">{a === "transfer" ? "调往职位" : "职位"}</span>
            <PostPicker mode="post" includeDepts={false} value={draft.post_id} onChange={(v) => set({ post_id: v })} />
          </div>
        )}
        {a === "new_official" && (
          <div className="field">
            <span className="label">姓名（可空，系统生成唐风姓名）</span>
            <input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
        )}
        {needModel && (
          <div className="field">
            <span className="label">模型</span>
            <select value={draft.model} onChange={(e) => set({ model: e.target.value })}>
              <option value="">— 择模型 —</option>
              {(models.data ?? [])
                .filter((m) => m.status !== "retired")
                .map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name} · {MODEL_STATUS[m.status]?.label ?? m.status}
                  </option>
                ))}
            </select>
            {fit !== undefined && (
              <span className="hint">
                该模型于{r.deptName(targetDept)}适配度 <b className={fit < threshold ? "score-cell low" : "score-cell high"}>{fit}</b>
                {fit < threshold ? `（低于门槛 ${threshold}，须皇帝批准）` : ""}
              </span>
            )}
            {modelEntry && modelEntry.status !== "examined" && <span className="hint" style={{ color: "var(--warn)" }}>此模型尚未及第</span>}
          </div>
        )}
        <div className="field">
          <span className="label">事由</span>
          <textarea rows={3} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="陈述任免之由，入人事档" />
        </div>
        <div className="btn-row">
          <button className={`btn ${a === "dismiss" ? "danger" : "primary"}`} disabled={!valid || pending} onClick={submit}>
            {pending ? "施行中…" : `${ACTION_LABEL[a]}`}
          </button>
          {result && <Tag tone="jade">{result}</Tag>}
        </div>
      </Card>
      <Card title="人事档" sub="任免调迁、换模型记录">
        <QueryView q={hist} empty={<Empty text="尚无人事记录" seal="档" />}>
          {(rows) => (
            <div className="table-wrap" style={{ maxHeight: 560 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>事项</th>
                    <th>经手</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows]
                    .sort((x, y) => y.at - x.at)
                    .map((h, i) => (
                      <tr key={i}>
                        <td className="small">
                          <TimeAgo ms={h.at} />
                        </td>
                        <td>
                          <Tag tone={h.action === "dismiss" ? "red" : h.action === "set_model" ? "azure" : "gold"}>{ACTION_LABEL[h.action] ?? h.action}</Tag>
                        </td>
                        <td>
                          <Addr a={h.actor} />
                        </td>
                        <td className="small">{h.detail}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </Card>
    </div>
  );
}

function VacancyCard({ post, onFill }: { post: PostDef; onFill: () => void }) {
  const r = useRegistry();
  return (
    <div className="card vacancy-card">
      <Seal text="缺" tone="ink" size={38} />
      <div className="grow">
        <div className="title">
          {post.title}
          {post.approval_sensitive && <span className="sensitive-mark">敏</span>}
        </div>
        <div className="muted small">
          {r.deptName(post.dept)} · {post.rank} · <span className="mono">{post.post_id}</span>
        </div>
        <p className="small clamp-3" style={{ marginTop: 6 }}>
          {post.duties}
        </p>
        <button className="btn sm gold" onClick={onFill}>
          补缺
        </button>
      </div>
    </div>
  );
}
