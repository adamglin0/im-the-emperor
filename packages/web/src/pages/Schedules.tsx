// 定时任务：全局 / 按部门 / 按官员；cron 编辑（下 5 次预览）、启停、立即触发、运行历史、未来 24h 热图
import { useMemo, useState } from "react";
import type { Schedule, ScheduleRun, ScheduleSpec } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo, TraceLink } from "../components/Addr.tsx";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { seqColor, useTip } from "../components/charts.tsx";
import { Drawer, useConfirm } from "../components/Overlay.tsx";
import { PostPicker } from "../components/PostPicker.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, QueryView } from "../components/States.tsx";
import { Seg, Tabs } from "../components/Tabs.tsx";
import { Tag } from "../components/Tag.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useNow } from "../hooks/useNow.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { CRON_PRESETS, describeSpec, minIntervalSeconds, nextRuns, runsBetween, validateCron } from "../lib/cron.ts";
import { fmtAgo, fmtDateTime, fmtDuration, fmtTime } from "../lib/format.ts";
import { DEPT_SEAL, SCHEDULE_STATUS, type Tone } from "../lib/labels.ts";
import "../styles/pages/ops.css";

const OUTCOME: Record<ScheduleRun["outcome"], { label: string; tone: Tone }> = {
  fired: { label: "已触发", tone: "jade" },
  skipped_unhandled: { label: "跳过·前次未办", tone: "gold" },
  catchup: { label: "补跑", tone: "azure" },
  manual: { label: "手动", tone: "ink" },
};

type TabKey = "all" | "dept" | "post";

/** 下一次运行：优先 hub 给的 next_run_at，否则本地推算 */
function nextRunOf(s: Schedule, now: number): number | undefined {
  if (!s.enabled || s.status !== "active") return undefined;
  if (s.next_run_at && s.next_run_at > now - 60_000) return s.next_run_at;
  return nextRuns(s.spec, 1, now)[0];
}

/** 定时任务的归属部门 */
function deptOfOwner(owner: string): string | undefined {
  const [kind, id] = owner.split(":");
  if (kind === "dept") return id;
  if (kind === "post") return id?.split(".")[0];
  return undefined;
}

