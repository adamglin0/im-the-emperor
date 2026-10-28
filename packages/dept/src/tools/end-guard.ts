// 结束型守卫：基础工具与 MCP 动态工具共用（独立成模块，免得 mcp-tools.ts 为此引入整个工具装配表）
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../tool-context.ts";

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
export function withEndGuard(ctx: ToolContext, t: AgentTool<any>): AgentTool<any> {
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
