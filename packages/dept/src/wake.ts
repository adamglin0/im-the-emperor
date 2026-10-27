// 唤醒与等待：等待条件持久化、等待过滤、打断规则、唤醒信号。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InboxItem, Message, PostDef, WaitFilter } from "@court/shared";

export interface WaitState {
  /** 计时唤醒点（epoch ms） */
  next_wake_at: number;
  wait_filter?: WaitFilter;
  /** wait：等待过滤命中或打断即醒；sleep：只有打断能醒 */
  mode: "wait" | "sleep";
  /** 是否由官员自己（sleep/wait_for 工具）设定。默认等待超时且无事时不调 LLM */
  agent_set: boolean;
  /** 空闲退避倍数（默认等待超时无事时 ×2） */
  idle_backoff: number;
  /** 已确认（处理该批消息的轮已持久化）的收件 seq */
  acked_seq: number;
  /** 设定原因（sleep reason / wait 说明） */
  reason?: string;
  /** 落盘时的职位（调岗后游标/等待条件不沿用） */
  post_id?: string;
}

export function defaultWaitState(post: PostDef, ackedSeq = 0, now = Date.now()): WaitState {
  return { next_wake_at: now + post.default_wait_seconds * 1000, mode: "wait", agent_set: false, idle_backoff: 1, acked_seq: ackedSeq };
}

/** state.json 原子读写 */
export class WaitStateStore {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  load(): WaitState | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WaitState>;
      return {
        next_wake_at: Number(s.next_wake_at ?? 0),
        wait_filter: s.wait_filter,
        mode: s.mode === "sleep" ? "sleep" : "wait",
        agent_set: !!s.agent_set,
        idle_backoff: Math.max(1, Number(s.idle_backoff ?? 1)),
        acked_seq: Number(s.acked_seq ?? 0),
        reason: s.reason,
        post_id: typeof s.post_id === "string" ? s.post_id : undefined,
      };
    } catch {
      return undefined;
    }
  }

  save(s: WaitState): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.file);
  }
}

function isEmptyFilter(f: WaitFilter | undefined): boolean {
  if (!f) return true;
  return !f.from?.length && !f.kinds?.length && !f.trace_id && !f.reply_to && !f.notification_id;
}

/** 等待过滤：所列条件全部满足才算命中 */
export function matchesWaitFilter(f: WaitFilter, m: Message): boolean {
  if (f.from?.length && !f.from.includes(m.from)) return false;
  if (f.kinds?.length && !f.kinds.includes(m.kind)) return false;
  if (f.trace_id && m.trace_id !== f.trace_id) return false;
  if (f.reply_to) {
    const meta = m.meta ?? {};
    const hit = m.reply_to === f.reply_to || meta.reply_to === f.reply_to || meta.request_id === f.reply_to || m.thread_id === f.reply_to;
    if (!hit) return false;
  }
  if (f.notification_id) {
    const meta = m.meta ?? {};
    const hit = meta.notification_id === f.notification_id || m.reply_to === f.notification_id || m.body.includes(f.notification_id);
    if (!hit) return false;
  }
  return true;
}

/** 打断：按职位 interruptible_by（emperor | edict | urgent | any） */
export function isInterrupt(post: PostDef, m: Message): boolean {
  const by = post.interruptible_by ?? ["emperor", "edict", "urgent"];
  if (by.includes("any")) return true;
  if (by.includes("emperor") && m.from === "emperor") return true;
  if (by.includes("edict") && m.kind === "edict_notice") return true;
  if (by.includes("urgent") && m.priority === "urgent") return true;
  return false;
}

/** 某条新收件是否满足当前等待条件 */
export function shouldWakeFor(state: WaitState, post: PostDef, item: InboxItem): boolean {
  if (isInterrupt(post, item.message)) return true;
  if (state.mode === "sleep") return false;
  if (state.agent_set && !isEmptyFilter(state.wait_filter)) return matchesWaitFilter(state.wait_filter!, item.message);
  return item.delivery.wakes;
}

export function describeWait(state: WaitState): string {
  const left = Math.max(0, Math.round((state.next_wake_at - Date.now()) / 1000));
  if (state.mode === "sleep") return `睡眠中，${left} 秒后醒${state.reason ? `（${state.reason}）` : ""}`;
  if (state.agent_set && !isEmptyFilter(state.wait_filter)) return `等待 ${JSON.stringify(state.wait_filter)}，${left} 秒后超时`;
  return `候命（需本人处理之事），${left} 秒后例行醒来`;
}

/** 唤醒信号：kick 记录原因，wait 在到点/被踢/停止时返回 */
export class WakeSignal {
  private reasons = new Set<string>();
  private waiter?: () => void;

  kick(reason: string): void {
    this.reasons.add(reason);
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  get pending(): boolean {
    return this.reasons.size > 0;
  }

  /** 取走累计的唤醒原因 */
  drain(): string[] {
    const r = [...this.reasons];
    this.reasons.clear();
    return r;
  }

  /** 等到 untilMs 或被 kick；已有未取走的原因则立即返回 */
  wait(untilMs: number): Promise<void> {
    if (this.reasons.size) return Promise.resolve();
    const ms = Math.max(0, untilMs - Date.now());
    return new Promise((resolve) => {
      const t = setTimeout(done, Math.min(ms, 2 ** 31 - 1));
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.waiter === done) self.waiter = undefined;
        resolve();
      }
      this.waiter = done;
    });
  }
}
