// 上下文压缩：摘要较早的消息，保留最近若干条（只在 user 消息边界切分，保证工具调用/结果成对）。
// 压缩后会话 = [系统消息, 摘要(user), ...保留]。系统消息必须保留——pi 的系统提示由会话中的系统消息重放而来。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, SystemMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { estimateTokens, truncate, type GatewayClient, type GatewayMeta } from "@court/shared";
import { summaryMessage } from "./session.ts";

const TOOL_RESULT_SERIALIZE_MAX = 2000;

function contentText(content: UserMessage["content"] | ToolResultMessage["content"] | SystemMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "［图片］")).join("\n");
}

/** 把一条消息序列化为纯文本（用于 token 估算与摘要输入） */
export function serializeMessage(m: AgentMessage, forSummary = false): string {
  switch (m.role) {
    case "system": {
      const s = m as SystemMessage;
      const tools = (s.toolsAdded ?? []).map((t) => `${t.name}: ${t.description} ${JSON.stringify(t.parameters)}`).join("\n");
      return `[系统]: ${contentText(s.content)}${tools ? "\n" + tools : ""}`;
    }
    case "user":
      return `[来信/简报]: ${contentText((m as UserMessage).content)}`;
    case "assistant": {
      const a = m as AssistantMessage;
      const parts: string[] = [];
      for (const b of a.content) {
        if (b.type === "text" && b.text) parts.push(`[本官]: ${b.text}`);
        else if (b.type === "thinking" && !forSummary) parts.push(`[思考]: ${b.thinking}`);
        else if (b.type === "toolCall") parts.push(`[调用工具 ${b.name}]: ${JSON.stringify(b.arguments)}`);
      }
      if (a.stopReason === "error") parts.push(`[调用出错]: ${a.errorMessage ?? ""}`);
      return parts.join("\n");
    }
    case "toolResult": {
      const r = m as ToolResultMessage;
      const text = contentText(r.content);
      const body = forSummary ? truncate(text, TOOL_RESULT_SERIALIZE_MAX).text : text;
      return `[工具结果 ${r.toolName}${r.isError ? " 出错" : ""}]: ${body}`;
    }
    default:
      return JSON.stringify(m);
  }
}

export function estimateMessageTokens(m: AgentMessage): number {
  return estimateTokens(serializeMessage(m));
}

export function estimateContextTokens(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

/**
 * 把（不含系统消息的）会话切成「待摘要」与「保留」两段。
 * 只在 user 消息处切分；保留段 token 总数 ≤ keepTokens。
 * mustKeepLastUser：至少保留最后一条 user 消息起的内容（上下文超长重试时，当轮简报不能丢）。
 */
export function splitForCompaction(
  messages: AgentMessage[],
  keepTokens: number,
  mustKeepLastUser = false,
): { older: AgentMessage[]; kept: AgentMessage[] } {
  const suffix: number[] = new Array(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + estimateMessageTokens(messages[i]);
  let cut = messages.length;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    if (lastUser < 0) lastUser = i;
    if (suffix[i] <= keepTokens) cut = i;
    else break;
  }
  if (mustKeepLastUser && lastUser >= 0 && cut > lastUser) cut = lastUser;
  // 不保留旧摘要本身（它会被并入新摘要）
  return { older: messages.slice(0, cut), kept: messages.slice(cut) };
}

export function buildCompactedMessages(system: SystemMessage | undefined, summary: string, kept: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  if (system) out.push(system);
  out.push(summaryMessage(summary));
  for (const m of kept) if (m.role !== "system") out.push(m);
  return out;
}

const SUMMARY_SYSTEM_PROMPT = `你是朝廷官员的书记，负责把官员此前的工作对话整理成一份简明的「前情摘要」，供官员在上下文被压缩后继续办事。
要求：
- 用简体中文，条理清楚，总长度不超过 1500 字。
- 按以下标题组织：目标；约束与要求；进展（已完成 / 进行中 / 受阻）；关键决定；下一步；关键上下文。
- 「关键上下文」中必须原样保留所有仍可能用到的标识：诏令 ID、任务 ID、消息 ID、服务请求 ID、待办 ID、资产 ID、trace ID，以及等待中的事项与对方职位。
- 只写事实，不要编造；已经办结的琐事可以一笔带过。`;

/** 经网关生成摘要（purpose=compaction）。失败抛错。 */
export async function generateSummary(
  gateway: GatewayClient,
  modelKey: string,
  older: AgentMessage[],
  meta: Omit<GatewayMeta, "purpose">,
): Promise<string> {
  const transcript = older.map((m) => serializeMessage(m, true)).filter(Boolean).join("\n\n");
  const res = await gateway.complete({
    model_key: modelKey,
    context: {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `请整理以下对话记录：\n<对话记录>\n${transcript}\n</对话记录>`,
          timestamp: Date.now(),
        },
      ],
    },
    options: { maxTokens: 4096 },
    metadata: { ...meta, purpose: "compaction" },
  });
  const msg = res.message;
  if (msg.stopReason === "error") throw new Error(msg.errorMessage ?? "摘要生成失败");
  const text = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("摘要为空");
  return text;
}

/** 网关不可用时的机械摘要：截取较早记录的尾部 */
export function fallbackSummary(older: AgentMessage[]): string {
  const transcript = older.map((m) => serializeMessage(m, true)).filter(Boolean).join("\n");
  return "（摘要服务不可用，以下为较早记录的机械截取）\n" + truncate(transcript, 6000).text;
}
