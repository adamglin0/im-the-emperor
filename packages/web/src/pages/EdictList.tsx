// 诏令列表：按状态分组筛选，奏折卡显示阶段、封驳次数、今日用度。
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Edict, EdictState } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { Addr, TimeAgo } from "../components/Addr.tsx";
import { PageHead } from "../components/Card.tsx";
import { StageBar } from "../components/StageBar.tsx";
import { Empty, QueryView } from "../components/States.tsx";
import { Seg } from "../components/Tabs.tsx";
import { EdictStateTag, Tag } from "../components/Tag.tsx";
import { useQuery } from "../hooks/useQuery.ts";
import { EDICT_TERMINAL } from "../lib/labels.ts";
import { fmtCost, fmtTokens, startOfTodayShanghai } from "../lib/format.ts";
import "../styles/pages/edict.css";

type Group = "active" | "attention" | "done" | "ended" | "all";
const GROUPS: { key: Group; label: string; test: (s: EdictState) => boolean }[] = [
  { key: "active", label: "进行中", test: (s) => !EDICT_TERMINAL.includes(s) },
  { key: "attention", label: "待圣裁", test: (s) => ["escalated", "remonstrated", "blocked_budget", "reported", "awaiting_sign"].includes(s) },
  { key: "done", label: "已完成", test: (s) => s === "completed" },
  { key: "ended", label: "撤回/失败", test: (s) => s === "withdrawn" || s === "failed" },
  { key: "all", label: "全部", test: () => true },
];

export default function EdictListPage() {
  const nav = useNavigate();
  const [group, setGroup] = useState<Group>("active");
  const [q, setQ] = useState("");
  const edicts = useQuery(() => hub.edicts({ limit: 300 }), [], { watch: ["edict."], interval: 30_000 });
  const cost = useQuery(() => hub.ledgerSummary({ group: "trace", since: startOfTodayShanghai() }), [], { watch: ["llm."], interval: 60_000 });
  const costMap = useMemo(() => new Map((cost.data ?? []).map((r) => [r.key, r])), [cost.data]);
  const counts = useMemo(() => Object.fromEntries(GROUPS.map((g) => [g.key, (edicts.data ?? []).filter((e) => g.test(e.state)).length])), [edicts.data]);

  const list = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group)!;
    const k = q.trim();
    return (edicts.data ?? [])
      .filter((e) => g.test(e.state))
      .filter((e) => !k || e.title.includes(k) || e.intent.includes(k) || e.id.includes(k))
      .sort((a, b) => urgency(b) - urgency(a) || b.created_at - a.created_at);
  }, [edicts.data, group, q]);

  return (
    <div className="page">
      <PageHead
        title="诏令"
        lede="圣旨自颁布至复奏的全程。点开一道，可查其执行图与泳道时序。"
        actions={
          <Link to="/decree" className="btn primary">
            颁新旨
          </Link>
        }
      />
      <div className="toolbar">
        <Seg options={GROUPS.map((g) => ({ key: g.key, label: `${g.label} ${counts[g.key] ?? 0}` }))} value={group} onChange={setGroup} />
        <input type="search" placeholder="按标题、圣意或 ID 检索" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
      </div>
      <QueryView
        q={edicts}
        isEmpty={() => list.length === 0}
        empty={
          <Empty text={edicts.data?.length ? "此类无诏令" : "朝廷初立，尚无诏令"} seal="诏">
            {!edicts.data?.length && (
              <Link to="/decree" className="btn sm">
                去颁第一道旨
              </Link>
            )}
          </Empty>
        }
      >
        {() => (
          <div className="edict-grid">
            {list.map((e) => {
              const c = costMap.get(e.id);
              return (
                <article key={e.id} className={`card memorial edict-card ${urgency(e) >= 2 ? "urgent" : ""}`} onClick={() => nav(`/edicts/${e.id}`)} tabIndex={0} onKeyDown={(ev) => ev.key === "Enter" && nav(`/edicts/${e.id}`)}>
                  <div className="ec-top">
                    <EdictStateTag state={e.state} />
                    {e.skip_review && <Tag tone="ink">墨敕</Tag>}
                    {e.reject_count > 0 && <Tag tone="red">↺ 驳×{e.reject_count}</Tag>}
                    <span className="grow" />
                    <span className="muted small">
                      <TimeAgo ms={e.created_at} />
                    </span>
                  </div>
                  <h3 className="ec-title">{e.title}</h3>
                  <p className="ec-intent clamp-2">{e.intent}</p>
                  <StageBar edict={e} compact />
                  <div className="ec-foot small">
                    <span title="今日用度" className="num">
                      {c ? `${fmtTokens(c.total_tokens)} · ${fmtCost(c.cost)}` : "今日无用度"}
                    </span>
                    {e.budget_tokens ? <span className="muted num">限 {fmtTokens(e.budget_tokens)}</span> : null}
                    <span className="grow" />
                    {e.deadline && !EDICT_TERMINAL.includes(e.state) && (
                      <span className={e.deadline < Date.now() ? "ec-overdue" : "muted"}>
                        限期 <TimeAgo ms={e.deadline} />
                      </span>
                    )}
                    {e.drafter_post && e.state === "drafting" && (
                      <span className="muted">
                        执笔 <Addr a={`post:${e.drafter_post}`} />
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </QueryView>
    </div>
  );
}

/** 需皇帝关注的排前 */
function urgency(e: Edict): number {
  if (["escalated", "blocked_budget", "remonstrated"].includes(e.state)) return 2;
  if (["reported", "awaiting_sign"].includes(e.state)) return 1;
  return 0;
}