export default function SchedulesPage() {
  const r = useRegistry();
  const now = useNow(30_000);
  const q = useQuery(() => hub.schedules(), [], { watch: ["schedule."], interval: 60_000 });
  const [tab, setTab] = useState<TabKey>("all");
  const [postFilter, setPostFilter] = useState("");
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [history, setHistory] = useState<Schedule | null>(null);

  const list = q.data ?? [];
  const stats = useMemo(() => {
    const active = list.filter((s) => s.status === "active" && s.enabled).length;
    const pending = list.filter((s) => s.status === "pending_approval").length;
    const missed = list.reduce((a, s) => a + s.missed_count, 0);
    const soon = list.map((s) => nextRunOf(s, now)).filter((t): t is number => !!t && t - now < 3_600_000).length;
    return { active, pending, missed, soon };
  }, [list, now]);

  const postsWithSchedules = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list) if (s.owner.startsWith("post:")) m.set(s.owner.slice(5), (m.get(s.owner.slice(5)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);

  return (
    <div className="page ops-page">
      <PageHead
        title="定时任务"
        lede="司辰掌漏刻：官员与部门的定时差遣，时区 Asia/Shanghai；最小间隔五分钟，十五分钟以下须长官批准。"
        actions={
          <button className="btn primary" onClick={() => setEditing("new")}>
            <span className="display">＋</span> 新立定时
          </button>
        }
      />

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="在运行" value={stats.active} unit="条" sub={`共 ${list.length} 条`} tone="jade" />
        <Stat label="一时辰内将触发" value={stats.soon} unit="次" tone="azure" />
        <Stat label="待批" value={stats.pending} unit="条" sub="Agent 所立高频任务" />
        <Stat label="累计跳过" value={stats.missed} unit="次" sub="前次触发尚未办理" tone="red" />
      </div>

      <HeatStrip schedules={list} now={now} />

      <Tabs<TabKey>
        tabs={[
          { key: "all", label: "全局" },
          { key: "dept", label: "按部门" },
          { key: "post", label: "按官员" },
        ]}
        value={tab}
        onChange={setTab}
      />

      <QueryView q={q} empty={<Empty text="尚无定时任务。朝廷初立，可点「新立定时」。" seal="漏" />}>
        {(data) => {
          if (tab === "all")
            return (
              <Card flush>
                <ScheduleTable rows={data} now={now} onEdit={setEditing} onHistory={setHistory} reload={q.reload} />
              </Card>
            );
          if (tab === "dept")
            return (
              <div className="stack">
                {r.depts.length === 0 && <Empty text="名册未载入" />}
                {[...r.depts.map((d) => d.id as string), "__other"].map((d) => {
                  const rows = data.filter((s) => (d === "__other" ? !deptOfOwner(s.owner) || !r.dept(deptOfOwner(s.owner)!) : deptOfOwner(s.owner) === d));
                  if (rows.length === 0) return null;
                  const deptOwned = rows.filter((s) => s.owner === `dept:${d}`).length;
                  return (
                    <Card
                      key={d}
                      flush
                      title={
                        <>
                          {d !== "__other" && <Seal text={DEPT_SEAL[d] ?? "部"} size={22} tone="red" />}
                          {d === "__other" ? "其他" : r.deptName(d)}
                        </>
                      }
                      sub={`部门 ${deptOwned} 条 · 官员 ${rows.length - deptOwned} 条`}
                    >
                      <ScheduleTable rows={rows} now={now} onEdit={setEditing} onHistory={setHistory} reload={q.reload} />
                    </Card>
                  );
                })}
              </div>
            );
          const rows = postFilter ? data.filter((s) => s.owner === `post:${postFilter}`) : data.filter((s) => s.owner.startsWith("post:"));
          return (
            <>
              <div className="toolbar">
                <div style={{ width: 320 }}>
                  <PostPicker value={postFilter} onChange={setPostFilter} mode="post" includeDepts={false} placeholder="择一官员…" />
                </div>
                {postFilter && (
                  <button className="btn sm ghost" onClick={() => setPostFilter("")}>
                    清除
                  </button>
                )}
                <div className="row wrap" style={{ gap: 4 }}>
                  {postsWithSchedules.slice(0, 12).map(([p, n]) => (
                    <button key={p} className={`btn sm ${p === postFilter ? "gold" : "ghost"}`} onClick={() => setPostFilter(p)}>
                      {r.postLabel(p)} <span className="muted num">{n}</span>
                    </button>
                  ))}
                </div>
              </div>
              <Card flush>
                {rows.length === 0 ? (
                  <Empty text="此官员名下无定时任务" />
                ) : (
                  <ScheduleTable rows={rows} now={now} onEdit={setEditing} onHistory={setHistory} reload={q.reload} />
                )}
              </Card>
            </>
          );
        }}
      </QueryView>

      {editing && (
        <ScheduleForm
          initial={editing === "new" ? undefined : editing}
          defaultOwner={tab === "post" && postFilter ? `post:${postFilter}` : ""}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            q.reload();
          }}
        />
      )}
      {history && <HistoryDrawer schedule={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

// ───────── 表格 ─────────
function ScheduleTable({
  rows,
  now,
  onEdit,
  onHistory,
  reload,
}: {
  rows: Schedule[];
  now: number;
  onEdit: (s: Schedule) => void;
  onHistory: (s: Schedule) => void;
  reload: () => void;
}) {
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const sorted = useMemo(() => [...rows].sort((a, b) => (nextRunOf(a, now) ?? Infinity) - (nextRunOf(b, now) ?? Infinity)), [rows, now]);
  const toggle = async (s: Schedule) => {
    const res = await run(() => hub.updateSchedule(s.id, { actor: "emperor", enabled: !s.enabled }), s.enabled ? "已暂停" : "已启用");
    if (res) reload();
  };
  const trigger = async (s: Schedule) => {
    const res = await run(() => hub.triggerSchedule(s.id, "emperor"), `已触发「${s.title}」`);
    if (res) reload();
  };
  const remove = async (s: Schedule) => {
    const ok = await confirm({ title: "撤销定时任务", body: <>撤销「{s.title}」？此后不再触发，历史保留。</>, okText: "撤销", danger: true });
    if (!ok) return;
    const res = await run(() => hub.deleteSchedule(s.id, "emperor"), "已撤销");
    if (res) reload();
  };
  return (
    <div className="table-wrap">
      <table className="tbl sched-tbl">
        <thead>
          <tr>
            <th>归属</th>
            <th>名目</th>
            <th>规则</th>
            <th>下次</th>
            <th>上次</th>
            <th className="num">次数</th>
            <th className="num">跳过</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const next = nextRunOf(s, now);
            const st = SCHEDULE_STATUS[s.status] ?? { label: s.status, tone: "" as Tone };
            return (
              <tr key={s.id} className={s.enabled ? "" : "sched-off"}>
                <td className="nowrap">
                  <div className="row" style={{ gap: 6 }}>
                    <span className={`tag ${s.owner.startsWith("dept:") ? "azure" : ""} outline`}>{s.owner.startsWith("dept:") ? "部" : "官"}</span>
                    <Addr a={s.owner} />
                  </div>
                </td>
                <td>
                  <div className="serif">{s.title}</div>
                  <div className="muted small clamp-2" title={s.payload}>
                    {s.payload}
                  </div>
                </td>
                <td className="sched-spec">
                  <div className="nowrap">{describeSpec(s.spec)}</div>
                  <div className="mono muted small">{s.spec.cron ?? (s.spec.every_seconds ? `every ${s.spec.every_seconds}s` : s.spec.at ? "at" : "")}</div>
                  {s.jitter_seconds > 0 && <div className="muted small">抖动 ±{s.jitter_seconds}s</div>}
                </td>
                <td className="nowrap">
                  {next ? (
                    <>
                      <div className="num">{fmtDateTime(next)}</div>
                      <div className={`small ${next - now < 3_600_000 ? "next-soon" : "muted"}`}>{fmtAgo(next, now)}</div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="nowrap small">
                  <TimeAgo ms={s.last_run_at} />
                </td>
                <td className="num">{s.run_count}</td>
                <td className="num">{s.missed_count > 0 ? <span className="tag gold">{s.missed_count}</span> : <span className="muted">0</span>}</td>
                <td>
                  <Tag tone={st.tone}>{st.label}</Tag>
                  {s.expires_at && <div className="muted small">止于 {fmtDateTime(s.expires_at)}</div>}
                </td>
                <td>
                  <div className="btn-row nowrap" style={{ flexWrap: "nowrap" }}>
                    <button className="btn sm" disabled={pending || s.status === "pending_approval"} onClick={() => toggle(s)} title={s.enabled ? "暂停" : "启用"}>
                      {s.enabled ? "停" : "启"}
                    </button>
                    <button className="btn sm gold" disabled={pending} onClick={() => trigger(s)} title="立即触发">
                      即发
                    </button>
                    <button className="btn sm ghost" onClick={() => onHistory(s)}>
                      历
                    </button>
                    <button className="btn sm ghost" onClick={() => onEdit(s)}>
                      改
                    </button>
                    <button className="btn sm ghost danger" disabled={pending} onClick={() => remove(s)}>
                      撤
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────── 未来 24h 热图 ─────────
function HeatStrip({ schedules, now }: { schedules: Schedule[]; now: number }) {
  const t = useTip();
  const r = useRegistry();
  const BUCKET = 30 * 60_000;
  const start = Math.floor(now / BUCKET) * BUCKET;
  const buckets = useMemo(() => {
    const out: { at: number; items: { title: string; owner: string; t: number }[] }[] = Array.from({ length: 48 }, (_, i) => ({ at: start + i * BUCKET, items: [] }));
    const end = start + 48 * BUCKET;
    for (const s of schedules) {
      if (!s.enabled || s.status !== "active") continue;
      let runs = runsBetween(s.spec, now, end, 300);
      if (runs.length === 0 && s.next_run_at && s.next_run_at >= now && s.next_run_at < end) runs = [s.next_run_at];
      for (const x of runs) {
        const i = Math.floor((x - start) / BUCKET);
        if (i >= 0 && i < 48) out[i].items.push({ title: s.title, owner: s.owner, t: x });
      }
    }
    return out;
  }, [schedules, now, start, BUCKET]);
  const max = Math.max(1, ...buckets.map((b) => b.items.length));
  const total = buckets.reduce((a, b) => a + b.items.length, 0);
  return (
    <Card title="未来十二时辰" sub={`共 ${total} 次触发 · 每格半个时辰`} className="heat-card" style={{ marginBottom: 16 }}>
      <div className="heatstrip" onMouseLeave={t.hide}>
        {buckets.map((b, i) => (
          <div
            key={b.at}
            className={`hs-cell ${i === 0 ? "now" : ""}`}
            style={{ background: seqColor(b.items.length, max) }}
            onMouseMove={(e) =>
              t.show(
                e,
                <div>
                  <div style={{ marginBottom: 3 }}>
                    {fmtTime(b.at).slice(0, 5)}–{fmtTime(b.at + BUCKET).slice(0, 5)} · {b.items.length} 次
                  </div>
                  {b.items.slice(0, 8).map((x, k) => (
                    <div key={k} className="small">
                      {fmtTime(x.t).slice(0, 5)} {x.title}（{r.addrLabel(x.owner)}）
                    </div>
                  ))}
                  {b.items.length > 8 && <div className="small">…另 {b.items.length - 8} 次</div>}
                </div>,
              )
            }
          >
            {b.items.length > 0 ? b.items.length : ""}
          </div>
        ))}
      </div>
      <div className="hs-axis">
        {buckets.map((b, i) =>
          i % 6 === 0 ? (
            <span key={b.at} style={{ left: `${(i / 48) * 100}%` }}>
              {fmtTime(b.at).slice(0, 5)}
            </span>
          ) : null,
        )}
      </div>
      {t.node}
    </Card>
  );
}

// ───────── 新建 / 修改 ─────────
type Mode = "cron" | "every" | "at";

/** datetime-local（按上海时间理解）→ 毫秒 */
function fromLocalInput(v: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3_600_000;
}
function toLocalInput(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms + 8 * 3_600_000);
  return d.toISOString().slice(0, 16);
}

function ScheduleForm({ initial, defaultOwner, onClose, onSaved }: { initial?: Schedule; defaultOwner: string; onClose: () => void; onSaved: () => void }) {
  const { run, pending } = useAction();
  const [owner, setOwner] = useState(initial?.owner ?? defaultOwner);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [payload, setPayload] = useState(initial?.payload ?? "");
  const [mode, setMode] = useState<Mode>(initial?.spec.every_seconds ? "every" : initial?.spec.at ? "at" : "cron");
  const [cron, setCron] = useState(initial?.spec.cron ?? "0 8 * * *");
  const [everyMin, setEveryMin] = useState(initial?.spec.every_seconds ? String(initial.spec.every_seconds / 60) : "60");
  const [at, setAt] = useState(toLocalInput(initial?.spec.at ?? Date.now() + 3_600_000));
  const [jitter, setJitter] = useState(String(initial?.jitter_seconds ?? 0));
  const [expires, setExpires] = useState(toLocalInput(initial?.expires_at));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const spec: ScheduleSpec | null = useMemo(() => {
    if (mode === "cron") return validateCron(cron) ? null : { cron: cron.trim() };
    if (mode === "every") {
      const n = Number(everyMin);
      return n > 0 ? { every_seconds: Math.round(n * 60) } : null;
    }
    const t = fromLocalInput(at);
    return t ? { at: t } : null;
  }, [mode, cron, everyMin, at]);
  const cronErr = mode === "cron" ? validateCron(cron) : null;
  const preview = spec ? nextRuns(spec, 5) : [];
  const minGap = spec && mode !== "at" ? minIntervalSeconds(spec) : null;
  const atPast = mode === "at" && spec?.at !== undefined && spec.at < Date.now();
  const canSave = !!owner && !!title.trim() && !!spec && !pending && (minGap === null || minGap >= 300);

  const save = async () => {
    if (!spec) return;
    const expires_at = fromLocalInput(expires);
    const res = initial
      ? await run(
          () =>
            hub.updateSchedule(initial.id, {
              actor: "emperor",
              title: title.trim(),
              spec,
              payload,
              enabled,
              jitter_seconds: Number(jitter) || 0,
              expires_at: expires_at ?? null,
            }),
          "定时已改",
        )
      : await run(
          () =>
            hub.createSchedule({
              actor: "emperor",
              owner,
              title: title.trim(),
              spec,
              tz: "Asia/Shanghai",
              jitter_seconds: Number(jitter) || 0,
              payload,
              expires_at,
              enabled,
            }),
          "定时已立",
        );
    if (res) onSaved();
  };

  return (
    <Drawer open onClose={onClose} title={initial ? `修改定时 · ${initial.title}` : "新立定时"} width={600}>
      <div className="field">
        <span className="label">归属（官员醒来自办 / 部门按路由分派一人）</span>
        {initial ? (
          <div className="row">
            <Addr a={owner} />
            <span className="muted small">（归属不可改，如需改请撤销后重立）</span>
          </div>
        ) : (
          <PostPicker value={owner} onChange={setOwner} />
        )}
      </div>
      <label className="field">
        <span className="label">名目</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：早朝汇总" />
      </label>
      <label className="field">
        <span className="label">差遣内容（触发时投递给归属者的正文）</span>
        <textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={3} placeholder="汇总昨日诏令、任务与异常，向陛下奏报。" />
      </label>

      <div className="field">
        <span className="label">规则</span>
        <Seg<Mode>
          options={[
            { key: "cron", label: "Cron 五段" },
            { key: "every", label: "固定间隔" },
            { key: "at", label: "一次" },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>
      {mode === "cron" && (
        <>
          <div className="field">
            <div className="row">
              <input className="mono grow" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="分 时 日 月 周" spellCheck={false} />
              <select value="" onChange={(e) => e.target.value && setCron(e.target.value)} style={{ width: 180 }}>
                <option value="">常用…</option>
                {CRON_PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {cronErr ? <span className="hint" style={{ color: "var(--bad)" }}>{cronErr}</span> : <span className="hint">{describeSpec({ cron })} · 时区 Asia/Shanghai</span>}
          </div>
          <div className="preset-chips">
            {CRON_PRESETS.map((p) => (
              <button key={p.cron} className={`btn sm ${cron.trim() === p.cron ? "gold" : "ghost"}`} onClick={() => setCron(p.cron)} type="button">
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
      {mode === "every" && (
        <label className="field">
          <span className="label">间隔（分钟）</span>
          <input type="number" min={5} value={everyMin} onChange={(e) => setEveryMin(e.target.value)} />
        </label>
      )}
      {mode === "at" && (
        <label className="field">
          <span className="label">触发时刻（上海时间）</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          {atPast && <span className="hint" style={{ color: "var(--bad)" }}>此时刻已过</span>}
        </label>
      )}

      <div className="grid g2" style={{ gap: 12 }}>
        <label className="field">
          <span className="label">抖动（秒）</span>
          <input type="number" min={0} value={jitter} onChange={(e) => setJitter(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">止于（可空）</span>
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
      </div>
      <label className="row" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 立即启用
      </label>

      <div className="next-runs">
        <div className="nr-title serif">下五次运行</div>
        {preview.length === 0 ? (
          <div className="muted small">{spec ? "无后续运行" : "规则未完整"}</div>
        ) : (
          <ol>
            {preview.map((t, i) => (
              <li key={t}>
                <span className="nr-idx">{["一", "二", "三", "四", "五"][i]}</span>
                <span className="num">{fmtDateTime(t)}</span>
                <span className="muted small">{fmtAgo(t)}</span>
              </li>
            ))}
          </ol>
        )}
        {minGap !== null && minGap < 300 && (
          <div className="warn-line bad">
            <Seal text="驳" tone="red" size={20} /> 最小间隔 {fmtDuration(minGap * 1000)}，低于皇城下限五分钟，hub 将拒绝。
          </div>
        )}
        {minGap !== null && minGap >= 300 && minGap < 900 && (
          <div className="warn-line">
            <Seal text="批" tone="gold" size={20} /> 最小间隔 {fmtDuration(minGap * 1000)}，低于十五分钟：官员自立须长官批准（陛下所立不受此限）。
          </div>
        )}
      </div>

      <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn" onClick={onClose}>
          且慢
        </button>
        <button className="btn primary" disabled={!canSave} onClick={save}>
          {initial ? "改定" : "立定时"}
        </button>
      </div>
    </Drawer>
  );
}

// ───────── 运行历史 ─────────
function HistoryDrawer({ schedule, onClose }: { schedule: Schedule; onClose: () => void }) {
  const q = useQuery(() => hub.scheduleRuns(schedule.id), [schedule.id], { watch: ["schedule."] });
  return (
    <Drawer open onClose={onClose} title={`运行历史 · ${schedule.title}`} width={680}>
      <dl className="kv" style={{ marginBottom: 14 }}>
        <dt>归属</dt>
        <dd>
          <Addr a={schedule.owner} />
        </dd>
        <dt>规则</dt>
        <dd>
          {describeSpec(schedule.spec)} <span className="mono muted">{schedule.spec.cron}</span>
        </dd>
        <dt>立者</dt>
        <dd>
          <Addr a={schedule.created_by} />
        </dd>
        <dt>累计</dt>
        <dd>
          运行 {schedule.run_count} 次 · 跳过 {schedule.missed_count} 次
        </dd>
      </dl>
      <QueryView q={q} empty={<Empty text="尚未运行过" seal="漏" />}>
        {(runs) => (
          <table className="tbl">
            <thead>
              <tr>
                <th>应发</th>
                <th>实发</th>
                <th>迟</th>
                <th>结果</th>
                <th>追踪</th>
              </tr>
            </thead>
            <tbody>
              {[...runs]
                .sort((a, b) => b.fired_at - a.fired_at)
                .map((x) => {
                  const o = OUTCOME[x.outcome] ?? { label: x.outcome, tone: "" as Tone };
                  return (
                    <tr key={x.id}>
                      <td className="mono small">{fmtDateTime(x.scheduled_at)}</td>
                      <td className="mono small">{fmtDateTime(x.fired_at)}</td>
                      <td className="mono small muted">{fmtDuration(Math.max(0, x.fired_at - x.scheduled_at))}</td>
                      <td>
                        <Tag tone={o.tone}>{o.label}</Tag>
                      </td>
                      <td className="small">
                        <TraceLink id={x.trace_id} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </QueryView>
    </Drawer>
  );
}
