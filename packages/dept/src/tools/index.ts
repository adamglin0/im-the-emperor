// 工具装配：按官员有效工具组返回工具实例
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { effectiveToolGroups, toolsForGroups } from "@court/shared";
import type { ToolContext, ToolFactory } from "../tool-context.ts";
import { assetsTools } from "./assets.ts";
import { censorTools } from "./censor.ts";
import { configTools } from "./config.ts";
import { councilTools } from "./council.ts";
import { dispatchTools } from "./dispatch.ts";
import { docsTools } from "./docs.ts";
import { draftingTools } from "./drafting.ts";
import { emperorTools } from "./emperor.ts";
import { examTools } from "./exam.ts";
import { financeTools } from "./finance.ts";
import { justiceTools } from "./justice.ts";
import { messagingTools } from "./messaging.ts";
import { personnelTools } from "./personnel.ts";
import { reviewTools } from "./review.ts";
import { ritesTools } from "./rites.ts";
import { rosterTools } from "./roster.ts";
import { scheduleTools } from "./schedule.ts";
import { selfTools } from "./self.ts";
import { servicesTools } from "./services.ts";
import { workshopTools } from "./workshop.ts";

/** 全部工具工厂（同名工具以先出现者为准：edict_diff 在 drafting，task_* 管理类在 dispatch） */
export const TOOL_FACTORIES: ToolFactory[] = [
  messagingTools,
  rosterTools,
  servicesTools,
  docsTools,
  emperorTools,
  assetsTools,
  scheduleTools,
  selfTools,
  councilTools,
  draftingTools,
  reviewTools,
  dispatchTools,
  configTools,
  examTools,
  financeTools,
  personnelTools,
  workshopTools,
  justiceTools,
  ritesTools,
  censorTools,
];

/** 每个官员（ctx）本轮已由哪个结束型工具结束：turn_id → 工具名 */
const endedTurns = new WeakMap<ToolContext, { turn: string; by: string }>();

/** 会设定下一次唤醒条件的结束型工具（同轮只认第一个） */
const ENDING_TOOLS = new Set(["sleep", "wait_for", "end_turn", "ask_official"]);
const isEndingCall = (name: string, params: unknown) =>
  ENDING_TOOLS.has(name) || (name === "call_service" && !!(params as { wait?: boolean } | undefined)?.wait);

/**
 * 结束型守卫：pi-agent-core 只有当一批工具结果「全部」terminate 时才不再调用 LLM。
 * 模型常在同一批里于结束工具之后再附一个普通工具（如 [end_turn, memory_note]）：
 * - 之后的普通工具照常执行（这是模型本意），但结果标记 terminate，保证本批全部 terminate、不再多耗一次 LLM；
 * - 之后的结束型工具不执行（首个结束决定生效，避免覆盖已设定的等待条件）。
 */
function withEndGuard(ctx: ToolContext, t: AgentTool<any>): AgentTool<any> {
  const execute = t.execute.bind(t);
  return {
    ...t,
    async execute(toolCallId, params, signal, onUpdate) {
      const turn = ctx.turn().turn_id;
      const ended = endedTurns.get(ctx);
      if (ended && ended.turn === turn) {
        if (isEndingCall(t.name, params)) {
          return { content: [{ type: "text", text: `本轮已由 ${ended.by} 结束（以其设定为准），${t.name} 未执行。` }], details: null, terminate: true };
        }
        const r = await execute(toolCallId, params, signal, onUpdate);
        return { ...r, terminate: true };
      }
      const r = await execute(toolCallId, params, signal, onUpdate);
      if (r.terminate && !r.isError) endedTurns.set(ctx, { turn, by: t.name });
      return r;
    },
  };
}

/** 构建全部已实现工具（name → tool），不按权限过滤 */
export function buildAllTools(ctx: ToolContext): Map<string, AgentTool<any>> {
  const map = new Map<string, AgentTool<any>>();
  for (const f of TOOL_FACTORIES) for (const t of f(ctx)) if (!map.has(t.name)) map.set(t.name, withEndGuard(ctx, t));
  return map;
}

/** 按 effectiveToolGroups(post, official) 返回该官员可用的工具 */
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
  const all = buildAllTools(ctx);
  const names = toolsForGroups(effectiveToolGroups(ctx.post, ctx.official));
  const out: AgentTool<any>[] = [];
  for (const n of names) {
    const t = all.get(n);
    if (t) out.push(t);
    else ctx.log("error", { message: `工具 ${n} 未实现`, tool: n });
  }
  return out;
}
