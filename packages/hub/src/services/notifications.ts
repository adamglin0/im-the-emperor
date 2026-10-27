// 皇帝待办：创建（去重）、批复（类别处理器 + 回写发起人）、上奏限流。
import { LIMITS, newId, type Address, type Notification, type NotificationCategory } from "@court/shared";
import { bad, invalidState, notFound, rateLimited, type HubCtx, type NotificationService } from "../ctx.ts";

/** 官员可自行上奏的类别（petition 路由） */
export const PETITION_CATEGORIES: NotificationCategory[] = ["petition", "progress", "incident", "clarification"];
const HOUR_MS = 3600_000;

type Handler = (n: Notification, option: string, comment: string) => void;

export interface NotificationServiceExt extends NotificationService {
  /** fyi 知会的限流（每人每小时 petitionPerHour × 2） */
  checkFyiRate(from: Address): void;
}

export function createNotifications(ctx: HubCtx): NotificationServiceExt {
  const handlers = new Map<NotificationCategory, Handler[]>();

  function getN(id: string): Notification | undefined {
    return ctx.db.getJson<Notification>("SELECT data_json FROM notifications WHERE id = ?", id);
  }
  function save(n: Notification): void {
    ctx.db.run(
      `INSERT INTO notifications (id, status, kind, category, from_addr, dedupe_key, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data_json = excluded.data_json`,
      n.id,
      n.status,
      n.kind,
      n.category,
      n.from,
      n.dedupe_key ?? null,
      n.created_at,
      JSON.stringify(n),
    );
  }

  function countRecent(from: Address, kind: Notification["kind"]): number {
    const cats = PETITION_CATEGORIES.map(() => "?").join(",");
    return ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications WHERE from_addr = ? AND kind = ? AND category IN (${cats}) AND created_at > ?`,
      from,
      kind,
      ...PETITION_CATEGORIES,
      ctx.now() - HOUR_MS,
    )!.n;
  }

  const self: NotificationServiceExt = {
    create(input): Notification {
      if (!input.title?.trim()) throw bad("待办标题不能为空");
      return ctx.db.tx(() => {
        if (input.dedupe_key) {
          const dup = ctx.db.getJson<Notification>(
            "SELECT data_json FROM notifications WHERE dedupe_key = ? AND status = 'pending'",
            input.dedupe_key,
          );
          if (dup) return dup;
        }
        const n: Notification = {
          id: newId("nt"),
          kind: input.kind,
          category: input.category,
          title: input.title.trim().slice(0, 200),
          body: String(input.body ?? ""),
          from: input.from,
          options: input.options ?? [],
          status: input.status ?? "pending",
          created_at: ctx.now(),
        };
        if (input.related) n.related = input.related;
        if (input.resolution) n.resolution = input.resolution;
        if (input.dedupe_key) n.dedupe_key = input.dedupe_key;
        if (input.trace_id) n.trace_id = input.trace_id;
        save(n);
        let span_id: string | undefined;
        if (n.trace_id) {
          span_id = ctx.events.span({
            trace_id: n.trace_id,
            kind: "notification",
            name: n.title,
            actor: n.from,
            status: n.kind === "action_required" && n.status === "pending" ? "running" : "ok",
            ended_at: n.kind === "action_required" && n.status === "pending" ? undefined : n.created_at,
            attrs: { notification_id: n.id, category: n.category, kind: n.kind },
          });
        }
        ctx.events.emit({
          type: "notification.created",
          actor: n.from,
          trace_id: n.trace_id,
          span_id,
          subject_type: "notification",
          subject_id: n.id,
          summary: `${n.kind === "action_required" ? "待决" : "知会"}【${n.category}】${n.title}`,
          data: { kind: n.kind, category: n.category, related: n.related },
        });
        return n;
      });
    },

    get: getN,

    list(status?: string, limit = 100): Notification[] {
      const lim = Math.max(1, Math.min(500, Math.floor(limit) || 100));
      if (status) return ctx.db.allJson<Notification>("SELECT data_json FROM notifications WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", status, lim);
      return ctx.db.allJson<Notification>("SELECT data_json FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?", lim);
    },

    resolve(id: string, option: string, comment: string): Notification {
      if (typeof option !== "string" || !option) throw bad("请选择批复选项 option");
      const result = ctx.db.tx(() => {
        const n = getN(id);
        if (!n) throw notFound(`待办 ${id}`);
        if (n.status !== "pending") throw invalidState(`待办 ${id} 已处理（${n.status}），不能重复批复`);
        const dismiss = option === "dismiss";
        if (!dismiss && n.options.length && !n.options.some((o) => o.id === option)) {
          throw bad(`选项 ${option} 无效，可选：${n.options.map((o) => `${o.id}(${o.label})`).join("、")} 或 dismiss`);
        }
        const at = ctx.now();
        const done: Notification = { ...n, status: dismiss ? "dismissed" : "resolved", resolution: { option, comment: comment ?? "", at } };
        save(done);
        // 撤下审批类待办视同驳回，避免审批永远挂起
        if (!dismiss) for (const h of handlers.get(n.category) ?? []) h(done, option, comment ?? "");
        else if (n.category === "approval") for (const h of handlers.get(n.category) ?? []) h(done, "reject", comment ?? "");
        // 处理器可能改写了待办（例如附加信息），以库中最新为准
        const latest = getN(id) ?? done;
        const label = n.options.find((o) => o.id === option)?.label ?? (dismiss ? "撤下" : option);
        if (n.from.startsWith("post:") && !dismiss) {
          ctx.messages.notifyPost(
            n.from.slice(5),
            "notification_reply",
            `陛下批复：${n.title}`.slice(0, 200),
            `陛下对「${n.title}」的批复：${label}${comment ? `\n朱批：${comment}` : ""}`,
            { from: "emperor", trace_id: n.trace_id, meta: { notification_id: n.id, option, comment: comment ?? "" } },
          );
        }
        if (n.trace_id) {
          const sp = ctx.db.get<{ span_id: string }>(
            "SELECT span_id FROM spans WHERE trace_id = ? AND kind = 'notification' AND json_extract(data_json, '$.attrs.notification_id') = ? LIMIT 1",
            n.trace_id,
            n.id,
          );
          if (sp) ctx.events.endSpan(sp.span_id, option === "reject" ? "rejected" : "ok", { option });
        }
        ctx.events.emit({
          type: "notification.resolved",
          actor: "emperor",
          trace_id: n.trace_id,
          subject_type: "notification",
          subject_id: n.id,
          summary: `批复【${n.category}】${n.title}：${label}`,
          data: { option, comment: comment ?? "", category: n.category, related: n.related },
        });
        return latest;
      });
      return result;
    },

    onResolve(category: NotificationCategory, handler: Handler): void {
      const list = handlers.get(category) ?? [];
      list.push(handler);
      handlers.set(category, list);
    },

    checkPetitionRate(from: Address): void {
      const n = countRecent(from, "action_required");
      if (n >= LIMITS.petitionPerHour) {
        throw rateLimited(
          `你这一小时已上奏 ${n} 次（上限 ${LIMITS.petitionPerHour}）。请把后续事项合并成一本奏章，过一个时辰再奏；不急的事改用 report_progress 知会`,
        );
      }
    },

    checkFyiRate(from: Address): void {
      const n = countRecent(from, "fyi");
      const cap = LIMITS.petitionPerHour * 2;
      if (n >= cap) throw rateLimited(`你这一小时已知会陛下 ${n} 次（上限 ${cap}）。请合并成一份进展汇报，稍后再报`);
    },
  };
  return self;
}
