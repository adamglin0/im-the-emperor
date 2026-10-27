import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Message, ToolCall } from "@earendil-works/pi-ai";
import type { PendingItem } from "@court/shared";
import { parseChecklist, planItem, runMockBrain, suggestDepts } from "../src/mock-brain.ts";

const ALL_TOOLS = [
  "reply_message", "ack_message", "council_speak", "council_conclude", "edict_submit_draft", "edict_countersign", "edict_review",
  "edict_dispatch", "edict_report", "task_submit", "task_verify", "service_respond", "report_progress", "memory_note",
  "audit_update_finding", "exam_grade", "end_turn",
];

const tools = (names: string[] = ALL_TOOLS) => names.map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } as never }));

function briefing(items: PendingItem[]): string {
  return `陛下有旨，诸事如下。\n<职事清单 json>\n${JSON.stringify(items)}\n</职事清单>\n新来信：……`;
}

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });

function assistantCall(name: string, args: Record<string, unknown> = {}, id = `c_${name}`): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] }],
    api: "openai-completions",
    provider: "mock",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1,
  } as AssistantMessage;
}

const toolResult = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 });

function onlyCall(msg: AssistantMessage): ToolCall {
  expect(msg.stopReason).toBe("toolUse");
  const calls = msg.content.filter((b) => b.type === "toolCall") as ToolCall[];
  expect(calls).toHaveLength(1);
  return calls[0];
}

function first(item: PendingItem): ToolCall {
  const ctx: Context = { messages: [user(briefing([item]))], tools: tools() };
  return onlyCall(runMockBrain(ctx, { purpose: "turn" }));
}

