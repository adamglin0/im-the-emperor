// 科举：模型池、考场、金榜（雷达 + 部门适配矩阵）、题库
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { ExamDimension, ExamQuestion, ExamSession, ModelEntry } from "@court/shared/types";
import type { ProviderInfo } from "@court/shared/api";
import { EXAM_DIMENSIONS } from "@court/shared/types";
import { errorText, hub } from "../api/client.ts";
import { useFitnessThreshold } from "../api/meta.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo } from "../components/Addr.tsx";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { HeatGrid, Radar, SERIES } from "../components/charts.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { Drawer, Modal, useConfirm } from "../components/Overlay.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { fmtCost, fmtDuration, fmtTokens, truncate } from "../lib/format.ts";
import { DEPT_ORDER, EXAM_DIMENSION, MODEL_STATUS } from "../lib/labels.ts";
import "../styles/pages/offices.css";

/** 适配矩阵色阶起点 */
const HEAT_FLOOR = 55;
const SESSION_STATE: Record<ExamSession["state"], { label: string; tone: "gold" | "azure" | "plum" | "jade" | "red" }> = {
  pending: { label: "待考", tone: "gold" },
  running: { label: "应试中", tone: "azure" },
  grading: { label: "阅卷中", tone: "plum" },
  done: { label: "毕", tone: "jade" },
  failed: { label: "失败", tone: "red" },
};
const Q_KIND: Record<ExamQuestion["kind"], string> = {
  exact: "全等",
  contains: "包含",
  regex: "正则",
  json_keys: "JSON 键",
  tool_call: "工具调用",
  rubric: "阅卷",
  json_exact: "JSON 全等",
  numeric: "数值",
  multi_regex: "多重正则",
  length_range: "长度",
  code_output: "代码输出",
  tool_calls: "多步工具",
};
/** 御出试题可选的判法（新判法的 expected 为结构化 JSON，暂只用于内置难题） */
const FORM_KINDS: ExamQuestion["kind"][] = ["exact", "contains", "regex", "json_keys", "tool_call", "rubric"];

/** 实测指标简述：速度 / 性价比 */
function MetricsText({ m }: { m?: ModelEntry["metrics"] }) {
  if (!m || (m.speed === undefined && m.cost_efficiency === undefined)) return <span className="muted small">—</span>;
  return (
    <span className="small" title={`耗时中位数 ${m.median_latency_ms ?? "—"}ms · 每题 ${m.cost_per_question !== undefined ? fmtCost(m.cost_per_question) : "—"}`}>
      速 {m.speed ?? "—"} · 价 {m.cost_efficiency ?? "—"}
    </span>
  );
}

function avgOf(scores?: Partial<Record<ExamDimension, number>>): number | undefined {
  const v = Object.values(scores ?? {}).filter((x): x is number => typeof x === "number");
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined;
}

function avgScore(m: Pick<ModelEntry, "scores">): number | undefined {
  const v = Object.values(m.scores ?? {}).filter((x): x is number => typeof x === "number");
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined;
}

type TabKey = "pool" | "sessions" | "bang" | "bank";

export default function ExamsPage() {
  const [tab, setTab] = useState<TabKey>("pool");
  const models = useQuery(() => hub.models(), [], { watch: ["model.", "exam."] });
  const sessions = useQuery(() => hub.examSessions(), [], { watch: ["exam."], interval: 20_000 });
  const [openSession, setOpenSession] = useState<string | null>(null);
  const list = models.data ?? [];
  const examined = list.filter((m) => m.scores && Object.keys(m.scores).length);
  const best = [...examined].sort((a, b) => (avgScore(b) ?? 0) - (avgScore(a) ?? 0))[0];

  return (
    <div className="page">
      <PageHead title="科举" lede="考功员外郎知贡举。候选模型入场应试，八科判分，金榜定部门之适配，户部据此任命换模。" />
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="模型池" value={list.length} unit="家" sub={`待考 ${list.filter((m) => m.status === "candidate").length}`} />
        <Stat label="及第" value={list.filter((m) => m.status === "examined").length} unit="家" tone="jade" sub={`落第 ${list.filter((m) => m.status === "failed").length}`} />
        <Stat label="考场" value={sessions.data?.length ?? "—"} unit="场" tone="azure" sub={`进行中 ${(sessions.data ?? []).filter((s) => s.state === "running" || s.state === "grading").length}`} />
        <Stat label="状元" value={best ? (avgScore(best) ?? "—") : "—"} unit="分" tone="red" sub={best?.name ?? "尚无"} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "pool", label: "模型池" },
          { key: "sessions", label: "考场" },
          { key: "bang", label: "金榜" },
          { key: "bank", label: "题库" },
        ]}
      />
      {tab === "pool" && <PoolTab q={models} onSessions={() => setTab("sessions")} />}
      {tab === "sessions" && (
        <QueryView q={sessions} empty={<Empty text="尚未开科" seal="举" />}>
          {(rows) => <SessionsTable rows={rows} models={list} onOpen={setOpenSession} />}
        </QueryView>
      )}
      {tab === "bang" && (models.initial ? <Loading /> : examined.length === 0 ? <Empty text="尚无及第之模型，金榜未张" seal="榜" /> : <BangTab models={examined} />)}
      {tab === "bank" && <BankTab />}
      <SessionDrawer id={openSession} models={list} onClose={() => setOpenSession(null)} />
    </div>
  );
}

