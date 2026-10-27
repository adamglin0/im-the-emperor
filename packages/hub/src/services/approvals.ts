// 审批：配置/人事/定时/资产访问/预算等敏感事项 → 皇帝待办（准/驳）→ 准则执行。
import { newId, type Address, type Approval, type Notification } from "@court/shared";
import { bad, type ApprovalService, type HubCtx } from "../ctx.ts";

export const APPROVAL_OPTIONS = [
  { id: "approve", label: "准" },
  { id: "reject", label: "驳" },
];

export interface ApprovalServiceExt extends ApprovalService {
  get(id: string): Approval | undefined;
  /** 注册驳回后的清理（例如待批定时任务作废） */
  onReject(type: Approval["type"], fn: (a: Approval) => void): void;
  list(status?: string, limit?: number): Approval[];
}

export function createApprovals(ctx: HubCtx): ApprovalServiceExt {
  const appliers = new Map<Approval["type"], (a: Approval) => void>();
  const rejecters = new Map<Approval["type"], (a: Approval) => void>();

  function getA(id: string): Approval | undefined {
    return ctx.db.getJson<Approval>("SELECT data_json FROM approvals WHERE id = ?", id);
  }
  function save(a: Approval): void {
    ctx.db.run(
      `INSERT INTO approvals (id, status, type, notification_id, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data_json = excluded.data_json`,
      a.id,
      a.status,
      a.type,
      a.notification_id,
      a.created_at,
      JSON.stringify(a),
    );
  }

  function onDecision(n: Notification, option: string, comment: string): void {
    if (n.related?.type !== "approval") return;
    const a = getA(n.related.id);
    if (!a || a.status !== "pending") return;
    const approved = option === "approve";
    const decided: Approval = { ...a, status: approved ? "approved" : "rejected", decided_at: ctx.now() };
    save(decided);
    if (approved) {
      const apply = appliers.get(a.type);
      try {
        // 执行器失败不阻断批复（否则陛下无法处理该待办），改为告知申请人
        ctx.db.tx(() => apply?.(decided));
      } catch (e) {
        const msg = (e as Error).message;
        save({ ...decided, payload: { ...decided.payload, apply_error: msg } });
        ctx.events.emit({ type: "approval.apply_failed", actor: "system:hub", subject_type: "approval", subject_id: a.id, summary: `审批已准但执行失败：${msg}`.slice(0, 300) });
        if (a.requested_by.startsWith("post:")) {
          ctx.messages.notifyPost(a.requested_by.slice(5), "system", `审批执行失败：${n.title}`.slice(0, 200), `陛下已准，但执行时出错：${msg}\n请核实现状后重新申请。`, {
            meta: { approval_id: a.id },
          });
        }
      }
    }
    if (!approved) rejecters.get(a.type)?.(decided);
    ctx.events.emit({
      type: approved ? "approval.approved" : "approval.rejected",
      actor: "emperor",
      subject_type: "approval",
      subject_id: a.id,
      summary: `${approved ? "准" : "驳"}：${n.title}${comment ? `（${comment}）` : ""}`.slice(0, 300),
      data: { type: a.type },
    });
  }

  ctx.notifications.onResolve("approval", onDecision);

  return {
    request(type: Approval["type"], payload: Record<string, unknown>, requestedBy: Address, title: string, body: string): Approval {
      if (!title?.trim()) throw bad("审批标题不能为空");
      return ctx.db.tx(() => {
        const id = newId("ap");
        const n = ctx.notifications.create({
          kind: "action_required",
          category: "approval",
          title: `【待批】${title}`.slice(0, 200),
          body,
          from: requestedBy,
          related: { type: "approval", id },
          options: APPROVAL_OPTIONS,
          trace_id: typeof payload.trace_id === "string" ? payload.trace_id : undefined,
        });
        const a: Approval = { id, type, payload, requested_by: requestedBy, status: "pending", notification_id: n.id, created_at: ctx.now() };
        save(a);
        ctx.events.emit({ type: "approval.requested", actor: requestedBy, subject_type: "approval", subject_id: id, summary: `申请审批（${type}）：${title}`.slice(0, 300) });
        return a;
      });
    },

    onApprove(type: Approval["type"], apply: (a: Approval) => void): void {
      appliers.set(type, apply);
    },

    get: getA,

    onReject(type: Approval["type"], fn: (a: Approval) => void): void {
      rejecters.set(type, fn);
    },

    list(status?: string, limit = 100): Approval[] {
      const lim = Math.max(1, Math.min(500, Math.floor(limit) || 100));
      if (status) return ctx.db.allJson<Approval>("SELECT data_json FROM approvals WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", status, lim);
      return ctx.db.allJson<Approval>("SELECT data_json FROM approvals ORDER BY created_at DESC, rowid DESC LIMIT ?", lim);
    },
  };
}
