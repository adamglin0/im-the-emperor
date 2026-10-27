// 流程模块共享环境：ctx、数据层与常用动作（知会官员、奏请皇帝、事件）。
import type { Address, MessageKind, Notification, NotificationCategory, NotificationOption, Priority } from "@court/shared";
import type { HubCtx } from "../ctx.ts";
import { createFlowStore, ensureFlowTables, type FlowStore } from "./workflow-store.ts";

export interface NotifyOpts {
  trace_id?: string;
  wakes?: boolean;
  meta?: Record<string, unknown>;
  priority?: Priority;
  from?: Address;
}

export interface EmperorAsk {
  kind: Notification["kind"];
  category: NotificationCategory;
  title: string;
  body: string;
  from: Address;
  related?: { type: string; id: string };
  options: NotificationOption[];
  dedupe_key?: string;
  trace_id?: string;
}

export interface FlowEnv {
  ctx: HubCtx;
  store: FlowStore;
  now(): number;
  /** 知会某职位（post 为空则跳过） */
  notify(post: string | undefined, kind: MessageKind, subject: string, body: string, opts?: NotifyOpts): void;
  /** 奏请皇帝（皇帝待办），附带结构化载荷供批复处理器使用 */
  askEmperor(ask: EmperorAsk, payload?: Record<string, unknown>): Notification;
  hasRole(post: string | undefined, role: string): boolean;
  /** 部门长官（head 优先，其次 deputy） */
  headOf(dept: string, exclude?: string[]): string | undefined;
  emit(type: string, actor: Address, summary: string, extra?: { trace_id?: string; span_id?: string; subject_type?: string; subject_id?: string; data?: Record<string, unknown> }): void;
  /** 覆奏画可开关：环境变量 REQUIRE_FINAL_SIGN=1 或 meta 表 require_final_sign=1 */
  finalSignRequired(): boolean;
  /** 注册皇帝批复处理器（ctx.notifications 尚未就绪时延后注册） */
  onResolve(category: NotificationCategory, handler: (n: Notification, option: string, comment: string) => void): void;
}

export function createFlowEnv(ctx: HubCtx): FlowEnv {
  ensureFlowTables(ctx.db);
  const store = createFlowStore(ctx.db);
  const env: FlowEnv = {
    ctx,
    store,
    now: () => ctx.now(),
    notify(post, kind, subject, body, opts) {
      if (!post) return;
      ctx.messages.notifyPost(post, kind, subject, body, {
        trace_id: opts?.trace_id,
        wakes: opts?.wakes ?? true,
        meta: opts?.meta,
        priority: opts?.priority,
        from: opts?.from,
      });
    },
    askEmperor(ask, payload) {
      const n = ctx.notifications.create({
        kind: ask.kind,
        category: ask.category,
        title: ask.title,
        body: ask.body,
        from: ask.from,
        related: ask.related,
        options: ask.options,
        dedupe_key: ask.dedupe_key,
        trace_id: ask.trace_id,
      });
      if (payload) store.setPayload(n.id, payload);
      return n;
    },
    hasRole(post, role) {
      if (!post) return false;
      return ctx.registry.post(post)?.roles.includes(role) ?? false;
    },
    headOf(dept, exclude) {
      return ctx.registry.pickPost(dept, ["head", "deputy"], { exclude });
    },
    emit(type, actor, summary, extra) {
      ctx.events.emit({ type, actor, summary, ...extra });
    },
    finalSignRequired() {
      if (process.env.REQUIRE_FINAL_SIGN === "1") return true;
      try {
        return ctx.db.get<{ v: string }>("SELECT v FROM meta WHERE k = 'require_final_sign'")?.v === "1";
      } catch {
        return false;
      }
    },
    onResolve(category, handler) {
      const register = () => ctx.notifications.onResolve(category, handler);
      if (ctx.notifications) register();
      else queueMicrotask(register);
    },
  };
  return env;
}
