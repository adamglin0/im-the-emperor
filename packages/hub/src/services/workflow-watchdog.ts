// 看门狗（确定性，每 30s）：租约过期改派、SLA 逐级上报、服务超时、复奏自动结案、议事发言超时。
// 逐级上报：承办人 → 部门长官 → 尚书都事（诏令为政事堂主持）→ 皇帝待办。每级只报一次（watchdog_marks 去重）。
import { SLA, type Address } from "@court/shared";
import { clip } from "./flow-util.ts";
import type { FlowEnv } from "./workflow-env.ts";
import type { CouncilFlow } from "./workflow-council.ts";
import type { EdictFlow } from "./workflow-edicts.ts";
import type { ServiceFlow } from "./workflow-services.ts";
import { taskSlaSeconds, type TaskFlow } from "./workflow-tasks.ts";
import type { EdictRow, TaskRow } from "./workflow-store.ts";

const ACTOR: Address = "system:watchdog";
const REPORTED_AUTOCOMPLETE_MS = 24 * 3600_000;
const MAX_LEVEL = 4;
const BUSY_STATES = new Set(["thinking", "tool"]);

const EDICT_STAGE_DEPT: Record<string, string> = { drafting: "zhongshu", reviewing: "menxia", approved: "shangshu", executing: "shangshu" };

