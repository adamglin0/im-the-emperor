// 通用·自我控制工具：睡眠、等待、结束本轮、发生什么事了、整理记忆、状态
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LIMITS, effectiveToolGroups, type OfficialStatus, type WaitFilter } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { taskRow } from "./docs.ts";
import { ToolError, defineTool, deptAddrOf, fmtTime, ok, resolveAddress, selfAddr, snip } from "./_util.ts";

const WAIT_KINDS = [
  "chat",
  "oral_order",
  "council",
  "edict_notice",
  "task_notice",
  "service_request",
  "service_result",
  "schedule",
  "notification_reply",
  "audit",
] as const;

async function tryOr<T>(f: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await f();
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function stateCounts(list: OfficialStatus[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of list) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

export function selfTools(ctx: ToolContext): AgentTool<any>[] {
  const postId = ctx.post.post_id;
  const self = selfAddr(ctx);
  return [
    defineTool({
      name: "sleep",
      label: "就寝",
      description:
        `【结束本轮】睡眠指定秒数（≤${LIMITS.maxSleepSeconds}，即 24 小时）后醒来；期间只有 ${ctx.post.interruptible_by.join("/") || "皇帝/圣旨/急件"} 能打断，其余来信醒来再办。` +
        "须是本轮最后一个工具调用。",
      parameters: Type.Object({
        seconds: Type.Integer({ minimum: 1, maximum: LIMITS.maxSleepSeconds, description: `睡多少秒（1–${LIMITS.maxSleepSeconds}）` }),
        reason: Type.String({ description: "为何睡、醒来做什么" }),
      }),
      async run(p) {
        const secs = Math.max(1, Math.min(LIMITS.maxSleepSeconds, Math.floor(p.seconds)));
        ctx.sleep(secs, p.reason);
        return ok(`本轮结束，睡眠 ${secs} 秒（约 ${fmtTime(Date.now() + secs * 1000)} 醒来）：${p.reason}`, undefined, { terminate: true });
      },
    }),

    defineTool({
      name: "wait_for",
      label: "等候",
      description:
        "【结束本轮】等到某事发生再醒来：某人来信 from、某类消息 kinds、某事务动静 trace_id、某信的回复 reply_to、皇帝对某待办的批复 notification_id；条件同时满足才醒，都不填则等任何需你处理的事。" +
        "timeout_seconds 必填（10–86400），超时也会醒来，再定催办/上报/续等。须是本轮最后一个工具调用。",
      parameters: Type.Object({
        from: Type.Optional(Type.Array(Type.String(), { description: "只等这些人的来信（post:x / dept:y / emperor，或职衔/姓名）" })),
        kinds: Type.Optional(Type.Array(StringEnum(WAIT_KINDS), { description: "只等这些类型的消息" })),
        trace_id: Type.Optional(Type.String({ description: "只等某事务（trace/诏令）上的动静" })),
        reply_to: Type.Optional(Type.String({ description: "等某封信（message_id）的回复" })),
        notification_id: Type.Optional(Type.String({ description: "等皇帝对某待办的批复" })),
        timeout_seconds: Type.Integer({ minimum: 10, maximum: 86400, description: "最长等待秒数（必填，10–86400）" }),
      }),
      async run(p) {
        const filter: WaitFilter = {};
        if (p.from?.length) filter.from = p.from.map((a) => resolveAddress(ctx, a));
        if (p.kinds?.length) filter.kinds = [...p.kinds];
        if (p.trace_id) filter.trace_id = p.trace_id;
        if (p.reply_to) filter.reply_to = p.reply_to;
        if (p.notification_id) filter.notification_id = p.notification_id;
        if (p.timeout_seconds < 10 || p.timeout_seconds > 86400) throw new ToolError("timeout_seconds 须在 10–86400 之间");
        ctx.waitFor(filter, p.timeout_seconds);
        const what = Object.keys(filter).length ? JSON.stringify(filter) : "任何需要本人处理的事";
        return ok(`本轮结束，等待 ${what}（最长 ${p.timeout_seconds} 秒）`, undefined, { terminate: true });
      },
    }),

    defineTool({
      name: "end_turn",
      label: "结束本轮",
      description: "【结束本轮】事已办完，按职位默认方式等待下一件需你处理的事（新来信/公文变化即醒）。须是本轮最后一个工具调用。",
      parameters: Type.Object({
        note: Type.String({ description: "本轮小结（做了什么、还有什么待跟进）" }),
      }),
      async run(p) {
        ctx.endTurn(p.note);
        return ok(`本轮结束：${p.note}`, undefined, { terminate: true });
      },
    }),

    defineTool({
      name: "whats_happening",
      label: "发生什么事了",
      description:
        "环顾四周：待办职事清单（不标已读）、近期事件、同僚状态。scope：mine 本人+当前事务（默认）/ dept 本部门 / court 全朝概览。不知该做什么时用。",
      parameters: Type.Object({
        scope: Type.Optional(StringEnum(["mine", "dept", "court"] as const, { description: "范围，默认 mine" })),
      }),
      async run(p) {
        const scope = p.scope ?? "mine";
        const out: Record<string, unknown> = { scope, now: fmtTime(Date.now()) };
        const brief = await tryOr(async () => {
          const cur = await ctx.hub.inboxCursor(postId);
          const b = await ctx.hub.briefing(postId, cur.acked_seq, "whats_happening");
          return { pending: b.items, more: b.more || undefined, unread: Math.max(0, cur.latest_seq - cur.acked_seq) };
        });
        out.my_items = brief;
        const trace = ctx.turn().trace_id;
        const evq = scope === "mine" ? { trace_id: trace, limit: 15 } : scope === "dept" ? { dept: ctx.dept.id, limit: 20 } : { limit: 25 };
        const events = await tryOr(() => ctx.hub.events(evq));
        out.recent_events = Array.isArray(events) ? events.map((e) => `${fmtTime(e.ts)} {${e.type}} ${e.actor}：${snip(e.summary, 100)}`) : events;
        const statuses = await tryOr(() => ctx.hub.statuses());
        if (Array.isArray(statuses)) {
          if (scope === "mine") {
            const me = statuses.find((s) => s.post_id === postId);
            out.me = me ? { state: me.state, status_text: me.status_text, turns_last_hour: me.turns_last_hour, tokens_today: me.tokens_today } : undefined;
          } else if (scope === "dept") {
            out.colleagues = statuses.filter((s) => s.dept === ctx.dept.id).map((s) => ({ post: s.post_id, state: s.state, status_text: s.status_text, next_wake: fmtTime(s.next_wake_at) }));
          } else {
            const byDept: Record<string, Record<string, number>> = {};
            for (const d of new Set(statuses.map((s) => s.dept))) byDept[d] = stateCounts(statuses.filter((s) => s.dept === d));
            out.depts = byDept;
          }
        }
        if (scope === "dept") {
          const tasks = await tryOr(() => ctx.hub.tasks({ dept: ctx.dept.id, state: "open", limit: 30 }));
          out.dept_open_tasks = Array.isArray(tasks) ? tasks.map(taskRow) : tasks;
        }
        const n = Array.isArray((brief as { pending?: unknown[] }).pending) ? (brief as { pending: unknown[] }).pending.length : 0;
        return ok(`发生什么事了（${scope}）：你有 ${n} 项待办职事`, out);
      },
    }),

    defineTool({
      name: "compact_memory",
      label: "整理思绪",
      description:
        "用你写的摘要替换较早的对话记录（保留最近若干条）以腾出上下文；本轮结束后执行。摘要须含目标、进行中事项（含 ID）、关键决定、待跟进。长期要记的用 memory_note。",
      parameters: Type.Object({
        summary: Type.String({ description: "摘要（分条：目标/进行中/决定/待办）" }),
      }),
      async run(p) {
        ctx.requestCompaction(p.summary);
        return ok(`已请求整理，将在本轮结束后执行（当前上下文约 ${ctx.contextTokens()} tokens）`);
      },
    }),

    defineTool({
      name: "memory_note",
      label: "备忘录",
      description:
        `长期备忘录 memory.md（跨轮、跨压缩、随人调岗；≤${LIMITS.memoryNoteMaxBytes} 字节）。op：read/append/replace/clear。只记偏好、约定、教训，不记流水账。`,
      parameters: Type.Object({
        op: StringEnum(["append", "replace", "clear", "read"] as const, { description: "操作" }),
        text: Type.Optional(Type.String({ description: "append/replace 时的内容" })),
      }),
      async run(p) {
        if (p.op === "read") {
          const m = ctx.memoryRead();
          return ok(m ? `备忘录（${Buffer.byteLength(m, "utf8")} 字节）：\n${m}` : "备忘录为空");
        }
        if ((p.op === "append" || p.op === "replace") && !p.text) throw new ToolError(`${p.op} 需要 text`);
        const after = ctx.memoryWrite(p.op, p.text ?? "");
        return ok(`备忘录已${p.op === "append" ? "追加" : p.op === "replace" ? "替换" : "清空"}（现 ${Buffer.byteLength(after, "utf8")} 字节）`);
      },
    }),

    defineTool({
      name: "set_status",
      label: "设状态",
      description: "设置对外显示的状态说明（朝堂可见），如「起草某诏令第二稿」「等兵部回复」。",
      parameters: Type.Object({ text: Type.String({ description: "状态说明，一句话" }) }),
      async run(p) {
        ctx.setStatusText(p.text);
        return ok(`状态已设为：${p.text}`);
      },
    }),

    defineTool({
      name: "my_status",
      label: "自省",
      description: "查看自己：运行状态、上下文占用、预算余额、模型与工具组、名下未结任务、定时任务数。",
      parameters: Type.Object({}),
      async run() {
        const st = ctx.status();
        // 预算检查接口（/api/budget/check）仅限网关；官员查 /api/budget 后取与己相关的范围
        const budget = await tryOr(async () => {
          const s = await ctx.hub.budgetStatus();
          const scopes = ["global", `dept:${ctx.dept.id}`, self, `trace:${ctx.turn().trace_id}`];
          const out: Record<string, unknown> = {};
          for (const sc of scopes) {
            const b = s.budgets.find((x) => x.scope === sc);
            const u = s.usage_today[sc];
            if (b || (u && u.tokens)) out[sc] = { daily_tokens: b?.daily_tokens, daily_cost: b?.daily_cost, used_tokens: u?.tokens ?? 0, used_cost: u ? Math.round(u.cost * 10000) / 10000 : 0 };
          }
          return out;
        });
        const tasks = await tryOr(() => ctx.hub.tasks({ assignee: postId, state: "open", limit: 30 }));
        const schedules = await tryOr(async () => (await ctx.hub.schedules({ owner: self })).length);
        const o = ctx.official;
        return ok(`${ctx.dept.name}·${ctx.post.title} ${o.name}：${st.state}`, {
          post: postId,
          official_id: o.official_id,
          state: st.state,
          status_text: st.status_text,
          turn: ctx.turn().turn_id,
          trace: ctx.turn().trace_id,
          context_tokens: ctx.contextTokens(),
          turns_last_hour: st.turns_last_hour,
          tokens_today: st.tokens_today,
          budget,
          config: {
            model: o.model,
            thinking: o.thinking,
            config_version: o.config_version,
            tool_groups: effectiveToolGroups(ctx.post, o),
          },
          open_tasks: Array.isArray(tasks) ? tasks.map(taskRow) : tasks,
          schedules,
          dept_address: deptAddrOf(ctx),
        });
      },
    }),
  ];
}
