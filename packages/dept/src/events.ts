// 事件：outbox 镜像到 hub（只追加、可重放、hub 按 uid 去重）+ 本地实时广播（官员 SSE 流）。
import { newId, type EventIn, type Outbox } from "@court/shared";

export interface LiveEvent {
  type: string;
  post: string;
  ts: number;
  data?: Record<string, unknown>;
}

type LiveListener = (e: LiveEvent) => void;

/** 官员实时事件总线（/officials/:post/stream 的数据源） */
export class LiveBus {
  private subs = new Map<string, Set<LiveListener>>();
  /** 任一官员状态变化（type=state）时回调：运行时据此提前发心跳，让朝堂及时看到 */
  onState?: (post: string) => void;

  subscribe(post: string, fn: LiveListener): () => void {
    let set = this.subs.get(post);
    if (!set) this.subs.set(post, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.subs.delete(post);
    };
  }

  publish(post: string, type: string, data?: Record<string, unknown>): void {
    if (type === "state") {
      try {
        this.onState?.(post);
      } catch {
        /* 忽略 */
      }
    }
    const set = this.subs.get(post);
    if (!set?.size) return;
    const e: LiveEvent = { type, post, ts: Date.now(), data };
    for (const fn of set) {
      try {
        fn(e);
      } catch {
        /* 订阅者异常不影响运行时 */
      }
    }
  }

  subscriberCount(post: string): number {
    return this.subs.get(post)?.size ?? 0;
  }
}

export type EventDraft = Omit<EventIn, "uid" | "ts" | "dept"> & { uid?: string; ts?: number };

/** 部门事件出口（写 outbox） */
export class DeptEvents {
  constructor(
    readonly outbox: Outbox<EventIn>,
    readonly dept: string,
  ) {}

  emit(e: EventDraft): void {
    try {
      this.outbox.push({ ...e, uid: e.uid ?? newId("ev"), ts: e.ts ?? Date.now(), dept: this.dept });
    } catch {
      /* 磁盘写失败不影响官员运行 */
    }
  }
}
