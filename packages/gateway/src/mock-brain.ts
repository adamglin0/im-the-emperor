// mock 大脑：LLM_MODE=mock 时代替真实模型，按「职事清单」确定性地产生工具调用（plan 约定 5–6）。
// 纯函数：同样的 context + meta 得到同样的 AssistantMessage（时间戳除外）。
import { getCurrentTools, type AssistantMessage, type Context, type Message, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { DeptId, GatewayMeta, PendingItem } from "@court/shared";

const CHECKLIST_OPEN = "<职事清单 json>";
const CHECKLIST_CLOSE = "</职事清单>";

export interface MockModelRef {
  api: string;
  provider: string;
  id: string;
}

interface PlannedCall {
  name: string;
  args: Record<string, unknown>;
}

const DEFAULT_MODEL: MockModelRef = { api: "openai-completions", provider: "mock", id: "mock-brain" };

/** 生成 mock 回复。model 仅用于填写 AssistantMessage 的 api/provider/model 字段。 */
export function runMockBrain(context: Context, meta: Pick<GatewayMeta, "purpose"> | undefined, model: MockModelRef = DEFAULT_MODEL, now = Date.now()): AssistantMessage {
  const purpose = meta?.purpose ?? "turn";
  const inputTokens = Math.ceil(contextChars(context) / 4);
  const make = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: inputTokens,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 50,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: now,
  });
  const text = (t: string) => make([{ type: "text", text: t }], "stop");
  const call = (c: PlannedCall, idx: number) => make([buildToolCall(c, idx, context)], "toolUse");

  if (purpose === "compaction") return text(buildCompactionSummary(context));
  if (purpose === "grading") return text(`{"score": 75, "comment": "mock"}`);
  if (purpose === "exam") {
    const examCall = planExamCall(context);
    return examCall ? call(examCall, 0) : text(answerExam(context));
  }

  const lastUserIdx = findLastIndex(context.messages, (m) => m.role === "user");
  const toolNames = new Set(availableTools(context).map((t) => t.name));
  const items = lastUserIdx >= 0 ? parseChecklist(messageText(context.messages[lastUserIdx])) : undefined;
  const done = countToolCallsAfter(context.messages, lastUserIdx);
  const planned = (items ?? []).map(planItem).filter((c): c is PlannedCall => !!c && toolNames.has(c.name));
  if (done < planned.length) return call(planned[done], done);
  const note = items ? "本轮职事已毕" : "无职事清单，本轮无事";
  if (toolNames.has("end_turn")) return call({ name: "end_turn", args: { note } }, done);
  return text(note);
}

/** 从最后一条 user 消息文本中解析职事清单；无清单返回 undefined。 */
export function parseChecklist(text: string): PendingItem[] | undefined {
  const start = text.lastIndexOf(CHECKLIST_OPEN);
  if (start < 0) return undefined;
  const end = text.indexOf(CHECKLIST_CLOSE, start);
  if (end < 0) return undefined;
  const raw = text.slice(start + CHECKLIST_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingItem[]) : undefined;
  } catch {
    return undefined;
  }
}

/** 一个职事 → 一次工具调用；返回 undefined 表示此项本轮无需动作（跳过）。 */
export function planItem(item: PendingItem): PlannedCall | undefined {
  switch (item.type) {
    case "message":
      return item.requires_reply
        ? { name: "reply_message", args: { message_id: item.message_id, body: `臣谨奏：已知悉『${item.subject}』，即当办理。` } }
        : { name: "ack_message", args: { message_id: item.message_id } };
    case "council_turn":
      return { name: "council_speak", args: { deliberation_id: item.deliberation_id, stance: "support", content: "臣以为可行，宜令有司拟诏施行。" } };
    case "council_chair": {
      if (!(item.all_spoken && item.round >= 1)) return undefined;
      const topic = item.topic ?? "议定之事";
      return {
        name: "council_conclude",
        args: {
          deliberation_id: item.deliberation_id,
          summary: "诸臣议定：宜施行。",
          dissent: "无",
          proposed_edict_title: [...topic].slice(0, 20).join(""),
          proposed_edict_intent: topic,
          confidence: 0.8,
        },
      };
    }
    case "edict_draft":
      return {
        name: "edict_submit_draft",
        args: {
          edict_id: item.edict_id,
          title: item.title,
          objective: "落实旨意：" + item.title,
          constraints: "依律令，节用",
          acceptance: "各承办部提交成果并经核验",
          deadline_text: "三日内",
          suggested_depts: suggestDepts(item.title),
          text: "门下：朕闻…（诏书正文）",
          responses: (item.open_issue_ids ?? []).map((id) => ({ issue_id: id, response: "已遵照修改" })),
        },
      };
    case "edict_countersign":
      return { name: "edict_countersign", args: { edict_id: item.edict_id, approve: true, comment: "复署无误" } };
    case "edict_review":
      if (item.title.includes("测封驳") && item.draft_no === 1) {
        return {
          name: "edict_review",
          args: {
            edict_id: item.edict_id,
            decision: "reject",
            opinion: "验收标准不明",
            issues: [{ severity: "blocking", clause: "验收", reason: "缺验收标准", required_change: "写明验收标准" }],
          },
        };
      }
      return { name: "edict_review", args: { edict_id: item.edict_id, decision: "approve", opinion: "审核无误，准予施行", issues: [] } };
    case "edict_dispatch":
      return {
        name: "edict_dispatch",
        args: {
          edict_id: item.edict_id,
          tasks: (item.suggested_depts ?? []).map((d) => ({ dept: d, title: "承办：" + item.title, instructions: "依诏办理", acceptance: "提交成果" })),
        },
      };
    case "edict_report":
      return item.tasks_open === 0 ? { name: "edict_report", args: { edict_id: item.edict_id, summary: "诸部办毕，谨此复奏。" } } : undefined;
    case "task_assigned":
      return { name: "task_submit", args: { task_id: item.task_id, result: `已办毕：${item.title}` } };
    case "task_verify":
      return { name: "task_verify", args: { task_id: item.task_id, pass: true, comment: "核验无误" } };
    case "service_request":
      return { name: "service_respond", args: { request_id: item.request_id, ok: true, output: `已办：${item.service}` } };
    case "schedule":
      return { name: "report_progress", args: { title: "定时：" + item.title, body: "已巡检，无异常" } };
    case "notification_reply":
      return { name: "memory_note", args: { op: "append", text: "陛下批复：" + item.option } };
    case "audit_finding":
      return { name: "audit_update_finding", args: { finding_id: item.finding_id, status: "reviewed", note: "已核" } };
    case "exam_grading":
      return { name: "exam_grade", args: { answer_id: item.answer_id, score: 80, comment: "mock 阅卷" } };
    default:
      return undefined;
  }
}