// ───────── 模型池 ─────────
function PoolTab({ q, onSessions }: { q: ReturnType<typeof useQuery<ModelEntry[]>>; onSessions: () => void }) {
  const FITNESS_THRESHOLD = useFitnessThreshold();
  const [adding, setAdding] = useState(false);
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const start = async (m: ModelEntry) => {
    const ok = await confirm({ title: `开科：${m.name}`, body: "考场将经网关以此模型作答全部有效试题，计入账本（不受官员预算限制）。", okText: "开考" });
    if (!ok) return;
    const s = await run(() => hub.startExam({ model_key: m.key, actor: "emperor" }), "已开考");
    if (s) {
      q.reload();
      onSessions();
    }
  };
  return (
    <Card
      title="模型池"
      sub="皇帝添入 → 待考 → 自动排考"
      flush
      actions={
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          ＋ 添模型
        </button>
      }
    >
      <QueryView q={q} empty={<Empty text="模型池空空如也" seal="空" />}>
        {(rows) => (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>键</th>
                  <th>状态</th>
                  <th className="num">均分</th>
                  <th>八科</th>
                  <th>实测</th>
                  <th>入池</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const avg = avgScore(m);
                  const st = MODEL_STATUS[m.status] ?? { label: m.status, tone: "" as const };
                  return (
                    <tr key={m.key}>
                      <td className="serif">
                        <b>{m.name}</b>
                        {m.notes && <div className="muted small">{m.notes}</div>}
                      </td>
                      <td className="mono small">{m.key}</td>
                      <td>
                        <Tag tone={st.tone}>{st.label}</Tag>
                      </td>
                      <td className={`num score-cell ${avg !== undefined && avg < FITNESS_THRESHOLD ? "low" : ""}`}>{avg ?? "—"}</td>
                      <td>
                        <MiniBars scores={m.scores} />
                      </td>
                      <td>
                        <MetricsText m={m.metrics} />
                      </td>
                      <td className="small">
                        <TimeAgo ms={m.added_at} />
                      </td>
                      <td>
                        <button className="btn sm gold" disabled={pending || m.status === "examining" || m.status === "retired"} onClick={() => void start(m)}>
                          {m.status === "examining" ? "应试中" : m.status === "candidate" ? "开考" : "再考"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
      <AddModelModal open={adding} onClose={() => setAdding(false)} onAdded={q.reload} />
    </Card>
  );
}

/** 八科迷你条（同一色阶，高低一眼可辨） */
function MiniBars({ scores }: { scores?: Partial<Record<ExamDimension, number>> }) {
  const FITNESS_THRESHOLD = useFitnessThreshold();
  if (!scores || !Object.keys(scores).length) return <span className="muted small">未考</span>;
  return (
    <svg width={8 * 9} height={22} style={{ display: "block" }} aria-label="八科分数">
      {EXAM_DIMENSIONS.map((d, i) => {
        const v = scores[d] ?? 0;
        const h = Math.max(1, (v / 100) * 20);
        return (
          <rect key={d} x={i * 9} y={22 - h} width={7} height={h} rx={1.5} fill={v < FITNESS_THRESHOLD ? "var(--series-1)" : "var(--series-2)"}>
            <title>
              {EXAM_DIMENSION[d]}：{scores[d] ?? "—"}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

/** 「旧式自填」：仅当存在 config/models.yaml 的 legacy 提供商时可选，需手填 api / base_url */
const LEGACY_FREE = "custom";

function AddModelModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const provs = useQuery(() => hub.providers(), [], { enabled: open, watch: ["provider."], interval: 0 });
  const [f, setF] = useState({ provider: "", model_id: "", name: "", api: "", base_url: "", context_window: "", notes: "" });
  const [autoName, setAutoName] = useState("");
  const [check, setCheck] = useState<{ reason: string } | null>(null);
  const { run, pending } = useAction();
  const set = (p: Partial<typeof f>) => {
    setCheck(null);
    setF((x) => ({ ...x, ...p }));
  };

  const list = useMemo(() => {
    const rank = { builtin: 0, custom: 1, legacy: 2 } as const;
    return [...(provs.data ?? [])].sort((a, b) => Number(b.configured) - Number(a.configured) || rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name, "zh-CN"));
  }, [provs.data]);
  const hasLegacy = list.some((p) => p.kind === "legacy");
  const legacyFree = hasLegacy && !list.some((p) => p.id === LEGACY_FREE);
  const prov = list.find((p) => p.id === f.provider);
  const free = f.provider === LEGACY_FREE && (legacyFree || prov?.kind === "legacy");

  // 默认选第一个已启用的提供商
  useEffect(() => {
    if (!f.provider && list.length) setF((x) => ({ ...x, provider: (list.find((p) => p.configured) ?? list[0]).id }));
  }, [list, f.provider]);

  const catalog = useQuery(() => hub.providerModels(f.provider), [f.provider], { enabled: open && !!prov, interval: 0 });
  const models = catalog.data ?? [];
  const listed = models.find((m) => m.id === f.model_id.trim());
  const unlisted = !!f.model_id.trim() && catalog.data !== undefined && !listed;

  const onModelId = (v: string) => {
    const m = models.find((x) => x.id === v.trim());
    if (m && (!f.name.trim() || f.name === autoName)) {
      setAutoName(m.name);
      set({ model_id: v, name: m.name, context_window: m.context_window ? String(m.context_window) : f.context_window });
    } else set({ model_id: v });
  };

  // 换提供商：模型 ID 与自动带出的名称/上下文随之作废
  const onProvider = (v: string) => {
    const auto = !!autoName && f.name === autoName;
    setAutoName("");
    set({ provider: v, model_id: "", ...(auto ? { name: "", context_window: "" } : {}) });
  };

  const submit = async (skipCheck = false) => {
    const provider = f.provider.trim();
    const model_id = f.model_id.trim();
    let ctx = f.context_window;
    if (!skipCheck && !free) {
      try {
        const c = await hub.checkModel(provider, model_id);
        if (!c.ok) {
          setCheck({ reason: c.reason ?? (c.configured === false ? "提供商尚未配置凭据" : "网关核验未过") });
          return;
        }
        if (!ctx && c.model?.context_window) ctx = String(c.model.context_window);
      } catch (e) {
        setCheck({ reason: `核验出错：${errorText(e)}` });
        return;
      }
    }
    const m = await run(
      () =>
        hub.addModel({
          provider,
          model_id,
          name: f.name.trim() || undefined,
          api: free ? f.api.trim() || undefined : undefined,
          base_url: free ? f.base_url.trim() || undefined : undefined,
          context_window: ctx ? Number(ctx) : undefined,
          notes: f.notes.trim() || undefined,
        }),
      "已添入模型池，候考",
    );
    if (m) {
      onAdded();
      onClose();
      setCheck(null);
      setAutoName("");
      setF((x) => ({ ...x, model_id: "", name: "", context_window: "", notes: "" }));
    }
  };
  const ready = !pending && !!f.provider && !!f.model_id.trim() && (!free || (!!f.api.trim() && !!f.base_url.trim()));
  const configured = list.filter((p) => p.configured);
  const idle = list.filter((p) => !p.configured);
  const optLabel = (p: ProviderInfo) => `${p.name} · ${p.id}${p.configured ? "" : "（未配置）"}`;

  return (
    <Modal open={open} onClose={onClose} title="添模型入池" width={560}>
      {provs.error !== undefined && <ErrorBox error={provs.error} onRetry={provs.reload} />}
      <div className="grid g2" style={{ gap: 10 }}>
        <label className="field">
          <span className="label">提供商</span>
          <select value={f.provider} onChange={(e) => onProvider(e.target.value)} disabled={provs.initial}>
            {provs.initial && <option value="">读取中…</option>}
            {configured.length > 0 && (
              <optgroup label="已启用">
                {configured.map((p) => (
                  <option key={p.id} value={p.id}>
                    {optLabel(p)}
                  </option>
                ))}
              </optgroup>
            )}
            {idle.length > 0 && (
              <optgroup label="未配置">
                {idle.map((p) => (
                  <option key={p.id} value={p.id}>
                    {optLabel(p)}
                  </option>
                ))}
              </optgroup>
            )}
            {legacyFree && (
              <optgroup label="旧式">
                <option value={LEGACY_FREE}>custom（自填 api / base_url）</option>
              </optgroup>
            )}
          </select>
          {prov && !prov.configured && (
            <span className="hint" style={{ color: "var(--warn)" }}>
              尚未配置凭据，入池后无法应试。<Link to="/settings">前往设置 →</Link>
            </span>
          )}
          {!provs.initial && list.length > 0 && configured.length === 0 && (
            <span className="hint">
              尚无已启用的提供商，<Link to="/settings">先去设置</Link>。
            </span>
          )}
        </label>
        <label className="field">
          <span className="label">模型 ID</span>
          <input type="text" list="exam-add-models" value={f.model_id} onChange={(e) => onModelId(e.target.value)} placeholder={catalog.initial ? "目录读取中…" : models[0]?.id ?? "deepseek-v4-pro"} spellCheck={false} />
          <datalist id="exam-add-models">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </datalist>
          {unlisted && prov && !prov.allow_unlisted && (
            <span className="hint" style={{ color: "var(--bad)" }}>
              不在 {prov.name} 的模型目录中，且该提供商不许目录外 ID。
            </span>
          )}
          {unlisted && prov?.allow_unlisted && <span className="hint">目录外 ID：将按该提供商的接口与地址推断。</span>}
          {listed && (
            <span className="hint">
              {listed.reasoning ? "推理 · " : ""}
              {listed.input.includes("image") ? "识图 · " : ""}输出上限 {fmtTokens(listed.max_tokens)}
            </span>
          )}
        </label>
        <label className="field">
          <span className="label">名称</span>
          <input type="text" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="显示名" />
        </label>
        <label className="field">
          <span className="label">上下文窗口</span>
          <input type="number" value={f.context_window} onChange={(e) => set({ context_window: e.target.value })} placeholder="128000" />
        </label>
        {free && (
          <>
            <label className="field">
              <span className="label">API（必填）</span>
              <input type="text" value={f.api} onChange={(e) => set({ api: e.target.value })} placeholder="openai-completions" />
            </label>
            <label className="field">
              <span className="label">Base URL（必填）</span>
              <input type="text" value={f.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://…/v1" />
            </label>
          </>
        )}
      </div>
      <label className="field">
        <span className="label">备注</span>
        <input type="text" value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
      {check && (
        <div className="err-box" role="alert" style={{ marginBottom: 12 }}>
          <Seal text="驳" tone="red" size={22} />
          <div className="grow">网关核验未过：{check.reason}</div>
        </div>
      )}
      <div className="small muted" style={{ marginBottom: 12 }}>
        密钥只存网关，此处不收；提供商与自定义地址请于 <Link to="/settings">设置</Link> 中配置。
      </div>
      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          罢
        </button>
        {check ? (
          <button className="btn gold" disabled={!ready} onClick={() => void submit(true)}>
            仍要添入
          </button>
        ) : (
          <button className="btn primary" disabled={!ready} onClick={() => void submit()}>
            添入
          </button>
        )}
      </div>
    </Modal>
  );
}

// ───────── 考场 ─────────
function SessionsTable({ rows, models, onOpen }: { rows: ExamSession[]; models: ModelEntry[]; onOpen: (id: string) => void }) {
  return (
    <Card flush title="考场" sub="点击一场查看答卷">
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>考生</th>
              <th>状态</th>
              <th>进度</th>
              <th className="num">总分</th>
              <th>开考</th>
              <th>历时</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {[...rows]
              .sort((a, b) => b.created_at - a.created_at)
              .map((s) => (
                <SessionRow key={s.id} s={s} name={models.find((m) => m.key === s.model_key)?.name ?? s.model_key} onOpen={() => onOpen(s.id)} />
              ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SessionRow({ s, name, onOpen }: { s: ExamSession; name: string; onOpen: () => void }) {
  const live = s.state === "running" || s.state === "grading" || s.state === "pending";
  const d = useQuery(() => hub.examSession(s.id), [s.id, s.state], { watch: live ? ["exam."] : undefined, interval: live ? 15_000 : 0 });
  const answers = d.data?.answers ?? [];
  const done = answers.filter((a) => a.state === "graded" || a.state === "error").length;
  const st = SESSION_STATE[s.state];
  return (
    <tr className="clickable" onClick={onOpen}>
      <td className="serif">
        <b>{name}</b>
        <div className="mono small muted">{s.model_key}</div>
      </td>
      <td>
        <Tag tone={st.tone}>{st.label}</Tag>
      </td>
      <td>
        {d.data ? (
          <div className="row">
            <div className={`progress ${live ? "running" : ""}`} style={{ width: 110 }}>
              <i style={{ width: `${answers.length ? (done / answers.length) * 100 : 0}%` }} />
            </div>
            <span className="small num">
              {done}/{answers.length}
            </span>
          </div>
        ) : (
          <span className="muted small">…</span>
        )}
      </td>
      <td className="num score-cell">{s.total ?? "—"}</td>
      <td className="small">
        <TimeAgo ms={s.started_at ?? s.created_at} />
      </td>
      <td className="small num">{s.started_at && s.finished_at ? fmtDuration(s.finished_at - s.started_at) : live ? "进行中" : "—"}</td>
      <td className="small" style={{ color: s.error ? "var(--bad)" : undefined }}>
        {s.error ?? ""}
      </td>
    </tr>
  );
}

function SessionDrawer({ id, models, onClose }: { id: string | null; models: ModelEntry[]; onClose: () => void }) {
  const FITNESS_THRESHOLD = useFitnessThreshold();
  const d = useQuery(() => hub.examSession(id!), [id], { enabled: !!id, watch: ["exam."], interval: 0 });
  const [dim, setDim] = useState<string>("");
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const s = d.data?.session;
  const name = models.find((m) => m.key === s?.model_key)?.name ?? s?.model_key;
  const answers = (d.data?.answers ?? []).filter((a) => !dim || a.question.dimension === dim);
  const totals = (d.data?.answers ?? []).reduce((acc, a) => ({ tokens: acc.tokens + a.tokens, cost: acc.cost + a.cost, ms: acc.ms + a.latency_ms }), { tokens: 0, cost: 0, ms: 0 });
  const publish = async () => {
    if (!s) return;
    const ok = await confirm({ title: "放榜", body: `将 ${name} 之八科成绩写入模型池，并据此计算部门适配度。`, okText: "放榜" });
    if (ok) await run(() => hub.publishExam({ session_id: s.id, actor: "emperor" }), "金榜已张");
  };
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={980}
      title={
        <span>
          考场 · {name ?? "…"} {s && <Tag tone={SESSION_STATE[s.state].tone}>{SESSION_STATE[s.state].label}</Tag>}
        </span>
      }
      head={
        s?.state === "done" ? (
          <button className="btn primary sm" disabled={pending} onClick={publish}>
            放榜
          </button>
        ) : undefined
      }
    >
      {d.initial ? (
        <Loading />
      ) : !d.data ? (
        <ErrorBox error={d.error} onRetry={d.reload} />
      ) : (
        <div className="stack">
          <div className="grid g4">
            <Stat label="总分" value={s?.total ?? "—"} tone="red" />
            <Stat label="答卷" value={d.data.answers.length} unit="题" />
            <Stat label="耗 token" value={fmtTokens(totals.tokens)} sub={fmtCost(totals.cost)} />
            <Stat label="累计用时" value={fmtDuration(totals.ms)} tone="azure" />
          </div>
          {s?.metrics && (s.metrics.speed !== undefined || s.metrics.cost_efficiency !== undefined) && (
            <div className="grid g4">
              <Stat label="速度" value={s.metrics.speed ?? "—"} unit="分" tone="azure" sub={s.metrics.median_latency_ms !== undefined ? `耗时中位 ${fmtDuration(s.metrics.median_latency_ms)}` : undefined} />
              <Stat label="性价比" value={s.metrics.cost_efficiency ?? "—"} unit="分" tone="jade" sub={s.metrics.cost_per_question !== undefined ? `每题 ${fmtCost(s.metrics.cost_per_question)}` : "价格未知"} />
              <Stat label="基础卷" value={avgOf(s.scores_by_difficulty?.basic) ?? "—"} unit="分" />
              <Stat label="难题卷" value={avgOf(s.scores_by_difficulty?.hard) ?? "—"} unit="分" tone="red" />
            </div>
          )}
          {s?.scores && (
            <div className="row wrap">
              {EXAM_DIMENSIONS.map((k) => {
                const b = s.scores_by_difficulty?.basic?.[k];
                const hd = s.scores_by_difficulty?.hard?.[k];
                return (
                  <Tag key={k} tone={(s.scores?.[k] ?? 0) < FITNESS_THRESHOLD ? "red" : "jade"} title={hd !== undefined ? `基础 ${b ?? "—"} · 难题 ${hd}（难题权重 ×3）` : undefined}>
                    {EXAM_DIMENSION[k]} {s.scores?.[k] ?? "—"}
                    {hd !== undefined && <span className="muted"> （{b ?? "—"}/{hd}）</span>}
                  </Tag>
                );
              })}
            </div>
          )}
          <div className="toolbar">
            <select value={dim} onChange={(e) => setDim(e.target.value)}>
              <option value="">全部八科</option>
              {EXAM_DIMENSIONS.map((k) => (
                <option key={k} value={k}>
                  {EXAM_DIMENSION[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>科</th>
                  <th style={{ width: "26%" }}>试题</th>
                  <th>作答</th>
                  <th className="num">自动</th>
                  <th className="num">阅卷</th>
                  <th>阅卷评语</th>
                  <th className="num">耗</th>
                </tr>
              </thead>
              <tbody>
                {answers.map((a) => {
                  return (
                    <tr key={a.id}>
                      <td>
                        <Tag>{EXAM_DIMENSION[a.question.dimension]}</Tag>
                        <div className="muted small">
                          {Q_KIND[a.question.kind]} {a.question.difficulty === "hard" && <Tag tone="red">难</Tag>}
                        </div>
                      </td>
                      <td className="small serif">{truncate(a.question.prompt, 120)}</td>
                      <td>
                        {a.output && <div className="answer-output">{a.output}</div>}
                        {a.tool_calls !== undefined && a.tool_calls !== null && <JsonView value={a.tool_calls} maxHeight={120} />}
                        {a.state === "error" && <Tag tone="red">出错</Tag>}
                      </td>
                      <td className={`num score-cell ${a.auto_score !== undefined && a.auto_score < 60 ? "low" : ""}`}>{a.auto_score ?? "—"}</td>
                      <td className={`num score-cell ${a.grader_score !== undefined && a.grader_score < 60 ? "low" : ""}`}>
                        {a.state === "needs_grading" ? <Tag tone="plum">待阅</Tag> : (a.grader_score ?? "—")}
                      </td>
                      <td className="small">
                        {a.comment ?? ""}
                        {a.grader && (
                          <div className="muted">
                            — <Addr a={a.grader} />
                          </div>
                        )}
                      </td>
                      <td className="num small" title={`${a.latency_ms}ms · ${a.tokens} tokens · ${fmtCost(a.cost)}`}>
                        {fmtDuration(a.latency_ms)}
                        <div className="muted">{fmtTokens(a.tokens)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ───────── 金榜 ─────────
function BangTab({ models }: { models: ModelEntry[] }) {
  const FITNESS_THRESHOLD = useFitnessThreshold();
  const r = useRegistry();
  const ranked = useMemo(() => [...models].sort((a, b) => (avgScore(b) ?? 0) - (avgScore(a) ?? 0)), [models]);
  const [sel, setSel] = useState<string[]>(() => ranked.slice(0, 3).map((m) => m.key));
  const toggle = (k: string) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : s.length >= 4 ? s : [...s, k]));
  const chosen = ranked.filter((m) => sel.includes(m.key));
  // 颜色跟随模型（选择顺序固定为金榜名次），不随勾选数量变化
  const colorOf = (k: string) => SERIES[chosen.findIndex((m) => m.key === k)] ?? "var(--rule)";
  const depts = (r.depts.length ? r.depts.map((d) => d.id as string) : DEPT_ORDER).map((id) => ({ key: id, label: r.deptName(id) }));

  return (
    <div className="stack">
      <div className="jinbang">
        <Card title="金榜" memorial>
          <div className="bang-list">
            {ranked.map((m, i) => (
              <div key={m.key} className="bang-row">
                <span className="rank">{["状元", "榜眼", "探花"][i] ? <Seal text={["元", "眼", "花"][i]} tone={i === 0 ? "red" : "gold"} size={28} /> : i + 1}</span>
                <span>
                  <div className="name">{m.name}</div>
                  <div className="mono small muted">{m.key}</div>
                </span>
                <span className="score">{avgScore(m) ?? "—"}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="八科雷达" sub="至多择四家对比">
          <div className="row wrap" style={{ marginBottom: 10 }}>
            {ranked.map((m) => {
              const on = sel.includes(m.key);
              return (
                <button key={m.key} className={`chip ${on ? "on" : ""}`} onClick={() => toggle(m.key)} disabled={!on && sel.length >= 4}>
                  <span className="sw" style={{ background: on ? colorOf(m.key) : undefined }} />
                  {m.name}
                </button>
              );
            })}
          </div>
          {chosen.length === 0 ? (
            <Empty text="请择模型" seal="择" />
          ) : (
            <Radar
              size={340}
              axes={EXAM_DIMENSIONS.map((d) => ({ key: d, label: EXAM_DIMENSION[d] }))}
              series={chosen.map((m) => ({ key: m.key, label: m.name, values: m.scores ?? {} }))}
            />
          )}
        </Card>
      </div>
      <Card title="部门适配矩阵" sub="维度分 × 部门权重 → 适配度（0–100）">
        <HeatGrid
          rows={ranked.map((m) => ({ key: m.key, label: m.name }))}
          cols={depts}
          value={(row, col) => {
            const v = ranked.find((m) => m.key === row)?.fitness?.[col as keyof NonNullable<ModelEntry["fitness"]>];
            // 色阶从 55 起算（门槛附近拉开层次）：适配度普遍偏高，满幅 0–100 会让全表同色
            // 低于起点者编码为 v/1000（落入最浅一档，且可还原原值）
            return v === undefined ? undefined : v > HEAT_FLOOR ? v - HEAT_FLOOR + 1 : v / 1000;
          }}
          format={(n) => {
            const v = Math.round(n < 1 ? n * 1000 : n - 1 + HEAT_FLOOR);
            return v < FITNESS_THRESHOLD ? `${v}↓` : String(v);
          }}
          max={101 - HEAT_FLOOR}
          cell={36}
          rowLabelWidth={140}
        />
        <div className="threshold-note">
          <span>适配度低于 {FITNESS_THRESHOLD}（标 ↓）者，户部任命须陛下批准。</span>
          <span className="legend">
            {[1, 2, 3, 4, 5].map((k) => (
              <span key={k}>
                <i style={{ background: `var(--seq-${k})` }} />
                {k === 1 ? `≤${HEAT_FLOOR + 9}` : `${HEAT_FLOOR + (k - 1) * 9}–${HEAT_FLOOR + k * 9}`}
              </span>
            ))}
          </span>
        </div>
      </Card>
    </div>
  );
}

// ───────── 题库 ─────────
function BankTab() {
  const q = useQuery(() => hub.examQuestions({ viewer: "emperor" }), [], { watch: ["exam."] });
  const [dim, setDim] = useState("");
  const [kind, setKind] = useState("");
  const [author, setAuthor] = useState("");
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const authors = useMemo(() => [...new Set((q.data ?? []).map((x) => x.author))], [q.data]);
  const rows = (q.data ?? []).filter((x) => (!dim || x.dimension === dim) && (!kind || x.kind === kind) && (!author || x.author === author) && (!status || x.status === status));
  const byDim = useMemo(() => {
    const m: Record<string, number> = {};
    for (const x of q.data ?? []) if (x.status === "active") m[x.dimension] = (m[x.dimension] ?? 0) + 1;
    return m;
  }, [q.data]);
  return (
    <Card
      title="题库"
      sub={`共 ${q.data?.length ?? 0} 题`}
      flush
      actions={
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          ＋ 出题
        </button>
      }
    >
      <div style={{ padding: "10px 14px 0" }}>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {EXAM_DIMENSIONS.map((d) => (
            <Tag key={d} tone={(byDim[d] ?? 0) === 0 ? "red" : ""} title="有效试题数">
              {EXAM_DIMENSION[d]} {byDim[d] ?? 0}
            </Tag>
          ))}
        </div>
        <div className="toolbar">
          <select value={dim} onChange={(e) => setDim(e.target.value)}>
            <option value="">全部八科</option>
            {EXAM_DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {EXAM_DIMENSION[d]}
              </option>
            ))}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">全部判法</option>
            {Object.entries(Q_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select value={author} onChange={(e) => setAuthor(e.target.value)}>
            <option value="">全部出题人</option>
            {authors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="active">有效</option>
            <option value="draft">草稿</option>
            <option value="retired">停用</option>
          </select>
        </div>
      </div>
      <QueryView q={q} empty={<Empty text="题库空" seal="题" />}>
        {() =>
          rows.length === 0 ? (
            <Empty text="无符合条件之题" />
          ) : (
            <div className="table-wrap" style={{ maxHeight: 620 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>科</th>
                    <th>判法</th>
                    <th style={{ width: "48%" }}>题面</th>
                    <th>出题人</th>
                    <th>状态</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => (
                    <FragmentRow key={x.id} x={x} open={open === x.id} onToggle={() => setOpen(open === x.id ? null : x.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </QueryView>
      <AddQuestionModal open={adding} onClose={() => setAdding(false)} onAdded={q.reload} />
    </Card>
  );
}

function FragmentRow({ x, open, onToggle }: { x: ExamQuestion; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td>
          <Tag>{EXAM_DIMENSION[x.dimension]}</Tag>
        </td>
        <td className="small">
          {Q_KIND[x.kind]} {x.difficulty === "hard" && <Tag tone="red">难</Tag>}
        </td>
        <td className="serif small">{open ? x.prompt : truncate(x.prompt, 90)}</td>
        <td className="small">
          <Addr a={x.author} />
        </td>
        <td>
          <Tag tone={x.status === "active" ? "jade" : x.status === "draft" ? "gold" : "ink"}>{x.status === "active" ? "有效" : x.status === "draft" ? "草稿" : "停用"}</Tag>
        </td>
        <td className="small">
          <TimeAgo ms={x.created_at} />
        </td>
      </tr>
      {open && (x.expected || x.rubric || x.tools) && (
        <tr>
          <td colSpan={6} style={{ background: "var(--panel-2)" }}>
            <dl className="kv">
              {x.expected && (
                <>
                  <dt>标准答案</dt>
                  <dd className="mono small">{x.expected}</dd>
                </>
              )}
              {x.rubric && (
                <>
                  <dt>阅卷细则</dt>
                  <dd className="small">{x.rubric}</dd>
                </>
              )}
              {x.tools && (
                <>
                  <dt>模拟工具</dt>
                  <dd>
                    <JsonView value={x.tools} maxHeight={200} />
                  </dd>
                </>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function AddQuestionModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [f, setF] = useState<{ dimension: ExamDimension; kind: ExamQuestion["kind"]; prompt: string; expected: string; rubric: string; status: ExamQuestion["status"] }>({
    dimension: "reasoning",
    kind: "rubric",
    prompt: "",
    expected: "",
    rubric: "",
    status: "active",
  });
  const { run, pending } = useAction();
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const needExpected = f.kind !== "rubric";
  const submit = async () => {
    const res = await run(
      () =>
        hub.addExamQuestion({
          dimension: f.dimension,
          kind: f.kind,
          prompt: f.prompt.trim(),
          expected: needExpected ? f.expected.trim() || undefined : undefined,
          rubric: f.rubric.trim() || undefined,
          author: "emperor",
          status: f.status,
        }),
      "试题已入库",
    );
    if (res) {
      onAdded();
      onClose();
      setF({ ...f, prompt: "", expected: "", rubric: "" });
    }
  };
  const expectedHint: Record<string, string> = {
    exact: "须与作答全等",
    contains: "作答须包含此串",
    regex: "正则表达式",
    json_keys: "逗号分隔的键名，如 name,rank",
    tool_call: 'JSON：{"name":"get_weather","args":{"city":"长安"}}',
  };
  return (
    <Modal open={open} onClose={onClose} title="御出试题" width={600}>
      <div className="grid g3" style={{ gap: 10 }}>
        <label className="field">
          <span className="label">科目</span>
          <select value={f.dimension} onChange={(e) => set({ dimension: e.target.value as ExamDimension })}>
            {EXAM_DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {EXAM_DIMENSION[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">判法</span>
          <select value={f.kind} onChange={(e) => set({ kind: e.target.value as ExamQuestion["kind"] })}>
            {FORM_KINDS.map((k) => (
              <option key={k} value={k}>
                {Q_KIND[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">状态</span>
          <select value={f.status} onChange={(e) => set({ status: e.target.value as ExamQuestion["status"] })}>
            <option value="active">有效</option>
            <option value="draft">草稿</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span className="label">题面</span>
        <textarea rows={5} value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </label>
      {needExpected && (
        <label className="field">
          <span className="label">标准答案</span>
          <input type="text" value={f.expected} onChange={(e) => set({ expected: e.target.value })} />
          <span className="hint">{expectedHint[f.kind]}</span>
        </label>
      )}
      <label className="field">
        <span className="label">阅卷细则{f.kind === "rubric" ? "" : "（可空）"}</span>
        <textarea rows={2} value={f.rubric} onChange={(e) => set({ rubric: e.target.value })} />
      </label>
      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          罢
        </button>
        <button className="btn primary" disabled={pending || !f.prompt.trim() || (needExpected && !f.expected.trim()) || (f.kind === "rubric" && !f.rubric.trim())} onClick={submit}>
          入库
        </button>
      </div>
    </Modal>
  );
}