describe("mock 大脑：职事映射", () => {
  it("需回复的来信 → reply_message", () => {
    const c = first({ type: "message", message_id: "msg_1", from: "emperor", kind: "oral_order", subject: "修渠", requires_reply: true, trace_id: "tr" });
    expect(c.name).toBe("reply_message");
    expect(c.arguments).toEqual({ message_id: "msg_1", body: "臣谨奏：已知悉『修渠』，即当办理。" });
  });

  it("无需回复的来信 → ack_message", () => {
    const c = first({ type: "message", message_id: "msg_2", from: "post:a.b", kind: "fyi", subject: "x", requires_reply: false, trace_id: "tr" });
    expect(c).toMatchObject({ name: "ack_message", arguments: { message_id: "msg_2" } });
  });

  it("议事发言 → council_speak", () => {
    const c = first({ type: "council_turn", deliberation_id: "dl_1", round: 1, topic: "开科取士" });
    expect(c).toMatchObject({ name: "council_speak", arguments: { deliberation_id: "dl_1", stance: "support", content: "臣以为可行，宜令有司拟诏施行。" } });
  });

  it("主持：全员已发言 → council_conclude（标题取议题前 20 字）", () => {
    const topic = "整顿驿传以便公文流转并且核验各地驿站的马匹数量与粮草";
    const c = first({ type: "council_chair", deliberation_id: "dl_1", round: 1, all_spoken: true, topic });
    expect(c.name).toBe("council_conclude");
    expect(c.arguments).toMatchObject({
      deliberation_id: "dl_1",
      summary: "诸臣议定：宜施行。",
      dissent: "无",
      proposed_edict_title: [...topic].slice(0, 20).join(""),
      proposed_edict_intent: topic,
      confidence: 0.8,
    });
  });

  it("主持：尚有人未发言 → 跳过，直接 end_turn", () => {
    const c = first({ type: "council_chair", deliberation_id: "dl_1", round: 1, all_spoken: false });
    expect(c).toMatchObject({ name: "end_turn", arguments: { note: "本轮职事已毕" } });
  });

  it("起草 → edict_submit_draft（按标题推荐部门，逐条回应封驳）", () => {
    const c = first({ type: "edict_draft", edict_id: "ed_1", title: "翻译并测试文档", draft_no_next: 2, rejected: true, open_issue_ids: ["is_1", "is_2"] });
    expect(c.name).toBe("edict_submit_draft");
    expect(c.arguments).toMatchObject({
      edict_id: "ed_1",
      title: "翻译并测试文档",
      objective: "落实旨意：翻译并测试文档",
      constraints: "依律令，节用",
      acceptance: "各承办部提交成果并经核验",
      deadline_text: "三日内",
      suggested_depts: ["libu_rites", "xingbu", "gongbu"],
      responses: [
        { issue_id: "is_1", response: "已遵照修改" },
        { issue_id: "is_2", response: "已遵照修改" },
      ],
    });
    expect(String(c.arguments.text)).toContain("门下");
  });

  it("推荐部门关键词", () => {
    expect(suggestDepts("润色奏章")).toEqual(["libu_rites"]);
    expect(suggestDepts("核验账目")).toEqual(["xingbu"]);
    expect(suggestDepts("营造代码")).toEqual(["gongbu"]);
    expect(suggestDepts("抓取网页")).toEqual(["bingbu"]);
    expect(suggestDepts("预算")).toEqual(["hubu"]);
    expect(suggestDepts("巡幸")).toEqual(["libu_rites"]);
  });

  it("复署 → edict_countersign", () => {
    expect(first({ type: "edict_countersign", edict_id: "ed_1", title: "t", draft_no: 1 })).toMatchObject({
      name: "edict_countersign",
      arguments: { edict_id: "ed_1", approve: true, comment: "复署无误" },
    });
  });

  it("审核：标题含「测封驳」的第 1 稿 → 封驳；第 2 稿 → 通过", () => {
    const r1 = first({ type: "edict_review", edict_id: "ed_1", title: "测封驳之诏", draft_no: 1, prior_issue_ids: [] });
    expect(r1.arguments).toMatchObject({ decision: "reject", opinion: "验收标准不明" });
    expect(r1.arguments.issues).toEqual([{ severity: "blocking", clause: "验收", reason: "缺验收标准", required_change: "写明验收标准" }]);
    const r2 = first({ type: "edict_review", edict_id: "ed_1", title: "测封驳之诏", draft_no: 2, prior_issue_ids: ["is_1"] });
    expect(r2.arguments).toMatchObject({ decision: "approve", opinion: "审核无误，准予施行", issues: [] });
    const r3 = first({ type: "edict_review", edict_id: "ed_2", title: "普通诏令", draft_no: 1, prior_issue_ids: [] });
    expect(r3.arguments).toMatchObject({ decision: "approve" });
  });

  it("分派 → edict_dispatch（每个建议部门一项任务）", () => {
    const c = first({ type: "edict_dispatch", edict_id: "ed_1", title: "修史", suggested_depts: ["libu_rites", "gongbu"] });
    expect(c.arguments).toEqual({
      edict_id: "ed_1",
      tasks: [
        { dept: "libu_rites", title: "承办：修史", instructions: "依诏办理", acceptance: "提交成果" },
        { dept: "gongbu", title: "承办：修史", instructions: "依诏办理", acceptance: "提交成果" },
      ],
    });
  });

  it("复奏：任务未结 → 跳过；全部终结 → edict_report", () => {
    expect(first({ type: "edict_report", edict_id: "ed_1", title: "t", tasks_total: 2, tasks_open: 1 }).name).toBe("end_turn");
    expect(first({ type: "edict_report", edict_id: "ed_1", title: "t", tasks_total: 2, tasks_open: 0 })).toMatchObject({
      name: "edict_report",
      arguments: { edict_id: "ed_1", summary: "诸部办毕，谨此复奏。" },
    });
  });

  it("任务、核验、服务、定时、批复、稽查、阅卷", () => {
    expect(first({ type: "task_assigned", task_id: "tk_1", title: "译经", state: "assigned", is_head: false })).toMatchObject({
      name: "task_submit",
      arguments: { task_id: "tk_1", result: "已办毕：译经" },
    });
    expect(first({ type: "task_verify", task_id: "tk_1", title: "译经" })).toMatchObject({ name: "task_verify", arguments: { task_id: "tk_1", pass: true, comment: "核验无误" } });
    expect(first({ type: "service_request", request_id: "sr_1", service: "polish", caller: "post:a.b" })).toMatchObject({
      name: "service_respond",
      arguments: { request_id: "sr_1", ok: true, output: "已办：polish" },
    });
    expect(first({ type: "schedule", schedule_id: "sc_1", title: "早朝", payload: "" })).toMatchObject({
      name: "report_progress",
      arguments: { title: "定时：早朝", body: "已巡检，无异常" },
    });
    expect(first({ type: "notification_reply", notification_id: "nt_1", option: "approve", comment: "" })).toMatchObject({
      name: "memory_note",
      arguments: { op: "append", text: "陛下批复：approve" },
    });
    expect(first({ type: "audit_finding", finding_id: "af_1", rule: "loop_chat", subject: "post:a.b" })).toMatchObject({
      name: "audit_update_finding",
      arguments: { finding_id: "af_1", status: "reviewed", note: "已核" },
    });
    expect(first({ type: "exam_grading", answer_id: "an_1", session_id: "es_1" })).toMatchObject({
      name: "exam_grade",
      arguments: { answer_id: "an_1", score: 80, comment: "mock 阅卷" },
    });
  });
});