const DEPT_KEYWORDS: [RegExp, DeptId][] = [
  [/翻译|润色|文/, "libu_rites"],
  [/测试|核验/, "xingbu"],
  [/代码|营造|文档/, "gongbu"],
  [/执行|运行|抓取/, "bingbu"],
  [/预算|户/, "hubu"],
];

export function suggestDepts(title: string): DeptId[] {
  const out: DeptId[] = [];
  for (const [re, dept] of DEPT_KEYWORDS) if (re.test(title) && !out.includes(dept)) out.push(dept);
  return out.length ? out : ["libu_rites"];
}

function buildToolCall(c: PlannedCall, idx: number, context: Context): ToolCall {
  // 确定性 id：调用序号 + 上下文长度，避免同一会话内重复
  return { type: "toolCall", id: `mock_${idx}_${context.messages.length}_${c.name}`, name: c.name, arguments: c.args as ToolCall["arguments"] };
}

/**
 * 可用工具：Context.tools（直接调用）∪ 转录中 system 消息声明的工具（经 streamProxy 传来的 TranscriptContext
 * 把工具放在 system 消息的 toolsAdded/toolsRemoved 里）。
 */
function availableTools(context: Context): Tool[] {
  const seen = new Map<string, Tool>();
  for (const t of context.tools ?? []) seen.set(t.name, t);
  for (const t of getCurrentTools(context.messages)) if (!seen.has(t.name)) seen.set(t.name, t);
  return [...seen.values()];
}

function countToolCallsAfter(messages: Message[], idx: number): number {
  let n = 0;
  for (let i = idx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") n += m.content.filter((b) => b.type === "toolCall").length;
  }
  return n;
}

function messageText(m: Message | undefined): string {
  if (!m) return "";
  const c = (m as { content: unknown }).content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b: any) => (b?.type === "text" ? b.text : b?.type === "thinking" ? b.thinking : b?.type === "toolCall" ? JSON.stringify(b.arguments) : ""))
    .join("\n");
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

export function contextChars(context: Context): number {
  let n = (context.systemPrompt ?? "").length;
  for (const m of context.messages) n += messageText(m).length;
  return n;
}

function buildCompactionSummary(context: Context): string {
  const points = context.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => messageText(m).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-6)
    .map((t, i) => `${i + 1}. ${[...t].slice(0, 40).join("")}`);
  return `【摘要】共 ${context.messages.length} 条消息，要点如下：\n${points.join("\n") || "（无要点）"}`;
}

function planExamCall(context: Context): PlannedCall | undefined {
  const tool = availableTools(context)[0];
  if (!tool) return undefined;
  // 已经调用过工具（有 toolResult）则给出文字答案，避免无限循环
  const lastUserIdx = findLastIndex(context.messages, (m) => m.role === "user");
  if (countToolCallsAfter(context.messages, lastUserIdx) > 0) return undefined;
  return { name: tool.name, args: sampleArgs(tool.parameters as Record<string, unknown>) };
}

function answerExam(context: Context): string {
  const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
  const q = messageText(lastUser);
  if (/json/i.test(q)) return `{"ok":true}`;
  return `答：已阅「${[...q.replace(/\s+/g, " ")].slice(0, 20).join("")}」，臣谨答如上。`;
}

/** 按 JSON Schema 生成「看似合理」的参数 */
export function sampleArgs(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) out[k] = sampleValue(p);
  return out;
}

function sampleValue(p: Record<string, unknown>): unknown {
  if (Array.isArray(p.enum) && p.enum.length) return p.enum[0];
  if (p.const !== undefined) return p.const;
  const anyOf = (p.anyOf ?? p.oneOf) as Record<string, unknown>[] | undefined;
  if (anyOf?.length) return sampleValue(anyOf[0]);
  switch (p.type) {
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return sampleArgs(p);
    default:
      return "示例";
  }
}