export function createWatchdog(env: FlowEnv, flows: { council: CouncilFlow; edicts: EdictFlow; tasks: TaskFlow; services: ServiceFlow }) {
  const { ctx, store } = env;
  const reg = () => ctx.registry;

  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        env.emit("watchdog.error", ACTOR, `看门狗处理 ${what} 出错：${clip((e as Error).message ?? String(e), 300)}`);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 超期级别：首次超期为 1，每多一个 SLA 周期 +1，封顶 4 */
  function levelOf(now: number, due: number, unitMs: number): number {
    if (now <= due) return 0;
    return Math.min(MAX_LEVEL, 1 + Math.floor((now - due) / Math.max(unitMs, 60_000)));
  }

  /** 当前负责人（诏令） */
  function edictOwner(e: EdictRow): string | undefined {
    if (e.state === "drafting") return e.awaiting_countersign ? reg().pickPost("zhongshu", ["head"]) : e.drafter_post;
    if (e.state === "reviewing") return e.reviewer_post;
    return e.dispatcher_post;
  }

  function taskOwner(t: TaskRow): string | undefined {
    return t.state === "submitted" ? t.verifier_post ?? t.assignee_post : t.assignee_post;
  }

  function escalate(subject: { type: "edict" | "task"; id: string; title: string; trace_id: string; owner?: string; dept: string; overdueMin: number; state: string }, level: number): void {
    const kind = subject.type === "edict" ? "edict_notice" : "task_notice";
    const label = subject.type === "edict" ? "诏令" : "任务";
    const base = `${label} ${subject.id}「${subject.title}」在「${subject.state}」阶段已超期约 ${subject.overdueMin} 分钟。经办：${subject.owner ?? "（无人）"}。`;
    const meta = { [`${subject.type}_id`]: subject.id, escalation_level: level };
    if (level === 1) {
      env.notify(subject.owner, kind, `【催办】${label}超期：${subject.title}`, `${base}\n请立即办理；如有阻碍请如实报告（受阻/请旨/转交）。`, { trace_id: subject.trace_id, priority: "high", meta });
    } else if (level === 2) {
      const head = env.headOf(subject.dept, subject.owner ? [subject.owner] : undefined);
      env.notify(head, kind, `【督办】下属${label}超期：${subject.title}`, `${base}\n请督促经办人，或改派他人。`, { trace_id: subject.trace_id, priority: "high", meta });
    } else if (level === 3) {
      const up = subject.type === "edict" ? reg().pickPost("zhengshitang", ["chair"]) : reg().pickPost("shangshu", ["duty"]) ?? reg().pickPost("shangshu", ["head"]);
      env.notify(up, kind, `【上报】${label}严重超期：${subject.title}`, `${base}\n已催办经办人及其长官仍未办结，请督办协调。`, { trace_id: subject.trace_id, priority: "urgent", meta });
    } else {
      env.askEmperor(
        {
          kind: "action_required",
          category: "escalation",
          title: `超期上报：${subject.title}`,
          body: `${base}\n已逐级催办（经办人 → 长官 → ${subject.type === "edict" ? "政事堂" : "尚书都事"}）仍未办结，奏请陛下定夺。`,
          from: ACTOR,
          related: { type: subject.type, id: subject.id },
          options: [
            { id: "urge", label: "严旨督办" },
            { id: subject.type === "edict" ? "withdraw" : "cancel", label: subject.type === "edict" ? "撤回诏令" : "取消任务" },
            { id: "ignore", label: "知道了" },
          ],
          dedupe_key: `sla:${subject.type}:${subject.id}:${subject.state}`,
          trace_id: subject.trace_id,
        },
        { type: "sla", subject_type: subject.type, subject_id: subject.id },
      );
    }
    env.emit(`${subject.type}.sla_escalated`, ACTOR, `${label}超期上报 L${level}：${clip(subject.title, 60)}`, {
      trace_id: subject.trace_id,
      subject_type: subject.type,
      subject_id: subject.id,
      data: { level, owner: subject.owner },
    });
  }

  /**
   * 逐级上报：每次最多升一级，且两级之间至少间隔一个 SLA 周期。
   * 否则 hub 停机/休眠恢复后，所有超期事项会一次跳到 L4，瞬间刷满皇帝待办。
   */
  function ladder(key: string, level: number, unitMs: number, fire: (level: number) => void): void {
    if (level <= 0) return;
    const prev = store.getMark(key);
    const prevLevel = prev?.level ?? 0;
    if (level <= prevLevel) return;
    if (prev && env.now() - prev.at < unitMs) return;
    const next = prevLevel + 1;
    ctx.db.tx(() => {
      fire(next);
      store.setMark(key, next, env.now());
    });
  }

  function tickEdicts(now: number, busyTrace: Map<string, string | undefined>): void {
    for (const e of store.listEdictsInStates(["drafting", "reviewing", "approved", "executing", "reported"])) {
      guard(`诏令 ${e.id}`, () => {
        if (e.state === "reported") {
          if (now - e.state_entered_at > REPORTED_AUTOCOMPLETE_MS) flows.edicts.autoComplete(e.id, ACTOR);
          return;
        }
        if (e.lease_until && e.lease_until < now && e.state !== "executing") {
          const busy = new Set([...busyTrace].filter(([, tr]) => tr === e.id).map(([p]) => p));
          flows.edicts.reassignStale(e.id, busy, ACTOR);
        }
        if (e.state === "executing") flows.edicts.rehomeDispatcher(e.id, ACTOR);
        const cur = store.getEdict(e.id);
        if (!cur.sla_at || cur.state !== e.state) return;
        const unit = Math.max(cur.sla_at - cur.state_entered_at, SLA.lease * 1000);
        const level = levelOf(now, cur.sla_at, unit);
        ladder(`sla:edict:${cur.id}:${cur.state}:${cur.state_entered_at}`, level, unit, (lv) =>
          escalate(
            {
              type: "edict",
              id: cur.id,
              title: cur.title,
              trace_id: cur.id,
              owner: edictOwner(cur),
              dept: EDICT_STAGE_DEPT[cur.state] ?? "shangshu",
              overdueMin: Math.round((now - cur.sla_at!) / 60_000),
              state: cur.state,
            },
            lv,
          ),
        );
      });
    }
  }

  function tickTasks(now: number): void {
    for (const t of store.listOpenTasks()) {
      guard(`任务 ${t.id}`, () => {
        if (t.state === "pending") {
          flows.tasks.assignPending(t, ACTOR);
          return;
        }
        if (t.state === "assigned" && t.lease_until && t.lease_until < now) flows.tasks.reassignStale(t, ACTOR);
        if (t.state === "submitted" && t.lease_until && t.lease_until < now) flows.tasks.reassignVerifier(t, ACTOR);
        const cur = store.getTask(t.id);
        const slaSec = taskSlaSeconds(cur.state);
        if (!slaSec) return;
        const unit = slaSec * 1000;
        const inWork = cur.state === "in_progress" || cur.state === "blocked" || cur.state === "returned";
        const due = inWork && cur.deadline ? cur.deadline : cur.state_entered_at + unit;
        const level = levelOf(now, due, unit);
        ladder(`sla:task:${cur.id}:${cur.state}:${cur.state_entered_at}:${cur.deadline ?? 0}`, level, unit, (lv) =>
          escalate(
            {
              type: "task",
              id: cur.id,
              title: cur.title,
              trace_id: cur.trace_id,
              owner: taskOwner(cur),
              dept: cur.dept,
              overdueMin: Math.round((now - due) / 60_000),
              state: cur.state,
            },
            lv,
          ),
        );
      });
    }
  }

  function tickServices(now: number): void {
    for (const r of store.listPendingServiceRequests()) {
      if (r.sla_at > now) continue;
      guard(`服务请求 ${r.id}`, () => {
        flows.services.expire(r.id, now);
      });
    }
  }

  function tickCouncil(now: number): void {
    for (const d of flows.council.listOpen()) {
      guard(`议事 ${d.id}`, () => {
        if (!flows.council.autoPassIfStale(d, now, SLA.council_turn * 1000)) flows.council.chairStale(d, now, SLA.council_turn * 1000);
      });
    }
  }

  return {
    tick(now: number): void {
      const busyTrace = new Map<string, string | undefined>();
      try {
        for (const s of ctx.statuses()) if (BUSY_STATES.has(s.state)) busyTrace.set(s.post_id, s.current_trace_id);
      } catch {
        /* 心跳不可用时按无人忙碌处理 */
      }
      tickCouncil(now);
      tickEdicts(now, busyTrace);
      tickTasks(now);
      tickServices(now);
    },
    edictOwner,
    taskOwner,
  };
}

export type Watchdog = ReturnType<typeof createWatchdog>;
