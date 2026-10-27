// 官员会话持久化：session.jsonl 逐条追加。
//   {type:"message", message}              每条结束的 AgentMessage（系统消息不存：系统提示每次由当前配置重建）
//   {type:"compaction", summary, at}       压缩点：加载时 = 摘要(user) + 其后的消息
//   {type:"turn", turn_id, status}         轮次记录：running → done | aborted
// 崩溃恢复：最后一轮仍是 running 则不重放；无结果的工具调用补一条「中断」结果，并把该轮标为 aborted。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export const INTERRUPTED_TOOL_RESULT_TEXT = "【中断】上次执行被中断，结果未知，请先查询状态再决定是否重做";
export const SUMMARY_PREFIX = "【前情摘要】以下是此前工作的摘要（较早的对话已整理压缩，完整记录仍在日志中）：\n";

export type TurnStatus = "running" | "done" | "aborted";

export type SessionRecord =
  | { type: "message"; message: AgentMessage; at: number }
  | { type: "compaction"; summary: string; at: number; tokens_before?: number; tokens_after?: number; kept?: number }
  | { type: "turn"; turn_id: string; status: TurnStatus; at: number; trace_id?: string; ack_seq?: number; note?: string };

export interface LoadedSession {
  /** 不含系统消息的会话（压缩摘要在最前，作为 user 消息） */
  messages: AgentMessage[];
  /** 恢复时被标为 aborted 的轮 */
  abortedTurnId?: string;
  /** 补写的「中断」工具结果数 */
  synthesizedResults: number;
}

export function summaryMessage(summary: string, at = Date.now()): UserMessage {
  return { role: "user", content: SUMMARY_PREFIX + summary, timestamp: at };
}

function interruptedResult(tc: ToolCall): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: tc.id,
    toolName: tc.name,
    content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
    isError: true,
    timestamp: Date.now(),
  };
}

function toolCallsOf(m: AgentMessage): ToolCall[] {
  if (m.role !== "assistant") return [];
  const a = m as AssistantMessage;
  if (a.stopReason === "error" || a.stopReason === "aborted") return [];
  return a.content.filter((b): b is ToolCall => b.type === "toolCall");
}

/**
 * 修复会话使其合法：每个工具调用后紧跟其结果（缺失则补「中断」结果）；
 * 找不到对应调用的孤立结果丢弃。返回修复后的会话与补写的结果。
 */
export function repairTranscript(messages: AgentMessage[]): { messages: AgentMessage[]; synthesized: ToolResultMessage[] } {
  const resultsById = new Map<string, ToolResultMessage>();
  for (const m of messages) {
    if (m.role === "toolResult") {
      const r = m as ToolResultMessage;
      if (!resultsById.has(r.toolCallId)) resultsById.set(r.toolCallId, r);
    }
  }
  const out: AgentMessage[] = [];
  const used = new Set<ToolResultMessage>();
  const synthesized: ToolResultMessage[] = [];
  for (const m of messages) {
    if (m.role === "toolResult") continue; // 统一在其调用之后放置
    out.push(m);
    for (const tc of toolCallsOf(m)) {
      const r = resultsById.get(tc.id);
      if (r && !used.has(r)) {
        used.add(r);
        out.push(r);
      } else {
        const s = interruptedResult(tc);
        synthesized.push(s);
        out.push(s);
      }
    }
  }
  return { messages: out, synthesized };
}

/** 会话文件超过此大小时在下一次压缩点轮转 */
const SESSION_ROTATE_BYTES = 4 * 1024 * 1024;

export class SessionStore {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  private append(rec: SessionRecord): void {
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
  }

  appendMessage(message: AgentMessage): void {
    if (message.role === "system") return;
    this.append({ type: "message", message, at: Date.now() });
  }

  appendCompaction(summary: string, extra: { tokens_before?: number; tokens_after?: number; kept?: number } = {}): void {
    this.append({ type: "compaction", summary, at: Date.now(), ...extra });
  }

  /**
   * 压缩后保留的最近消息需重新写入（加载时只读最后一个压缩点之后的消息）。
   * 压缩点与保留段一次写入：避免中途崩溃留下「摘要 + 半截保留段」（工具调用丢了已有结果）。
   */
  appendKeptAfterCompaction(summary: string, kept: AgentMessage[], extra: { tokens_before?: number; tokens_after?: number } = {}): void {
    const now = Date.now();
    const recs: SessionRecord[] = [
      { type: "compaction", summary, at: now, ...extra, kept: kept.length },
      ...kept.filter((m) => m.role !== "system").map((message): SessionRecord => ({ type: "message", message, at: now })),
    ];
    const text = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
    // 轮转：文件过大时，压缩点即新文件起点（加载只需最后一个压缩点之后的内容），旧文件归档（保留最近 5 份）
    if (existsSync(this.file) && statSync(this.file).size > SESSION_ROTATE_BYTES) {
      const dir = join(dirname(this.file), "session-archive");
      mkdirSync(dir, { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, text);
      renameSync(this.file, join(dir, `session-${now}.jsonl`));
      renameSync(tmp, this.file);
      const old = readdirSync(dir).filter((f) => f.startsWith("session-")).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 5))) unlinkSync(join(dir, f));
      return;
    }
    appendFileSync(this.file, text);
  }

  appendTurn(turn_id: string, status: TurnStatus, extra: { trace_id?: string; ack_seq?: number; note?: string } = {}): void {
    this.append({ type: "turn", turn_id, status, at: Date.now(), ...extra });
  }

  readRecords(): SessionRecord[] {
    if (!existsSync(this.file)) return [];
    const out: SessionRecord[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行（写入中断）丢弃 */
      }
    }
    return out;
  }

  /** 加载并做崩溃恢复（补写记录会追加到文件） */
  load(): LoadedSession {
    const recs = this.readRecords();
    let start = 0;
    let summary: string | undefined;
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i];
      if (r.type === "compaction") {
        start = i + 1;
        summary = r.summary;
        break;
      }
    }
    const raw: AgentMessage[] = [];
    if (summary !== undefined) raw.push(summaryMessage(summary, recs[start - 1].at));
    for (let i = start; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === "message" && r.message.role !== "system") raw.push(r.message);
    }
    let lastTurn: Extract<SessionRecord, { type: "turn" }> | undefined;
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i];
      if (r.type === "turn") {
        lastTurn = r;
        break;
      }
    }
    const { messages, synthesized } = repairTranscript(raw);
    for (const s of synthesized) this.appendMessage(s);
    let abortedTurnId: string | undefined;
    if (lastTurn?.status === "running") {
      abortedTurnId = lastTurn.turn_id;
      this.appendTurn(lastTurn.turn_id, "aborted", { note: "进程重启时该轮仍在运行，未重放" });
    }
    return { messages, abortedTurnId, synthesizedResults: synthesized.length };
  }
}