describe("mock 大脑：游标与收尾", () => {
  const items: PendingItem[] = [
    { type: "message", message_id: "m1", from: "emperor", kind: "chat", subject: "甲", requires_reply: true, trace_id: "t" },
    { type: "task_verify", task_id: "tk_9", title: "乙" },
    { type: "message", message_id: "m2", from: "emperor", kind: "chat", subject: "丙", requires_reply: false, trace_id: "t" },
  ];

  it("按最后一条 user 消息之后已有的 toolCall 数推进；全部处理完 end_turn", () => {
    const msgs: Message[] = [user("旧的简报，无清单"), user(briefing(items))];
    const ctx = (): Context => ({ messages: msgs, tools: tools() });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = onlyCall(runMockBrain(ctx(), { purpose: "turn" }));
      seen.push(c.name);
      msgs.push(assistantCall(c.name, c.arguments, c.id), toolResult(c.id));
    }
    expect(seen).toEqual(["reply_message", "task_verify", "ack_message", "end_turn"]);
  });

  it("没有的工具跳过（不占游标）", () => {
    const ctx: Context = { messages: [user(briefing(items))], tools: tools(["ack_message", "end_turn"]) };
    expect(onlyCall(runMockBrain(ctx, { purpose: "turn" })).arguments).toEqual({ message_id: "m2" });
    const ctx2: Context = { messages: [...ctx.messages, assistantCall("ack_message", { message_id: "m2" }), toolResult("c_ack_message")], tools: ctx.tools };
    expect(onlyCall(runMockBrain(ctx2, { purpose: "turn" }))).toMatchObject({ name: "end_turn", arguments: { note: "本轮职事已毕" } });
  });

  it("新的 user 消息（插话）重置游标", () => {
    const msgs: Message[] = [user(briefing(items)), assistantCall("reply_message"), toolResult("c_reply_message"), user(briefing([items[1]]))];
    expect(onlyCall(runMockBrain({ messages: msgs, tools: tools() }, { purpose: "turn" })).name).toBe("task_verify");
  });

  it("一条 assistant 中有多个 toolCall 时逐个计数", () => {
    const multi = assistantCall("reply_message");
    (multi as AssistantMessage).content.push({ type: "toolCall", id: "c2", name: "task_verify", arguments: {} });
    const msgs: Message[] = [user(briefing(items)), multi];
    expect(onlyCall(runMockBrain({ messages: msgs, tools: tools() }, { purpose: "turn" })).name).toBe("ack_message");
  });

  it("无清单 → end_turn；也无 end_turn 工具 → 纯文本", () => {
    expect(onlyCall(runMockBrain({ messages: [user("醒来，无事")], tools: tools() }, { purpose: "turn" })).name).toBe("end_turn");
    const msg = runMockBrain({ messages: [user("醒来，无事")], tools: [] }, { purpose: "turn" });
    expect(msg.stopReason).toBe("stop");
    expect(msg.content[0]).toMatchObject({ type: "text" });
  });

  it("清单 JSON 损坏视为无清单", () => {
    expect(parseChecklist("<职事清单 json>\n[{bad\n</职事清单>")).toBeUndefined();
    expect(parseChecklist(briefing(items))).toHaveLength(3);
  });

  it("用量：input = 字符数/4，output 50，成本 0", () => {
    const content = "x".repeat(400);
    const msg = runMockBrain({ systemPrompt: "", messages: [user(content)], tools: tools() }, { purpose: "turn" });
    expect(msg.usage).toMatchObject({ input: 100, output: 50, totalTokens: 150 });
    expect(msg.usage.cost.total).toBe(0);
  });

  it("planItem 对未知类型返回 undefined", () => {
    expect(planItem({ type: "nope" } as unknown as PendingItem)).toBeUndefined();
  });
});

describe("mock 大脑：特殊用途", () => {
  it("compaction → 【摘要】文本", () => {
    const msg = runMockBrain({ messages: [user("第一件事：修渠"), user("第二件事：开仓")] }, { purpose: "compaction" });
    const t = (msg.content[0] as { text: string }).text;
    expect(t.startsWith("【摘要】")).toBe(true);
    expect(t).toContain("修渠");
  });

  it("grading → JSON 评分", () => {
    const msg = runMockBrain({ messages: [user("请阅卷")] }, { purpose: "grading" });
    expect(JSON.parse((msg.content[0] as { text: string }).text)).toEqual({ score: 75, comment: "mock" });
  });

  it("exam：有工具 → 调第一个工具（参数按 schema 生成）；已调用过 → 文字作答", () => {
    const examTools = [
      {
        name: "add",
        description: "加法",
        parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "number" }, op: { type: "string", enum: ["plus"] }, flag: { type: "boolean" } } } as never,
      },
    ];
    const c = onlyCall(runMockBrain({ messages: [user("17+25=?")], tools: examTools }, { purpose: "exam" }));
    expect(c).toMatchObject({ name: "add", arguments: { a: 1, b: 1, op: "plus", flag: true } });
    const after = runMockBrain({ messages: [user("17+25=?"), assistantCall("add"), toolResult("c_add")], tools: examTools }, { purpose: "exam" });
    expect(after.stopReason).toBe("stop");
  });

  it("exam：要求 JSON → {\"ok\":true}；否则「答：」", () => {
    expect((runMockBrain({ messages: [user("请以 JSON 输出")] }, { purpose: "exam" }).content[0] as { text: string }).text).toBe(`{"ok":true}`);
    expect((runMockBrain({ messages: [user("何为仁？")] }, { purpose: "exam" }).content[0] as { text: string }).text.startsWith("答：")).toBe(true);
  });
});
