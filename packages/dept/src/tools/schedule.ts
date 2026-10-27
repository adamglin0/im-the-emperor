// 通用·定时任务工具（单一工具，按 action 分派）
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS, TZ, type Schedule, type ScheduleSpec } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { OWNERS, ownerAddr } from "./assets.ts";
import { ToolError, defineTool, fmtTime, ok, parseTime, selfAddr, writeMeta } from "./_util.ts";

const ACTIONS = ["create", "list", "update", "pause", "resume", "delete", "trigger_now", "history"] as const;

function scheduleRow(s: Schedule) {
  return {
    schedule_id: s.id,
    owner: s.owner,
    title: s.title,
    cron: s.spec.cron,
    every_seconds: s.spec.every_seconds,
    at: fmtTime(s.spec.at),
    status: s.status,
    enabled: s.enabled,
    next_run: fmtTime(s.next_run_at),
    last_run: fmtTime(s.last_run_at),
    runs: s.run_count,
    missed: s.missed_count || undefined,
    expires: fmtTime(s.expires_at),
    payload: s.payload.length > 200 ? `${s.payload.slice(0, 200)}…` : s.payload,
  };
}

const time = (description: string) => Type.Union([Type.String(), Type.Number()], { description });

export function scheduleTools(ctx: ToolContext): AgentTool<any>[] {
  const self = selfAddr(ctx);
  const min = LIMITS.scheduleMinIntervalSeconds;
  const approval = LIMITS.scheduleApprovalBelowSeconds;

  function specOf(p: { cron?: string; every_seconds?: number; at?: string | number }): ScheduleSpec | undefined {
    const n = [p.cron, p.every_seconds, p.at].filter((x) => x !== undefined && x !== "").length;
    if (n === 0) return undefined;
    if (n > 1) throw new ToolError("cron、every_seconds、at 只能三选一");
    if (p.every_seconds !== undefined && p.every_seconds < min) throw new ToolError(`间隔不得小于 ${min} 秒（5 分钟）`);
    if (p.cron !== undefined && p.cron.trim().split(/\s+/).length !== 5) throw new ToolError(`cron 须为 5 段（分 时 日 月 周），收到「${p.cron}」`, "例：每天 9 点 → 0 9 * * *（北京时间）。");
    if (p.at !== undefined) {
      const at = parseTime(p.at);
      if (at < Date.now()) throw new ToolError(`时间 ${fmtTime(at)} 已过去`);
      return { at };
    }
    return p.cron !== undefined ? { cron: p.cron.trim() } : { every_seconds: p.every_seconds };
  }

  return [
    defineTool({
      name: "schedule",
      label: "定时任务",
      description:
        "定时任务：到点唤醒你本人，或投递本部门收件箱。action：create（须 title、payload 及 cron/every_seconds/at 三选一）、list、update、pause、resume、delete、trigger_now、history；除 create/list 外须 schedule_id。" +
        `规则：cron 5 段北京时间；间隔 ≥${min / 60} 分钟，<${approval / 60} 分钟需长官批准；每所有者 ≤${LIMITS.schedulesPerOwner} 条；上次触发未处理则跳过。payload 写清到点要做什么。`,
      parameters: Type.Object({
        action: StringEnum(ACTIONS, { description: "操作" }),
        owner: Type.Optional(StringEnum(OWNERS, { description: "create/list 的归属，默认 self" })),
        schedule_id: Type.Optional(Type.String({ description: "定时任务 ID" })),
        title: Type.Optional(Type.String({ description: "标题" })),
        cron: Type.Optional(Type.String({ description: "5 段 cron（北京时间），如 0 9 * * 1-5" })),
        every_seconds: Type.Optional(Type.Integer({ minimum: min, description: `固定间隔秒数（≥${min}）` })),
        at: Type.Optional(time("一次性时间，如 2026-10-27 09:30（北京时间）或 epoch 毫秒")),
        payload: Type.Optional(Type.String({ description: "到点送达的内容（要做的事）" })),
        jitter_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600, description: "随机抖动秒数" })),
        expires_at: Type.Optional(time("过期停用时间（同 at 格式）")),
      }),
      async run(p, call) {
        const needId = () => {
          if (!p.schedule_id) throw new ToolError(`action=${p.action} 需要 schedule_id`, "可先 schedule {action: \"list\"} 查看。");
          return p.schedule_id;
        };
        switch (p.action) {
          case "create": {
            if (!p.title || !p.payload) throw new ToolError("create 需要 title 与 payload");
            const spec = specOf(p);
            if (!spec) throw new ToolError("create 需要 cron、every_seconds、at 之一");
            const s = await ctx.hub.createSchedule({
              ...writeMeta(ctx, call.toolCallId),
              actor: self,
              owner: ownerAddr(ctx, p.owner),
              title: p.title,
              spec,
              tz: TZ,
              jitter_seconds: p.jitter_seconds,
              payload: p.payload,
              expires_at: p.expires_at !== undefined ? parseTime(p.expires_at) : undefined,
            });
            return ok(
              `已建定时任务 ${s.id}「${s.title}」，状态 ${s.status}${s.status === "pending_approval" ? "（间隔较短，待长官批准）" : `，下次 ${fmtTime(s.next_run_at) ?? "—"}`}`,
              scheduleRow(s),
            );
          }
          case "list": {
            const owners = p.owner ? [ownerAddr(ctx, p.owner)] : [self, ownerAddr(ctx, "department")];
            const rows: ReturnType<typeof scheduleRow>[] = [];
            for (const o of owners) rows.push(...(await ctx.hub.schedules({ owner: o })).map(scheduleRow));
            return ok(`定时任务 ${rows.length} 条（${owners.join("、")}）`, rows);
          }
          case "update": {
            const id = needId();
            const spec = specOf(p);
            const s = await ctx.hub.updateSchedule(id, {
              ...writeMeta(ctx, call.toolCallId),
              actor: self,
              title: p.title,
              spec,
              payload: p.payload,
              jitter_seconds: p.jitter_seconds,
              expires_at: p.expires_at !== undefined ? parseTime(p.expires_at) : undefined,
            });
            return ok(`已更新定时任务 ${s.id}，状态 ${s.status}`, scheduleRow(s));
          }
          case "pause":
          case "resume": {
            const s = await ctx.hub.updateSchedule(needId(), { ...writeMeta(ctx, call.toolCallId), actor: self, enabled: p.action === "resume" });
            return ok(`已${p.action === "pause" ? "暂停" : "恢复"}定时任务 ${s.id}，状态 ${s.status}`, scheduleRow(s));
          }
          case "delete": {
            const id = needId();
            await ctx.hub.deleteSchedule(id, self);
            return ok(`已删除定时任务 ${id}`);
          }
          case "trigger_now": {
            const r = await ctx.hub.triggerSchedule(needId(), self);
            return ok(`已立即触发（run ${r.id}，${r.outcome}）`, { run_id: r.id, message_id: r.message_id, trace_id: r.trace_id });
          }
          case "history": {
            const runs = await ctx.hub.scheduleRuns(needId());
            return ok(
              `运行记录 ${runs.length} 条`,
              runs.slice(-30).map((r) => ({ at: fmtTime(r.fired_at), scheduled: fmtTime(r.scheduled_at), outcome: r.outcome, message_id: r.message_id, trace_id: r.trace_id })),
            );
          }
        }
        throw new ToolError(`未知 action：${String(p.action)}`);
      },
    }),
  ];
}
