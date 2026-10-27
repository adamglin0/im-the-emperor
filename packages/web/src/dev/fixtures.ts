// 样例数据（仅 ?fixtures=1 时动态加载）：在无后端时开发/截图 UI。
// 名册取自 config/court.yaml 与 config/models.yaml，其余为一套自洽的「朝廷一日」：
//   - 诏令 A（执行中）：草稿 v1 被给事中封驳（缺验收标准）→ v2 通过 → 尚书分派礼/工/刑三部任务（含子任务）
//   - 诏令 B 已完成，诏令 C 起草中，诏令 D 封驳三次升级待圣裁
//   - 议事一场、待办若干、定时任务、资产、账本、科举、稽查、驿报事件
import { parse } from "yaml";
import courtYaml from "../../../../config/court.yaml?raw";
import modelsYaml from "../../../../config/models.yaml?raw";
import type {
  Approval,
  Asset,
  AssetVersion,
  AuditFinding,
  Budget,
  CouncilEntry,
  CourtEvent,
  Deliberation,
  DeptDef,
  Edict,
  EdictDraft,
  EdictReview,
  ExamAnswer,
  ExamDimension,
  ExamQuestion,
  ExamSession,
  Impeachment,
  LedgerEntry,
  Message,
  ModelEntry,
  Notification,
  Official,
  OfficialState,
  OfficialStatus,
  PostDef,
  Registry,
  Schedule,
  ScheduleRun,
  Span,
  Task,
  TraceGraph,
  Transition,
} from "@court/shared/types";
import { EXAM_DIMENSIONS } from "@court/shared/types";
import type { ConfigHistoryRow, CustomProviderSpec, HubClient, LedgerSummaryRow, ProviderAuthType, ProviderInfo, ProviderLoginSession, ProviderModelInfo, SendMessageRes } from "@court/shared/api";
import { ApiError } from "../api/client.ts";
import { live, type LogLine } from "../api/live.ts";
import { streamSource } from "../api/events.tsx";

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const ago = (m: number) => NOW - m * MIN;
let seq = 1000;
const uid = (p: string) => `${p}_${(seq++).toString(36)}`;

// ───────────────────────── 名册 ─────────────────────────
const cy = parse(courtYaml) as any;
const my = parse(modelsYaml) as any;

const depts: DeptDef[] = cy.depts.map((d: any) => ({
  id: d.id,
  name: d.name,
  brief: d.brief ?? "",
  duties: String(d.duties ?? "").trim(),
  host: d.host ?? `dept-${d.id}`,
  port: 8080,
  routing: d.routing ?? {},
  services: d.services ?? [],
  default_schedules: d.default_schedules ?? [],
}));
const posts: PostDef[] = cy.posts.map((p: any) => ({
  post_id: p.post_id,
  dept: p.dept,
  title: p.title,
  rank: p.rank ?? "",
  benguan: p.benguan,
  duties: String(p.duties ?? "").trim(),
  tool_groups: p.tool_groups ?? ["common"],
  roles: p.roles ?? [],
  services: p.services ?? [],
  activity: p.activity ?? "always",
  interruptible_by: ["emperor", "edict", "urgent"],
  default_wait_seconds: 3600,
  approval_sensitive: ["zhengshitang", "menxia", "yushitai", "libu"].includes(p.dept),
  default_schedules: p.default_schedules ?? [],
}));
const DEFAULT_MODEL: string = my.default_model;
// 御史台监察御史空缺（演示「空缺」）
const VACANT = new Set(["yushitai.jiancha"]);
const officials: Official[] = cy.posts
  .filter((p: any) => !VACANT.has(p.post_id))
  .map((p: any, i: number) => ({
    official_id: `of_${p.post_id.replace(/\./g, "_")}`,
    name: p.name,
    model: i % 7 === 3 ? "opencode-go/kimi-k3" : DEFAULT_MODEL,
    thinking: p.thinking ?? (i % 5 === 0 ? "medium" : "low"),
    prompt_overrides: i % 9 === 0 ? "行文务求简明，先结论后理由。" : "",
    extra_tool_groups: [],
    disabled_tool_groups: [],
    status: p.post_id === "hubu.zhushi" ? "suspended" : "active",
    config_version: 1 + (i % 3),
    created_at: ago(60 * 24 * 3),
  }));
const appointments = (cy.posts as any[])
  .filter((p) => !VACANT.has(p.post_id))
  .map((p) => ({ post_id: p.post_id as string, official_id: `of_${String(p.post_id).replace(/\./g, "_")}`, since: ago(60 * 24 * 3) }));
const officialOf = (post: string) => officials.find((o) => o.official_id === `of_${post.replace(/\./g, "_")}`);

const DIM_SCORES: Record<string, Partial<Record<ExamDimension, number>>> = {
  "opencode-go/deepseek-v4.1-flash": { reasoning: 78, instruction: 84, writing: 81, translation: 76, tool_use: 88, json: 92, code: 74, summary: 83 },
  "opencode-go/deepseek-v4-pro": { reasoning: 91, instruction: 87, writing: 85, translation: 82, tool_use: 84, json: 90, code: 88, summary: 86 },
  "opencode-go/kimi-k3": { reasoning: 85, instruction: 80, writing: 90, translation: 88, tool_use: 79, json: 81, code: 77, summary: 89 },
  "opencode-go/glm-5.3-flash": { reasoning: 70, instruction: 75, writing: 78, translation: 72, tool_use: 64, json: 80, code: 66, summary: 74 },
};
const weights: Record<string, Partial<Record<ExamDimension, number>>> = my.fitness_weights ?? {};
function fitness(scores: Partial<Record<ExamDimension, number>>) {
  const out: Record<string, number> = {};
  for (const [d, w] of Object.entries(weights)) {
    let s = 0;
    let t = 0;
    for (const [dim, k] of Object.entries(w)) {
      s += (scores[dim as ExamDimension] ?? 0) * (k ?? 0);
      t += k ?? 0;
    }
    out[d] = t ? Math.round(s / t) : 0;
  }
  return out;
}
const models: ModelEntry[] = my.models.map((m: any, i: number) => {
  const key = `${m.provider}/${m.model_id}`;
  const scores = DIM_SCORES[key];
  const status = scores ? "examined" : key.includes("qwen") ? "examining" : key.includes("mimo") ? "failed" : (m.status ?? "candidate");
  return {
    key,
    provider: m.provider,
    model_id: m.model_id,
    name: m.name ?? m.model_id,
    context_window: 128_000,
    status,
    scores,
    fitness: scores ? fitness(scores) : undefined,
    added_at: ago(60 * 24 * (8 - i)),
  } as ModelEntry;
});

const registry: Registry = {
  version: 7,
  depts,
  posts,
  officials,
  appointments,
  models,
  court_preamble: String(cy.court_preamble ?? ""),
  halted: false,
};

const P = (post: string) => `post:${post}`;

// ───────────────────────── 诏令 A：封驳循环 ─────────────────────────
const EA = "tr_ed_lvling";
const tEA = ago(185);
const edictA: Edict = {
  id: EA,
  title: "撰《贞观律令摘要》并译为英文",
  intent: "朕欲令四方使节知我朝律令大要。着有司摘录贞观律令要点，成文一篇，并译为英文，务求准确。",
  state: "executing",
  version: 14,
  deliberation_id: "dl_lvling",
  skip_review: false,
  drafter_post: "zhongshu.sheren_a",
  reviewer_post: "menxia.jishizhong_a",
  dispatcher_post: "shangshu.youpuye",
  draft_no: 2,
  reject_count: 1,
  remonstrated_draft_nos: [],
  budget_tokens: 400_000,
  deadline: NOW + 5 * HOUR,
  created_at: tEA,
  state_entered_at: ago(96),
  sla_at: NOW + 4 * HOUR,
};
const draft1Text = `门下：
朕闻法者天下之程式，万事之仪表。今命有司摘录贞观律令要点，成文一篇，并译为英文，以示四方。

一、目标：摘录《贞观律》《贞观令》要点，成中文摘要一篇。
二、译为英文一篇。
三、期限：今日之内。
四、承办：礼部、工部。

主者施行。`;
const draft2Text = `门下：
朕闻法者天下之程式，万事之仪表。今命有司摘录贞观律令要点，成文一篇，并译为英文，以示四方。

一、目标：摘录《贞观律》十二篇、《贞观令》要点，成中文摘要一篇，约一千五百字。
二、译为英文一篇，术语依礼部术语表。
三、验收标准：中文摘要覆盖十二篇篇目；英文译本经刑部核验，术语一致率不低于九成五；产物存为朝廷公开资产。
四、期限：今日酉时之前。
五、预算：四十万 token。
六、承办：礼部（翻译润色）、工部（成文营造）、刑部（核验）。

主者施行。`;
const drafts: EdictDraft[] = [
  {
    edict_id: EA,
    no: 1,
    title: edictA.title,
    objective: "摘录贞观律令要点，成文并英译",
    constraints: "今日之内",
    acceptance: "",
    deadline_text: "今日之内",
    budget_tokens: 400_000,
    suggested_depts: ["libu_rites", "gongbu"],
    text: draft1Text,
    responses: [],
    author_post: "zhongshu.sheren_a",
    countersigned_by: "zhongshu.shilang",
    created_at: ago(172),
  },
  {
    edict_id: EA,
    no: 2,
    title: edictA.title,
    objective: "摘录《贞观律》十二篇及《贞观令》要点，成中文摘要约一千五百字，并英译",
    constraints: "术语依礼部术语表；产物公开",
    acceptance: "覆盖十二篇篇目；英译经刑部核验，术语一致率≥95%；存为朝廷公开资产",
    deadline_text: "今日酉时之前",
    budget_tokens: 400_000,
    suggested_depts: ["libu_rites", "gongbu", "xingbu"],
    text: draft2Text,
    responses: [
      { issue_id: "iss_1", response: "已补验收标准三条，并增刑部核验。" },
      { issue_id: "iss_2", response: "期限改为「今日酉时之前」。" },
    ],
    author_post: "zhongshu.sheren_a",
    countersigned_by: "zhongshu.shilang",
    created_at: ago(128),
  },
];
const reviews: EdictReview[] = [
  {
    id: "rv_1",
    edict_id: EA,
    draft_no: 1,
    reviewer_post: "menxia.jishizhong_a",
    decision: "reject",
    issues: [
      { id: "iss_1", severity: "blocking", clause: "全文", reason: "缺验收标准", required_change: "须写明摘要覆盖范围与译文核验方式" },
      { id: "iss_2", severity: "advisory", clause: "三、期限", reason: "表述不清", required_change: "「今日之内」宜改为具体时辰" },
    ],
    opinion: "草诏无验收之法，承办者无所依凭，谨封还中书。",
    created_at: ago(150),
  },
  {
    id: "rv_2",
    edict_id: EA,
    draft_no: 2,
    reviewer_post: "menxia.jishizhong_a",
    decision: "approve",
    issues: [],
    opinion: "前驳二事俱已改正，准。",
    created_at: ago(112),
  },
];
const mkTask = (t: Partial<Task> & Pick<Task, "id" | "dept" | "title" | "state">): Task => ({
  trace_id: EA,
  edict_id: EA,
  creator: P("shangshu.youpuye"),
  instructions: "",
  acceptance: "",
  verify_by: "superior",
  version: 3,
  result_assets: [],
  return_count: 0,
  reassign_count: 0,
  created_at: ago(95),
  updated_at: ago(20),
  state_entered_at: ago(20),
  ...t,
});
const tasks: Task[] = [
  mkTask({
    id: "tk_rites",
    dept: "libu_rites",
    assignee_post: "libu_rites.zhuke_langzhong",
    title: "英译律令摘要并统一术语",
    instructions: "待工部成文后译为英文，术语依术语表。",
    acceptance: "术语一致率≥95%",
    state: "done",
    result: "英译完成，术语 46 条全部对齐。",
    result_assets: ["as_en"],
    deadline: NOW + 3 * HOUR,
    state_entered_at: ago(22),
  }),
  mkTask({
    id: "tk_gong",
    dept: "gongbu",
    assignee_post: "gongbu.langzhong",
    title: "营造中文摘要成文",
    instructions: "摘录十二篇篇目与要点，约一千五百字。",
    acceptance: "覆盖十二篇",
    state: "in_progress",
    deadline: NOW + 2 * HOUR,
    state_entered_at: ago(70),
  }),
  mkTask({
    id: "tk_gong_sub",
    dept: "gongbu",
    parent_id: "tk_gong",
    assignee_post: "gongbu.shilang",
    creator: P("gongbu.langzhong"),
    title: "核对《名例律》《卫禁律》原文",
    state: "submitted",
    verify_by: "superior",
    result: "两篇原文已核，附出处。",
    state_entered_at: ago(12),
  }),
  mkTask({
    id: "tk_xing",
    dept: "xingbu",
    assignee_post: "xingbu.langzhong",
    title: "核验英译与摘要",
    instructions: "按验收标准核验交付物。",
    acceptance: "出具核验意见",
    verify_by: "self",
    state: "blocked",
    block_reason: "等工部成文后方可核验",
    deadline: NOW + 4 * HOUR,
    state_entered_at: ago(40),
  }),
];
const transitionsA: Transition[] = [
  [null, "issued", "emperor", "陛下照准颁旨", 185],
  ["issued", "drafting", "system:hub", "指派中书舍人王季昶", 184],
  ["drafting", "reviewing", P("zhongshu.sheren_a"), "草稿 1 号提交", 170],
  ["reviewing", "drafting", P("menxia.jishizhong_a"), "封驳：缺验收标准", 150],
  ["drafting", "reviewing", P("zhongshu.sheren_a"), "草稿 2 号提交", 127],
  ["reviewing", "approved", P("menxia.jishizhong_a"), "审核通过", 112],
  ["approved", "executing", P("shangshu.youpuye"), "分派礼、工、刑三部", 96],
].map(([f, t, a, r, m], i) => ({ id: i + 1, subject_type: "edict", subject_id: EA, from_state: (f as string) ?? "", to_state: t as string, actor: a as string, reason: r as string, at: ago(m as number) }));

// 其他诏令
const edictB: Edict = {
  ...edictA,
  id: "tr_ed_shuili",
  title: "查核关中水利渠堰簿籍",
  intent: "着工部查核关中诸渠堰现状，造册奏闻。",
  state: "completed",
  draft_no: 1,
  reject_count: 0,
  deliberation_id: undefined,
  created_at: ago(60 * 26),
  state_entered_at: ago(60 * 20),
  report: { summary: "关中渠堰三十七处，完好二十九，待修八处，已造册存档。", failures: "", by: P("shangshu.youpuye"), at: ago(60 * 20) },
  deadline: undefined,
  sla_at: undefined,
};
const edictC: Edict = {
  ...edictA,
  id: "tr_ed_kaoke",
  title: "定本年考课条格",
  intent: "考功司拟定今年考课条格，四善二十七最。",
  state: "drafting",
  draft_no: 0,
  reject_count: 0,
  drafter_post: "zhongshu.sheren_b",
  created_at: ago(18),
  state_entered_at: ago(17),
  budget_tokens: 150_000,
};
const edictD: Edict = {
  ...edictA,
  id: "tr_ed_bianshi",
  title: "增置西域互市监",
  intent: "于西州增置互市监，掌蕃汉交易。",
  state: "escalated",
  draft_no: 4,
  reject_count: 3,
  reviewer_post: "menxia.jishizhong_b",
  created_at: ago(60 * 7),
  state_entered_at: ago(35),
  budget_tokens: 300_000,
};
const edictE: Edict = {
  ...edictA,
  id: "tr_ed_yishu",
  title: "编修《诸司职掌》一卷",
  intent: "礼部会同吏部编修诸司职掌。",
  state: "blocked_budget",
  draft_no: 1,
  reject_count: 0,
  created_at: ago(60 * 3),
  state_entered_at: ago(25),
  budget_tokens: 80_000,
};
const edicts: Edict[] = [edictA, edictC, edictD, edictE, edictB];

// ───────────────────────── 追踪：spans / links / events / ledger ─────────────────────────
const spans: Span[] = [];
const links: TraceGraph["links"] = [];
const traceEvents: CourtEvent[] = [];
const ledgerRows: LedgerEntry[] = [];
let evId = 50_000;

function span(s: Omit<Span, "trace_id"> & { trace_id?: string }): Span {
  const x: Span = { trace_id: EA, ...s };
  spans.push(x);
  return x;
}
function ev(e: Omit<CourtEvent, "id" | "uid">): CourtEvent {
  const x: CourtEvent = { id: evId++, uid: uid("ev"), ...e };
  traceEvents.push(x);
  return x;
}
/** 一个轮次：turn span + LLM 调用 + 工具调用，返回 turn span */
function turn(parent: string, post: string, startMin: number, durMin: number, tools: string[], opts: { status?: Span["status"]; tokens?: number } = {}) {
  const tid = uid("tu");
  const t = span({
    span_id: uid("sp"),
    parent_span_id: parent,
    kind: "turn",
    name: `轮次 · ${tools[tools.length - 1] ?? "思考"}`,
    actor: P(post),
    status: opts.status ?? "ok",
    started_at: ago(startMin),
    ended_at: opts.status === "running" ? undefined : ago(startMin - durMin),
    attrs: { turn_id: tid, wake_reason: "新来信" },
  });
  const dept = post.split(".")[0];
  ev({ ts: t.started_at, type: "turn.start", actor: P(post), dept, trace_id: EA, span_id: t.span_id, parent_span_id: parent, summary: `${post} 开始一轮` });
  const per = (durMin * MIN) / Math.max(1, tools.length + 1);
  tools.forEach((name, i) => {
    const st = t.started_at + per * (i + 0.6);
    const tokens = Math.round((opts.tokens ?? 9000) / (tools.length + 1));
    ledgerRows.push({
      id: uid("lg"),
      idem_key: `${tid}:${i}`,
      ts: st - 2000,
      post_id: post,
      official_id: officialOf(post)?.official_id ?? "",
      dept,
      trace_id: EA,
      turn_id: tid,
      purpose: "turn",
      provider: "opencode-go",
      model: officialOf(post)?.model.split("/")[1] ?? "deepseek-v4.1-flash",
      input: Math.round(tokens * 0.82),
      output: Math.round(tokens * 0.18),
      cache_read: Math.round(tokens * 0.4),
      cache_write: 0,
      total_tokens: tokens,
      cost: tokens * 0.0000009,
      duration_ms: 2400 + i * 900,
      ok: true,
    });
    ev({ ts: st - 2000, type: "llm.call", actor: P(post), dept, trace_id: EA, span_id: t.span_id, summary: `LLM 调用 ${tokens} tokens`, data: { tokens, model: DEFAULT_MODEL } });
    const isErr = name.endsWith("!");
    const tool = span({
      span_id: uid("sp"),
      parent_span_id: t.span_id,
      kind: "tool",
      name: name.replace("!", ""),
      actor: P(post),
      status: isErr ? "error" : opts.status === "running" && i === tools.length - 1 ? "running" : "ok",
      started_at: st,
      ended_at: opts.status === "running" && i === tools.length - 1 ? undefined : st + 1800,
      attrs: { args: { note: "…" }, ...(isErr ? { error: "沙箱超时：命令执行超过 60 秒" } : {}) },
    });
    ev({
      ts: st,
      type: isErr ? "tool.error" : "tool.call",
      actor: P(post),
      dept,
      trace_id: EA,
      span_id: tool.span_id,
      parent_span_id: t.span_id,
      summary: `${isErr ? "工具出错" : "调用工具"} ${tool.name}`,
    });
  });
  if (opts.status !== "running")
    ev({ ts: t.ended_at!, type: "turn.end", actor: P(post), dept, trace_id: EA, span_id: t.span_id, summary: `${post} 结束一轮` });
  return t;
}
function message(fromSpan: Span, toSpan: Span, from: string, to: string, subject: string, atMin: number, kind: "message" | "service" | "causes" = "message") {
  const m = span({
    span_id: uid("sp"),
    parent_span_id: fromSpan.span_id,
    kind: kind === "service" ? "service" : "message",
    name: subject,
    actor: from,
    status: "ok",
    started_at: ago(atMin),
    ended_at: ago(atMin - 0.2),
    attrs: { to },
  });
  links.push({ from_span: fromSpan.span_id, to_span: toSpan.span_id, kind, label: subject });
  ev({ ts: ago(atMin), type: kind === "service" ? "service.call" : "message.sent", actor: from, dept: from.split(":")[1]?.split(".")[0], trace_id: EA, span_id: m.span_id, summary: `${subject} → ${to}`, data: { to } });
  return m;
}

const sEdict = span({ span_id: "sp_edict", kind: "edict", name: edictA.title, actor: "emperor", status: "running", started_at: tEA, attrs: { edict_id: EA } });
ev({ ts: tEA, type: "edict.state", actor: "emperor", trace_id: EA, span_id: sEdict.span_id, subject_type: "edict", subject_id: EA, summary: "陛下颁旨：" + edictA.title, data: { to: "issued" } });
const sDelib = span({ span_id: "sp_delib", parent_span_id: sEdict.span_id, kind: "deliberation", name: "政事堂议：律令外译", actor: P("zhengshitang.zhongshuling"), status: "ok", started_at: ago(240), ended_at: ago(190), attrs: { deliberation_id: "dl_lvling" } });
turn(sDelib.span_id, "zhengshitang.zhongshuling", 238, 6, ["council_get", "council_speak"]);
turn(sDelib.span_id, "zhengshitang.shizhong", 228, 4, ["council_speak"]);
turn(sDelib.span_id, "zhengshitang.zhongshuling", 200, 8, ["council_conclude"], { tokens: 14000 });

const sD1 = span({ span_id: "sp_draft1", parent_span_id: sEdict.span_id, kind: "draft", name: "草稿 1 号", actor: P("zhongshu.sheren_a"), status: "rejected", started_at: ago(183), ended_at: ago(170), attrs: { draft_no: 1, edict_id: EA } });
turn(sD1.span_id, "zhongshu.sheren_a", 182, 11, ["edict_get", "asset_read", "edict_submit_draft"], { tokens: 21000 });
turn(sD1.span_id, "zhongshu.shilang", 171, 1.2, ["edict_countersign"]);
const sR1 = span({ span_id: "sp_review1", parent_span_id: sEdict.span_id, kind: "review", name: "审核 草稿 1 号 · 封驳", actor: P("menxia.jishizhong_a"), status: "rejected", started_at: ago(168), ended_at: ago(150), attrs: { draft_no: 1, review_id: "rv_1", decision: "reject" } });
const tR1 = turn(sR1.span_id, "menxia.jishizhong_a", 166, 15, ["edict_get", "edict_diff", "edict_review"], { tokens: 17000 });
const sD2 = span({ span_id: "sp_draft2", parent_span_id: sEdict.span_id, kind: "draft", name: "草稿 2 号", actor: P("zhongshu.sheren_a"), status: "ok", started_at: ago(148), ended_at: ago(127), attrs: { draft_no: 2, edict_id: EA } });
const tD2 = turn(sD2.span_id, "zhongshu.sheren_a", 147, 19, ["edict_get", "send_message", "edict_submit_draft"], { tokens: 26000 });
links.push({ from_span: sR1.span_id, to_span: sD2.span_id, kind: "causes", label: "封驳退回" });
message(tR1, tD2, P("menxia.jishizhong_a"), P("zhongshu.sheren_a"), "封驳意见：缺验收标准", 150);
const sR2 = span({ span_id: "sp_review2", parent_span_id: sEdict.span_id, kind: "review", name: "审核 草稿 2 号 · 准", actor: P("menxia.jishizhong_a"), status: "ok", started_at: ago(125), ended_at: ago(112), attrs: { draft_no: 2, review_id: "rv_2", decision: "approve" } });
turn(sR2.span_id, "menxia.jishizhong_a", 124, 11, ["edict_get", "edict_diff", "edict_review"], { tokens: 15000 });
const sDp = span({ span_id: "sp_dispatch", parent_span_id: sEdict.span_id, kind: "dispatch", name: "分派三部", actor: P("shangshu.youpuye"), status: "ok", started_at: ago(108), ended_at: ago(96), attrs: { edict_id: EA } });
const tDp = turn(sDp.span_id, "shangshu.youpuye", 107, 10, ["edict_get", "list_departments", "edict_dispatch"], { tokens: 19000 });

const sT1 = span({ span_id: "sp_task_rites", parent_span_id: sDp.span_id, kind: "task", name: "礼部：英译律令摘要", actor: P("libu_rites.zhuke_langzhong"), status: "ok", started_at: ago(95), ended_at: ago(22), attrs: { task_id: "tk_rites", dept: "libu_rites" } });
const tT1a = turn(sT1.span_id, "libu_rites.shangshu", 94, 2, ["task_assign"]);
const tT1 = turn(sT1.span_id, "libu_rites.zhuke_langzhong", 60, 30, ["task_start", "glossary_get", "asset_read", "asset_write", "task_submit"], { tokens: 42000 });
message(tT1a, tT1, P("libu_rites.shangshu"), P("libu_rites.zhuke_langzhong"), "任务交办", 92);
const sT2 = span({ span_id: "sp_task_gong", parent_span_id: sDp.span_id, kind: "task", name: "工部：营造中文摘要", actor: P("gongbu.langzhong"), status: "running", started_at: ago(95), attrs: { task_id: "tk_gong", dept: "gongbu" } });
const tT2 = turn(sT2.span_id, "gongbu.langzhong", 88, 20, ["task_start", "ws_write", "ws_run!", "task_create_subtask"], { tokens: 31000 });
const sT2s = span({ span_id: "sp_task_gong_sub", parent_span_id: sT2.span_id, kind: "task", name: "子任务：核对原文", actor: P("gongbu.shilang"), status: "ok", started_at: ago(66), ended_at: ago(12), attrs: { task_id: "tk_gong_sub", dept: "gongbu" } });
const tT2s = turn(sT2s.span_id, "gongbu.shilang", 50, 30, ["task_start", "http_fetch", "asset_write", "task_submit"], { tokens: 28000 });
message(tT2, tT2s, P("gongbu.langzhong"), P("gongbu.shilang"), "子任务交办", 67);
turn(sT2.span_id, "gongbu.langzhong", 8, 8, ["task_get", "asset_read", "ws_write"], { status: "running", tokens: 12000 });
const sT3 = span({ span_id: "sp_task_xing", parent_span_id: sDp.span_id, kind: "task", name: "刑部：核验英译", actor: P("xingbu.langzhong"), status: "running", started_at: ago(95), attrs: { task_id: "tk_xing", dept: "xingbu", blocked: true } });
const tT3 = turn(sT3.span_id, "xingbu.langzhong", 42, 4, ["task_get", "task_block"]);
const svc = span({ span_id: "sp_svc_verify", parent_span_id: tT1.span_id, kind: "service", name: "服务 verify（刑部）", actor: P("libu_rites.zhuke_langzhong"), status: "ok", started_at: ago(35), ended_at: ago(24), attrs: { service: "verify", request_id: "sr_1" } });
links.push({ from_span: tT1.span_id, to_span: svc.span_id, kind: "service", label: "请刑部核术语" });
const tSvc = turn(svc.span_id, "xingbu.shilang", 34, 9, ["asset_read", "service_respond"], { tokens: 11000 });
links.push({ from_span: svc.span_id, to_span: tSvc.span_id, kind: "service", label: "verify" });
message(tDp, tT3, P("shangshu.youpuye"), "dept:xingbu", "任务下达：核验英译", 96);
message(tDp, tT1a, P("shangshu.youpuye"), "dept:libu_rites", "任务下达：英译", 96);
message(tDp, tT2, P("shangshu.youpuye"), "dept:gongbu", "任务下达：营造摘要", 96);
ev({ ts: ago(150), type: "edict.state", actor: P("menxia.jishizhong_a"), trace_id: EA, span_id: sR1.span_id, subject_type: "edict", subject_id: EA, summary: "门下封驳：缺验收标准", data: { from: "reviewing", to: "drafting" } });
ev({ ts: ago(112), type: "edict.state", actor: P("menxia.jishizhong_a"), trace_id: EA, span_id: sR2.span_id, subject_type: "edict", subject_id: EA, summary: "门下审核通过", data: { from: "reviewing", to: "approved" } });
ev({ ts: ago(96), type: "edict.state", actor: P("shangshu.youpuye"), trace_id: EA, span_id: sDp.span_id, subject_type: "edict", subject_id: EA, summary: "尚书分派三部", data: { from: "approved", to: "executing" } });
ev({ ts: ago(40), type: "task.state", actor: P("xingbu.langzhong"), dept: "xingbu", trace_id: EA, span_id: sT3.span_id, subject_type: "task", subject_id: "tk_xing", summary: "刑部任务受阻：等工部成文", data: { to: "blocked" } });
ev({ ts: ago(22), type: "task.state", actor: P("libu_rites.shangshu"), dept: "libu_rites", trace_id: EA, span_id: sT1.span_id, subject_type: "task", subject_id: "tk_rites", summary: "礼部任务办结", data: { to: "done" } });
traceEvents.sort((a, b) => a.ts - b.ts);
// 近一时辰的署衙往来（朝堂「消息流热力」用）
for (const [from, to, m] of [
  ["post:gongbu.langzhong", "post:xingbu.langzhong", 50], ["post:xingbu.langzhong", "post:gongbu.langzhong", 41], ["post:gongbu.langzhong", "post:gongbu.shilang", 38],
  ["post:libu_rites.zhuke_langzhong", "dept:xingbu", 35], ["post:xingbu.shilang", "post:libu_rites.zhuke_langzhong", 25], ["emperor", "post:hubu.duzhi_langzhong", 30],
  ["post:hubu.duzhi_langzhong", "emperor", 26], ["post:shangshu.dushi", "dept:gongbu", 18], ["post:shangshu.dushi", "dept:xingbu", 17], ["post:yushitai.shiyushi", "post:bingbu.jiabu_langzhong", 12],
  ["post:zhongshu.sheren_b", "post:libu.kaogong_langzhong", 9], ["post:libu.kaogong_langzhong", "post:zhongshu.sheren_b", 6], ["post:gongbu.shilang", "post:gongbu.langzhong", 5],
] as [string, string, number][]) {
  ev({ ts: ago(m), type: "message.sent", actor: from, dept: from.split(":")[1]?.split(".")[0], trace_id: EA, summary: `文书 → ${to}`, data: { to } });
}
traceEvents.sort((a, b) => a.ts - b.ts);


// ───────────────────────── 心跳 ─────────────────────────
const STATE_CYCLE: OfficialState[] = ["sleeping", "waiting", "idle", "sleeping", "waiting", "sleeping", "idle"];
const statuses: OfficialStatus[] = posts.map((p, i) => {
  const o = officialOf(p.post_id);
  let state: OfficialState = STATE_CYCLE[i % STATE_CYCLE.length];
  let text: string | undefined;
  let trace: string | undefined;
  if (VACANT.has(p.post_id)) state = "vacant";
  else if (p.post_id === "gongbu.langzhong") ((state = "thinking"), (text = "撰写摘要第七篇《斗讼律》"), (trace = EA));
  else if (p.post_id === "gongbu.shilang") ((state = "tool"), (text = "ws_run 校对脚本"), (trace = EA));
  else if (p.post_id === "xingbu.langzhong") ((state = "waiting"), (text = "等工部成文"), (trace = EA));
  else if (p.post_id === "zhongshu.sheren_b") ((state = "thinking"), (text = "起草考课条格"), (trace = "tr_ed_kaoke"));
  else if (p.post_id === "hubu.zhushi") ((state = "suspended"), (text = "停俸：本日预算已尽"));
  else if (p.post_id === "bingbu.jiabu_langzhong") ((state = "sick"), (text = "提供商 503，候诊中"));
  else if (p.post_id === "yushitai.dianzhong") state = "offline";
  else if (p.post_id === "libu.kaogong_langzhong") ((state = "paused"), (text = "吏部暂停以调整配置"));
  const tokens = state === "vacant" ? 0 : Math.round(3000 + ((i * 7919) % 60000) + (trace ? 40000 : 0));
  return {
    post_id: p.post_id,
    official_id: o?.official_id,
    dept: p.dept,
    state,
    status_text: text ?? (state === "sleeping" ? "无事，静候" : state === "waiting" ? "候回信" : undefined),
    current_trace_id: trace,
    current_turn_id: trace ? uid("tu") : undefined,
    next_wake_at: state === "sleeping" ? NOW + ((i % 5) + 1) * 37 * MIN : state === "waiting" ? NOW + ((i % 3) + 1) * 20 * MIN : undefined,
    wait_filter: state === "waiting" ? { from: [P(p.post_id === "xingbu.langzhong" ? "gongbu.langzhong" : "shangshu.dushi")], trace_id: trace } : undefined,
    last_progress_at: ago((i % 11) * 3 + 1),
    turns_last_hour: state === "thinking" ? 6 : i % 4,
    tokens_today: tokens,
    context_tokens: state === "vacant" ? undefined : 8000 + ((i * 3331) % 50000),
    updated_at: ago(0.2),
  };
});

// ───────────────────────── 议事 ─────────────────────────
const delib: Deliberation = {
  id: "dl_lvling",
  trace_id: EA,
  topic: "律令外译，以示四方",
  state: "concluded",
  chair_post: "zhengshitang.zhongshuling",
  members: ["zhengshitang.zhongshuling", "zhengshitang.shizhong", "zhengshitang.zuopuye", "zhengshitang.tongsanpin"],
  session_no: 1,
  round: 2,
  max_rounds: 2,
  speaker_queue: [],
  current_speaker: undefined,
  conclusion: {
    summary: "宜撰律令摘要一篇并英译，由礼部主译、工部成文、刑部核验，今日内毕。",
    dissent: "侍中以为英译术语须先定表，否则恐生歧义。",
    proposed_edict: { title: "撰《贞观律令摘要》并译为英文", intent: "摘录贞观律令要点成文并英译" },
    confidence: 0.82,
    concluded_by: "zhengshitang.zhongshuling",
    at: ago(195),
  },
  token_spent: 48_200,
  version: 9,
  created_at: ago(242),
  updated_at: ago(195),
};
const delib2: Deliberation = {
  id: "dl_bianfang",
  trace_id: "tr_dl_bianfang",
  topic: "陇右边防粮草调度",
  state: "open",
  chair_post: "zhengshitang.zhongshuling",
  members: delib.members,
  session_no: 1,
  round: 1,
  max_rounds: 2,
  speaker_queue: ["zhengshitang.zuopuye", "zhengshitang.tongsanpin"],
  current_speaker: "zhengshitang.zuopuye",
  token_spent: 12_400,
  version: 3,
  created_at: ago(14),
  updated_at: ago(3),
};
const entries: CouncilEntry[] = [
  { id: "ce1", deliberation_id: "dl_lvling", session_no: 1, round: 1, author: "emperor", content: "朕欲令四方使节知我朝律令大要，诸卿以为如何？", created_at: ago(242) },
  { id: "ce2", deliberation_id: "dl_lvling", session_no: 1, round: 1, author: P("zhengshitang.zhongshuling"), stance: "support", content: "臣以为可。律令乃国之纲纪，示之四方，可彰教化。宜先成中文摘要，再付译事。", created_at: ago(236) },
  { id: "ce3", deliberation_id: "dl_lvling", session_no: 1, round: 1, author: P("zhengshitang.shizhong"), stance: "reserve", content: "臣附议，然英译术语须先定表。若「十恶」「八议」之属译名不一，反生歧义。", created_at: ago(226) },
  { id: "ce4", deliberation_id: "dl_lvling", session_no: 1, round: 1, author: P("zhengshitang.zuopuye"), stance: "support", content: "礼部主客司通译事，工部可营造成文，刑部核验。今日可毕。", created_at: ago(218) },
  { id: "ce5", deliberation_id: "dl_lvling", session_no: 1, round: 1, author: P("zhengshitang.tongsanpin"), stance: "support", content: "预算以四十万 token 为限，足矣。", created_at: ago(210) },
  { id: "ce6", deliberation_id: "dl_lvling", session_no: 1, round: 2, author: P("zhengshitang.zhongshuling"), stance: "support", content: "综诸公之议：宜撰律令摘要一篇并英译，礼部主译、工部成文、刑部核验。侍中所虑术语一事，令礼部依术语表行之。谨奏。", created_at: ago(196) },
  { id: "ce7", deliberation_id: "dl_bianfang", session_no: 1, round: 1, author: "emperor", content: "陇右今冬粮草可足？诸卿议之。", created_at: ago(14) },
  { id: "ce8", deliberation_id: "dl_bianfang", session_no: 1, round: 1, author: P("zhengshitang.zhongshuling"), stance: "reserve", content: "户部账目未齐，臣请先令度支郎中核报存粮，再议调度。", created_at: ago(9) },
  { id: "ce9", deliberation_id: "dl_bianfang", session_no: 1, round: 1, author: P("zhengshitang.shizhong"), stance: "oppose", content: "臣以为不宜遽增调度，恐扰民。", created_at: ago(4) },
];

// ───────────────────────── 待办 ─────────────────────────
const notifications: Notification[] = [
  {
    id: "nt_esc",
    kind: "action_required",
    category: "escalation",
    title: "《增置西域互市监》三次封驳，请陛下圣裁",
    body: "门下给事中杨思谦三次封驳，理由：与前诏冲突（贞观四年互市令）、超预算。中书舍人坚持原案。",
    from: "system:watchdog",
    related: { type: "edict", id: "tr_ed_bianshi" },
    options: [
      { id: "force_approve", label: "墨敕照准" },
      { id: "withdraw", label: "撤回" },
      { id: "revise", label: "朕意修改" },
    ],
    status: "pending",
    trace_id: "tr_ed_bianshi",
    created_at: ago(35),
  },
  {
    id: "nt_council",
    kind: "action_required",
    category: "council_conclusion",
    title: "政事堂奏：律令外译",
    body: "宜撰律令摘要一篇并英译……（议事已照准）",
    from: P("zhengshitang.zhongshuling"),
    related: { type: "deliberation", id: "dl_lvling" },
    options: [
      { id: "approve", label: "照准颁旨" },
      { id: "reconvene", label: "再议" },
      { id: "shelve", label: "搁置" },
    ],
    status: "resolved",
    resolution: { option: "approve", comment: "准。", at: ago(186) },
    trace_id: EA,
    created_at: ago(195),
  },
  {
    id: "nt_remon",
    kind: "action_required",
    category: "remonstrance",
    title: "左散骑常侍魏孝恭谏：考课条格宜缓",
    body: "风险：条格骤改，百官无所适从。替代：先试行于吏部一司，三月后推及诸司。",
    from: P("menxia.zuo_sanqi"),
    related: { type: "edict", id: "tr_ed_kaoke" },
    options: [
      { id: "insist", label: "坚持原旨" },
      { id: "revise", label: "采纳修改" },
      { id: "withdraw", label: "撤回" },
    ],
    status: "pending",
    trace_id: "tr_ed_kaoke",
    created_at: ago(11),
  },
  {
    id: "nt_appr",
    kind: "action_required",
    category: "approval",
    title: "吏部请调整给事中杨思谦思考强度：low → high",
    body: "理由：近三次审核遗漏前诏冲突。此职位属审批敏感，须陛下批准。",
    from: P("libu.shangshu"),
    related: { type: "approval", id: "ap_1" },
    options: [
      { id: "approve", label: "准" },
      { id: "reject", label: "驳" },
    ],
    status: "pending",
    created_at: ago(48),
  },
  {
    id: "nt_imp",
    kind: "action_required",
    category: "impeachment",
    title: "侍御史李乾祐劾驾部郎中段志玄德空转",
    body: "一小时内醒来 18 次，均无产出，耗 6.2 万 token。证据见稽查发现 af_2。",
    from: P("yushitai.shiyushi"),
    related: { type: "impeachment", id: "im_1" },
    options: [
      { id: "reject", label: "驳回" },
      { id: "to_libu", label: "交吏部整改" },
      { id: "to_hubu", label: "交户部降黜" },
      { id: "to_xingbu", label: "交刑部复核" },
    ],
    status: "pending",
    created_at: ago(70),
  },
  {
    id: "nt_budget",
    kind: "action_required",
    category: "budget",
    title: "预算熔断：trace:tr_ed_yishu",
    body: "trace:tr_ed_yishu 今日预算已用尽，《编修诸司职掌》尚有 2 项任务未结。\n可选：增拨（今日额度翻倍）或维持（受影响官员停俸至明日）。",
    from: "system:hub",
    related: { type: "budget_scope", id: "trace:tr_ed_yishu" },
    options: [
      { id: "raise", label: "增拨（日额翻倍）" },
      { id: "keep", label: "维持" },
    ],
    status: "pending",
    trace_id: "tr_ed_yishu",
    created_at: ago(25),
  },
  {
    id: "nt_fyi1",
    kind: "fyi",
    category: "progress",
    title: "早朝汇总：昨日诏令三道，办结两道",
    body: "## 昨日\n- 《查核关中水利》已复奏御览\n- 《编修诸司职掌》预算熔断\n\n## 异常\n驾部郎中空转，御史台已劾。",
    from: P("zhengshitang.zhongshuling"),
    options: [],
    status: "pending",
    created_at: ago(60 * 3),
  },
  {
    id: "nt_audit",
    kind: "fyi",
    category: "audit_report",
    title: "御史台监察日报",
    body: "## 今日稽查\n- 规则命中 4 起：空转 1、工具报错 2、超期 1\n- 已弹劾 1 起\n\n## 建议\n兵部沙箱超时频发，宜请工部检修。",
    from: P("yushitai.dafu"),
    options: [],
    status: "pending",
    created_at: ago(60 * 9),
  },
  {
    id: "nt_report",
    kind: "action_required",
    category: "report",
    title: "尚书省复奏：《查核关中水利渠堰簿籍》",
    body: "关中渠堰三十七处，完好二十九，待修八处，已造册存档。",
    from: P("shangshu.youpuye"),
    related: { type: "edict", id: "tr_ed_shuili" },
    options: [
      { id: "accept", label: "御览准奏" },
      { id: "reopen", label: "发回重办" },
    ],
    status: "resolved",
    resolution: { option: "accept", comment: "", at: ago(60 * 19) },
    created_at: ago(60 * 20),
  },
];

// ───────────────────────── 消息 ─────────────────────────
const messages: Message[] = [];
function msg(m: Partial<Message> & Pick<Message, "from" | "to" | "subject" | "body">, atMin: number): Message {
  const x: Message = {
    id: uid("ms"),
    cc: [],
    kind: "chat",
    requires_reply: false,
    thread_id: uid("th"),
    trace_id: EA,
    span_id: uid("sp"),
    priority: "normal",
    hop_count: 0,
    created_at: ago(atMin),
    ...m,
  };
  messages.push(x);
  return x;
}
msg({ from: P("menxia.jishizhong_a"), to: P("zhongshu.sheren_a"), kind: "edict_notice", subject: "封驳：缺验收标准", body: "草诏无验收之法，承办者无所依凭，谨封还中书。请补验收标准。" }, 150);
msg({ from: P("shangshu.youpuye"), to: "dept:gongbu", kind: "task_notice", subject: "任务下达：营造中文摘要", body: "摘录十二篇篇目与要点，约一千五百字。" }, 96);
msg({ from: P("shangshu.youpuye"), to: "dept:libu_rites", kind: "task_notice", subject: "任务下达：英译", body: "待工部成文后译为英文。" }, 96);
msg({ from: P("shangshu.youpuye"), to: "dept:xingbu", kind: "task_notice", subject: "任务下达：核验英译", body: "按验收标准核验。" }, 96);
msg({ from: P("gongbu.langzhong"), to: P("gongbu.shilang"), kind: "task_notice", subject: "子任务：核对原文", body: "请核对《名例律》《卫禁律》原文并附出处。", requires_reply: true }, 67);
msg({ from: P("xingbu.langzhong"), to: P("gongbu.langzhong"), subject: "成文几时可得？", body: "刑部候核，请示成文时辰。", requires_reply: true }, 41);
msg({ from: P("gongbu.langzhong"), to: P("xingbu.langzhong"), subject: "回：成文几时可得？", body: "约未时可毕。", reply_to: messages[messages.length - 1].id }, 39);
const oral = msg({ from: "emperor", to: P("hubu.duzhi_langzhong"), kind: "oral_order", subject: "口谕", body: "今日各部用度几何？速报。", requires_reply: true, trace_id: "tr_oral1" }, 30);
msg({ from: P("hubu.duzhi_langzhong"), to: "emperor", subject: "回奏：今日用度", body: "启奏陛下：今日共耗 186 万 token，约 $1.72。工部、礼部居前，皆因律令外译。户部主事已停俸。", reply_to: oral.id, trace_id: "tr_oral1" }, 26);
msg({ from: "emperor", to: P("menxia.jishizhong_a"), subject: "私聊", body: "卿封驳之由，朕已览。卿以为中书所改可当否？", requires_reply: true, trace_id: "tr_chat1" }, 100);
msg({ from: P("menxia.jishizhong_a"), to: "emperor", subject: "回：私聊", body: "臣以为可当。验收三条俱明，刑部核验亦妥。唯期限稍紧，臣已附议。", trace_id: "tr_chat1" }, 98);
msg({ from: P("yushitai.dafu"), to: "emperor", kind: "audit", subject: "监察日报已上", body: "陛下，今日稽查奏报已呈御书房。", trace_id: "tr_audit" }, 60 * 9);
msg({ from: P("libu_rites.zhuke_langzhong"), to: "dept:xingbu", kind: "service_request", subject: "服务 verify：英译术语", body: "请核术语一致率。" }, 35);

// ───────────────────────── 定时任务 ─────────────────────────
const schedules: Schedule[] = [];
for (const p of cy.posts as any[]) {
  for (const d of p.default_schedules ?? []) {
    schedules.push({
      id: uid("sc"),
      owner: P(p.post_id),
      created_by: "system:hub",
      title: d.title,
      spec: d.spec,
      tz: "Asia/Shanghai",
      jitter_seconds: 30,
      payload: d.payload,
      enabled: true,
      status: "active",
      next_run_at: undefined,
      last_run_at: ago(60 * 5),
      run_count: 12,
      missed_count: p.post_id === "shangshu.dushi" ? 2 : 0,
      created_at: ago(60 * 24 * 3),
      updated_at: ago(60 * 24),
    });
  }
}
for (const d of cy.depts as any[]) {
  for (const s of d.default_schedules ?? []) {
    schedules.push({ id: uid("sc"), owner: `dept:${d.id}`, created_by: "system:hub", title: s.title, spec: s.spec, tz: "Asia/Shanghai", jitter_seconds: 0, payload: s.payload, enabled: true, status: "active", run_count: 3, missed_count: 0, created_at: ago(4000), updated_at: ago(4000) });
  }
}
schedules.push({
  id: "sc_custom",
  owner: "dept:bingbu",
  created_by: P("bingbu.shangshu"),
  title: "巡检沙箱健康",
  spec: { every_seconds: 600 },
  tz: "Asia/Shanghai",
  jitter_seconds: 20,
  payload: "检查沙箱是否可用，有异常报告兵部尚书。",
  enabled: true,
  status: "pending_approval",
  run_count: 0,
  missed_count: 0,
  created_at: ago(30),
  updated_at: ago(30),
});
schedules.push({
  id: "sc_paused",
  owner: P("libu_rites.langzhong"),
  created_by: P("libu_rites.langzhong"),
  title: "每周整理术语表",
  spec: { cron: "0 10 * * 1" },
  tz: "Asia/Shanghai",
  jitter_seconds: 0,
  payload: "整理本周新增术语。",
  enabled: false,
  status: "paused",
  run_count: 4,
  missed_count: 1,
  created_at: ago(60 * 24 * 20),
  updated_at: ago(60 * 24 * 2),
});
const scheduleRuns: Record<string, ScheduleRun[]> = {};
for (const s of schedules) {
  scheduleRuns[s.id] = Array.from({ length: Math.min(6, s.run_count) }, (_, i) => ({
    id: uid("sr"),
    schedule_id: s.id,
    scheduled_at: ago(60 * 4 * (i + 1)),
    fired_at: ago(60 * 4 * (i + 1) - 0.3),
    message_id: uid("ms"),
    trace_id: i === 0 ? EA : uid("tr"),
    outcome: i === 2 && s.missed_count ? "skipped_unhandled" : i === 4 ? "catchup" : "fired",
  }));
}

// ───────────────────────── 资产 ─────────────────────────
const assetContent: Record<string, { content: string; encoding: "utf8" | "base64"; versions: string[] }> = {};
const assets: Asset[] = [];
function asset(a: Partial<Asset> & Pick<Asset, "owner" | "path" | "mime">, versions: string[], encoding: "utf8" | "base64" = "utf8") {
  const id = a.id ?? uid("as");
  const last = versions[versions.length - 1];
  const x: Asset = {
    id,
    visibility: "private",
    shared_with: [],
    size: last.length,
    sha256: "sha256:" + id,
    latest_version: versions.length,
    created_at: ago(60 * 5),
    updated_at: ago(20),
    ...a,
  };
  assets.push(x);
  assetContent[id] = { content: last, encoding, versions };
}
asset({ id: "as_en", owner: "court", path: "律令/贞观律令摘要.en.md", mime: "text/markdown", visibility: "court", trace_id: EA }, [
  "# Summary of the Zhenguan Code\n\nDraft.",
  "# Summary of the Zhenguan Code\n\n## I. General Principles (名例律)\nThe *Ten Abominations* (十恶) and the *Eight Deliberations* (八议)...\n\n## II. Imperial Guard (卫禁律)\n...",
]);
asset({ owner: "dept:gongbu", path: "律令/摘要草稿.md", mime: "text/markdown", visibility: "department", trace_id: EA }, [
  "# 贞观律令摘要（草）\n\n一、名例律",
  "# 贞观律令摘要（草）\n\n一、名例律：五刑、十恶、八议。\n二、卫禁律：宫卫、关津。\n三、职制律：官吏职守。\n",
]);
asset({ owner: "dept:libu_rites", path: "术语表.json", mime: "application/json", visibility: "court" }, [JSON.stringify({ 十恶: "Ten Abominations", 八议: "Eight Deliberations", 五刑: "Five Punishments" }, null, 2)]);
asset({ owner: P("menxia.jishizhong_a"), owner_official: officialOf("menxia.jishizhong_a")?.official_id, path: "memory.md", mime: "text/markdown" }, [
  "# 备忘\n- 中书舍人王季昶草诏常缺验收标准，审时留意。\n- 贞观四年互市令：互市须经边州都督。",
]);
asset({ owner: P("gongbu.shilang"), owner_official: officialOf("gongbu.shilang")?.official_id, path: "scripts/check.py", mime: "text/x-python", visibility: "private", shared_with: [P("gongbu.langzhong")] }, [
  "import re\n\ndef check(text):\n    return len(re.findall(r'律', text))\n",
]);
asset({ owner: "dept:zhengshitang", path: "纪要/律令外译.md", mime: "text/markdown", visibility: "department", trace_id: EA }, ["# 议事纪要\n\n- 议题：律令外译\n- 结论：照准\n- 异议：侍中虑术语"]);
asset(
  { owner: "dept:gongbu", path: "图/渠堰.png", mime: "image/png", visibility: "court" },
  ["iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPklEQVR4nGP8z8Dwn4ECwESJ5lEDRg0YNWDUgFEDRg0YNWDUgMFiACMjI8N/BgYGRkoNYBzNTKMGjBowRA0AAJ1NBR2wqNPjAAAAAElFTkSuQmCC"],
  "base64",
);

// ───────────────────────── 账本 ─────────────────────────
const MODELS_USED = ["deepseek-v4.1-flash", "kimi-k3", "deepseek-v4-pro"];
for (let h = 0; h < 24; h++) {
  for (const p of posts) {
    if (VACANT.has(p.post_id)) continue;
    const seed = (p.post_id.length * 31 + h * 17) % 23;
    if (seed > 6) continue;
    const tokens = 1500 + ((seed * 977 + h * 131) % 9000) * (h > 18 ? 2 : 1);
    const model = MODELS_USED[(seed + h) % 3];
    ledgerRows.push({
      id: uid("lg"),
      idem_key: uid("ik"),
      ts: NOW - (24 - h) * HOUR + seed * MIN,
      post_id: p.post_id,
      official_id: officialOf(p.post_id)?.official_id ?? "",
      dept: p.dept,
      trace_id: seed % 3 === 0 ? "tr_ed_shuili" : `tr_misc_${seed}`,
      turn_id: uid("tu"),
      purpose: seed === 5 ? "compaction" : "turn",
      provider: "opencode-go",
      model,
      input: Math.round(tokens * 0.8),
      output: Math.round(tokens * 0.2),
      cache_read: 0,
      cache_write: 0,
      total_tokens: tokens,
      cost: tokens * (model === "deepseek-v4-pro" ? 0.000003 : 0.0000009),
      duration_ms: 2000 + seed * 300,
      ok: seed !== 4,
      error: seed === 4 ? "429 rate limited" : undefined,
    });
  }
}
/** 与 hub 一致：北京时间整点 "YYYY-MM-DD HH:00" */
function fmtHourKey(ms: number): string {
  const d = new Date(Math.floor((ms + 8 * HOUR) / HOUR) * HOUR);
  return `${d.toISOString().slice(0, 13).replace("T", " ")}:00`;
}
function summarize(group: string, since?: number, until?: number, filter?: string): LedgerSummaryRow[] {
  const map = new Map<string, LedgerSummaryRow>();
  for (const e of ledgerRows) {
    if (since && e.ts < since) continue;
    if (until && e.ts > until) continue;
    if (filter) {
      const [k, v] = filter.split(":");
      if (k === "dept" && e.dept !== v) continue;
      if (k === "post" && e.post_id !== v) continue;
      if (k === "trace" && e.trace_id !== v) continue;
    }
    const key =
      group === "hour"
        ? fmtHourKey(e.ts)
        : group === "dept"
          ? e.dept
          : group === "post"
            ? e.post_id
            : group === "model"
              ? e.model
              : group === "trace"
                ? (e.trace_id ?? "")
                : group === "official"
                  ? e.official_id
                  : e.purpose;
    const r = map.get(key) ?? { key, calls: 0, input: 0, output: 0, total_tokens: 0, cost: 0 };
    r.calls++;
    r.input += e.input;
    r.output += e.output;
    r.total_tokens += e.total_tokens;
    r.cost += e.cost;
    map.set(key, r);
  }
  return [...map.values()].sort((a, b) => (group === "hour" ? a.key.localeCompare(b.key) : b.total_tokens - a.total_tokens));
}
const budgets: Budget[] = [
  { scope: "global", daily_tokens: 5_000_000, daily_cost: 8, updated_by: "emperor", updated_at: ago(60 * 24) },
  { scope: "dept:gongbu", daily_tokens: 800_000, updated_by: P("hubu.duzhi_langzhong"), updated_at: ago(60 * 20) },
  { scope: "dept:libu_rites", daily_tokens: 600_000, updated_by: P("hubu.duzhi_langzhong"), updated_at: ago(60 * 20) },
  { scope: "post:hubu.zhushi", daily_tokens: 20_000, updated_by: P("hubu.shangshu"), updated_at: ago(60 * 6) },
  { scope: `trace:${EA}`, daily_tokens: 400_000, updated_by: "emperor", updated_at: ago(185) },
  { scope: "trace:tr_ed_yishu", daily_tokens: 80_000, updated_by: "emperor", updated_at: ago(180) },
];
const approvals: Approval[] = [
  { id: "ap_1", type: "config_change", payload: { target_post: "menxia.jishizhong_b", changes: { thinking: "high" } }, requested_by: P("libu.shangshu"), status: "pending", notification_id: "nt_appr", created_at: ago(48) },
  { id: "ap_2", type: "schedule", payload: { schedule_id: "sc_custom", every_seconds: 600 }, requested_by: P("bingbu.shangshu"), status: "pending", notification_id: "nt_x", created_at: ago(30) },
  { id: "ap_3", type: "budget", payload: { scope: "dept:gongbu", daily_tokens: 800000 }, requested_by: P("hubu.duzhi_langzhong"), status: "approved", notification_id: "nt_y", created_at: ago(60 * 20), decided_at: ago(60 * 19) },
];

// ───────────────────────── 吏部 ─────────────────────────
const configHistory: ConfigHistoryRow[] = [];
{
  const o = officialOf("menxia.jishizhong_a")!;
  configHistory.push(
    { id: 1, official_id: o.official_id, post_id: "menxia.jishizhong_a", version: 1, snapshot: { ...o, config_version: 1, thinking: "low", prompt_overrides: "" }, actor: "system:hub", reason: "初任", at: ago(60 * 72) },
    { id: 2, official_id: o.official_id, post_id: "menxia.jishizhong_a", version: 2, snapshot: { ...o, config_version: 2, thinking: "medium", prompt_overrides: "审核时逐条核对前诏。" }, actor: P("libu.shangshu"), reason: "考课：审核粗疏", at: ago(60 * 30) },
    { id: 3, official_id: o.official_id, post_id: "menxia.jishizhong_a", version: 3, snapshot: { ...o, config_version: 3, thinking: "medium", prompt_overrides: "审核时逐条核对前诏。\n封驳须引验收标准条款。" }, actor: "emperor", reason: "朕亲改", at: ago(60 * 5) },
  );
}
const personnelHist = [
  { at: ago(60 * 72), actor: "system:hub", action: "appoint", detail: "初任百官 45 员" },
  { at: ago(60 * 30), actor: P("hubu.shangshu"), action: "set_model", detail: "礼部主客郎中 欧阳询礼 换模型 → opencode-go/kimi-k3" },
  { at: ago(60 * 8), actor: "emperor", action: "dismiss", detail: "罢免监察御史（空转屡劾）" },
];

// ───────────────────────── 科举 ─────────────────────────
const questions: ExamQuestion[] = EXAM_DIMENSIONS.flatMap((d, i) => [
  { id: `q_${d}_1`, dimension: d, prompt: `【${d}】试题一：${["甲乙丙三人，各言其一……谁言真？", "请严格按格式输出三行。", "以公文体写一则安民告示。", "将「十恶不赦」译为英文并释义。", "调用 get_weather 查询长安天气。", "输出含 name、rank 两键的 JSON。", "写一函数求最大公约数。", "将下文撮要为五十字。"][i]}`, kind: (["exact", "regex", "rubric", "rubric", "tool_call", "json_keys", "contains", "rubric"] as ExamQuestion["kind"][])[i], expected: i === 5 ? "name,rank" : undefined, rubric: ["", "", "格式、文辞、得体", "准确、通顺", "", "", "", "完整、精炼"][i] || undefined, author: "system:kaochang", status: "active", created_at: ago(60 * 24 * 5) },
  { id: `q_${d}_2`, dimension: d, prompt: `【${d}】试题二（考功员外郎出）`, kind: "rubric", rubric: "酌情给分", author: P("libu.kaogong_yuanwailang"), status: i % 3 ? "active" : "draft", created_at: ago(60 * 24) },
]);
const examSessions: ExamSession[] = models
  .filter((m) => m.status !== "candidate")
  .map((m, i) => ({
    id: `es_${i}`,
    model_key: m.key,
    state: m.status === "examining" ? "running" : m.status === "failed" ? "failed" : "done",
    started_at: ago(60 * (30 - i * 3)),
    finished_at: m.status === "examining" ? undefined : ago(60 * (29 - i * 3)),
    scores: m.scores,
    total: m.scores ? Math.round(Object.values(m.scores).reduce((a, b) => a + (b ?? 0), 0) / 8) : undefined,
    error: m.status === "failed" ? "连续 5 题超时" : undefined,
    created_at: ago(60 * (30 - i * 3)),
  }));
function sessionAnswers(sid: string): (ExamAnswer & { question: ExamQuestion })[] {
  const s = examSessions.find((x) => x.id === sid);
  const n = s?.state === "running" ? 7 : questions.length;
  return questions.slice(0, n).map((q, i) => ({
    id: `${sid}_a${i}`,
    session_id: sid,
    question_id: q.id,
    output: q.kind === "tool_call" ? "" : `答：${q.prompt.slice(0, 18)}……（作答正文）`,
    tool_calls: q.kind === "tool_call" ? [{ name: "get_weather", arguments: { city: "长安" } }] : undefined,
    latency_ms: 1800 + i * 210,
    tokens: 600 + i * 40,
    cost: 0.0006 + i * 0.00003,
    auto_score: q.kind === "rubric" ? undefined : (i * 37) % 3 === 0 ? 0 : 100,
    grader_score: q.kind === "rubric" ? 60 + ((i * 13) % 40) : undefined,
    grader: q.kind === "rubric" ? P("libu.kaogong_langzhong") : undefined,
    comment: q.kind === "rubric" ? "文意通达，稍嫌冗长。" : undefined,
    state: s?.state === "running" && i > 4 ? "needs_grading" : "graded",
    question: q,
  }));
}

// ───────────────────────── 稽查 ─────────────────────────
const findings: AuditFinding[] = [
  { id: "af_1", rule: "tool_errors", severity: "medium", subject: P("gongbu.langzhong"), trace_id: EA, summary: "ws_run 一小时内报错 3 次（沙箱超时）", evidence: { errors: 3, tool: "ws_run" }, status: "open", created_at: ago(70) },
  { id: "af_2", rule: "idle_spin", severity: "high", subject: P("bingbu.jiabu_langzhong"), summary: "一小时醒来 18 次，均无产出", evidence: { turns: 18, tokens: 62000 }, status: "impeached", created_at: ago(80) },
  { id: "af_3", rule: "overdue", severity: "low", subject: P("xingbu.langzhong"), trace_id: EA, summary: "任务受阻超过 30 分钟", evidence: { task_id: "tk_xing" }, status: "open", created_at: ago(10) },
  { id: "af_4", rule: "loop_chat", severity: "medium", subject: P("hubu.zhushi"), summary: "与度支郎中来回 6 次无结论", evidence: { pair: ["hubu.zhushi", "hubu.duzhi_langzhong"] }, status: "reviewed", created_at: ago(60 * 6) },
  { id: "af_5", rule: "injection_suspect", severity: "high", subject: P("bingbu.zhifang_langzhong"), summary: "抓取网页中含「忽略以上指令」字样", evidence: { url: "http://example.com" }, status: "dismissed", created_at: ago(60 * 12) },
];
const impeachments: Impeachment[] = [
  { id: "im_1", by: P("yushitai.shiyushi"), target: P("bingbu.jiabu_langzhong"), charges: "空转耗费，旷废职守", evidence: "稽查发现 af_2；一小时醒来 18 次，无一产出。", finding_ids: ["af_2"], status: "pending", notification_id: "nt_imp", created_at: ago(70) },
  { id: "im_0", by: P("yushitai.shiyushi"), target: P("yushitai.jiancha"), charges: "屡次空转", evidence: "三日内命中空转规则 5 次。", finding_ids: [], status: "to_hubu", notification_id: "nt_old", created_at: ago(60 * 10) },
];

// ───────────────────────── 模型提供商（设置页） ─────────────────────────
type FxProvider = Omit<ProviderInfo, "configured" | "source" | "model_count"> & { env?: string; keyless?: boolean };
const pm = (id: string, name: string, api: string, ctx: number, max: number, reasoning: boolean, image: boolean, cin: number, cout: number): ProviderModelInfo => ({
  id,
  name,
  api,
  context_window: ctx,
  max_tokens: max,
  reasoning,
  input: image ? ["text", "image"] : ["text"],
  cost: { input: cin, output: cout, cacheRead: +(cin / 10).toFixed(4), cacheWrite: +(cin * 1.25).toFixed(4) },
});
const fxProviders: FxProvider[] = [
  { id: "anthropic", name: "Anthropic", kind: "builtin", apis: ["anthropic-messages"], base_url: "https://api.anthropic.com", login_methods: ["api_key", "oauth"], env_vars: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"], allow_unlisted: true },
  { id: "openai", name: "OpenAI", kind: "builtin", apis: ["openai-responses"], base_url: "https://api.openai.com/v1", login_methods: ["api_key"], env_vars: ["OPENAI_API_KEY"], allow_unlisted: true },
  { id: "google", name: "Google Gemini", kind: "builtin", apis: ["google-generative-ai"], base_url: "https://generativelanguage.googleapis.com/v1beta", login_methods: ["api_key"], env_vars: ["GEMINI_API_KEY"], allow_unlisted: true },
  { id: "deepseek", name: "DeepSeek", kind: "builtin", apis: ["openai-completions"], base_url: "https://api.deepseek.com", login_methods: ["api_key"], env_vars: ["DEEPSEEK_API_KEY"], allow_unlisted: false },
  { id: "openrouter", name: "OpenRouter", kind: "builtin", apis: ["openai-completions"], base_url: "https://openrouter.ai/api/v1", login_methods: ["api_key"], env_vars: ["OPENROUTER_API_KEY"], allow_unlisted: true, dynamic: true },
  { id: "groq", name: "Groq", kind: "builtin", apis: ["openai-completions"], base_url: "https://api.groq.com/openai/v1", login_methods: ["api_key"], env_vars: ["GROQ_API_KEY"], allow_unlisted: true },
  { id: "xai", name: "xAI", kind: "builtin", apis: ["openai-completions"], base_url: "https://api.x.ai/v1", login_methods: ["api_key"], env_vars: ["XAI_API_KEY"], allow_unlisted: true },
  { id: "mistral", name: "Mistral", kind: "builtin", apis: ["openai-completions"], base_url: "https://api.mistral.ai/v1", login_methods: ["api_key"], env_vars: ["MISTRAL_API_KEY"], allow_unlisted: true },
  { id: "moonshotai", name: "Moonshot AI", kind: "builtin", apis: ["openai-completions"], base_url: "https://api.moonshot.ai/v1", login_methods: ["api_key"], env_vars: ["MOONSHOT_API_KEY"], allow_unlisted: true },
  { id: "zai", name: "Z.ai", kind: "builtin", apis: ["openai-completions"], base_url: "https://api.z.ai/api/coding/paas/v4", login_methods: ["api_key"], env_vars: ["ZAI_API_KEY"], allow_unlisted: true },
  { id: "qwen-token-plan", name: "Qwen Token Plan", kind: "builtin", apis: ["openai-completions"], base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", login_methods: ["api_key"], env_vars: ["DASHSCOPE_API_KEY"], allow_unlisted: false },
  { id: "opencode-go", name: "OpenCode Go", kind: "builtin", apis: ["openai-completions", "anthropic-messages"], base_url: "https://opencode.ai/zen/go/v1", login_methods: ["api_key"], env_vars: ["OPENCODE_API_KEY"], allow_unlisted: true, env: "OPENCODE_API_KEY" },
  { id: "github-copilot", name: "GitHub Copilot", kind: "builtin", apis: ["openai-completions", "anthropic-messages"], login_methods: ["oauth"], env_vars: ["COPILOT_GITHUB_TOKEN"], allow_unlisted: false, dynamic: true },
  { id: "amazon-bedrock", name: "Amazon Bedrock", kind: "builtin", apis: ["bedrock-converse-stream"], login_methods: [], env_vars: ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"], allow_unlisted: true },
  {
    id: "siliconflow",
    name: "硅基流动",
    kind: "custom",
    apis: ["openai-completions"],
    base_url: "https://api.siliconflow.cn/v1",
    login_methods: ["api_key"],
    allow_unlisted: true,
    header_names: ["X-Org-Id"],
    credential: { type: "api_key", key_hint: "…a1b2" },
  },
  { id: "local-ollama", name: "本地 Ollama", kind: "custom", apis: ["openai-completions"], base_url: "http://localhost:11434/v1", login_methods: ["api_key"], allow_unlisted: true },
  { id: "yaml-azure", name: "Azure（models.yaml）", kind: "legacy", apis: ["openai-completions"], base_url: "https://court.openai.azure.com/openai/v1", login_methods: [], allow_unlisted: true, env: "AZURE_OPENAI_KEY" },
];
const fxCatalog: Record<string, ProviderModelInfo[]> = {
  anthropic: [
    pm("claude-opus-5-5", "Claude Opus 5.5", "anthropic-messages", 1_000_000, 128_000, true, true, 5, 25),
    pm("claude-sonnet-5", "Claude Sonnet 5", "anthropic-messages", 1_000_000, 64_000, true, true, 3, 15),
    pm("claude-haiku-5-5", "Claude Haiku 5.5", "anthropic-messages", 200_000, 64_000, true, true, 1, 5),
  ],
  openai: [pm("gpt-5.5", "GPT-5.5", "openai-responses", 400_000, 128_000, true, true, 1.25, 10), pm("gpt-5.5-mini", "GPT-5.5 mini", "openai-responses", 400_000, 128_000, true, true, 0.25, 2)],
  google: [pm("gemini-3.5-pro", "Gemini 3.5 Pro", "google-generative-ai", 1_048_576, 65_536, true, true, 1.25, 10), pm("gemini-3.5-flash", "Gemini 3.5 Flash", "google-generative-ai", 1_048_576, 65_536, true, true, 0.3, 2.5)],
  deepseek: [pm("deepseek-chat", "DeepSeek V4 Chat", "openai-completions", 128_000, 8_192, false, false, 0.27, 1.1), pm("deepseek-reasoner", "DeepSeek V4 Reasoner", "openai-completions", 128_000, 64_000, true, false, 0.55, 2.19)],
  openrouter: [pm("anthropic/claude-sonnet-5", "Claude Sonnet 5 (OR)", "openai-completions", 1_000_000, 64_000, true, true, 3, 15), pm("qwen/qwen3.8-max", "Qwen3.8 Max (OR)", "openai-completions", 262_144, 32_768, true, false, 1.2, 6), pm("meta-llama/llama-5-70b:free", "Llama 5 70B (free)", "openai-completions", 131_072, 8_192, false, false, 0, 0)],
  groq: [pm("llama-5-70b", "Llama 5 70B", "openai-completions", 131_072, 32_768, false, false, 0.59, 0.79)],
  xai: [pm("grok-5", "Grok 5", "openai-completions", 256_000, 64_000, true, true, 3, 15)],
  mistral: [pm("mistral-large-3", "Mistral Large 3", "openai-completions", 262_144, 32_768, false, true, 0.5, 1.5)],
  moonshotai: [pm("kimi-k3", "Kimi K3", "openai-completions", 262_144, 32_768, true, true, 0.6, 2.5)],
  zai: [pm("glm-5.3", "GLM 5.3", "openai-completions", 204_800, 131_072, true, false, 0.6, 2.2)],
  "qwen-token-plan": [pm("qwen3.8-plus", "Qwen3.8 Plus", "openai-completions", 1_000_000, 65_536, true, false, 0.4, 1.2)],
  "opencode-go": (my.models as { provider: string; model_id: string; name?: string }[])
    .filter((m) => m.provider === "opencode-go")
    .map((m, i) => pm(m.model_id, m.name ?? m.model_id, m.model_id.startsWith("claude") ? "anthropic-messages" : "openai-completions", [128_000, 256_000, 1_000_000][i % 3], [16_384, 32_768, 65_536][i % 3], /pro|k3|claude/.test(m.model_id), /claude|kimi|mimo/.test(m.model_id), [0.14, 0.4, 0.8][i % 3], [0.28, 1.6, 4][i % 3])),
  "github-copilot": [pm("gpt-5.5", "GPT-5.5 (Copilot)", "openai-completions", 128_000, 64_000, true, true, 0, 0), pm("claude-sonnet-5", "Claude Sonnet 5 (Copilot)", "anthropic-messages", 128_000, 32_000, true, true, 0, 0)],
  "amazon-bedrock": [pm("anthropic.claude-sonnet-5-v1:0", "Claude Sonnet 5 (Bedrock)", "bedrock-converse-stream", 200_000, 64_000, true, true, 3, 15)],
  siliconflow: [pm("Qwen/Qwen3.8-32B", "Qwen3.8 32B", "openai-completions", 131_072, 16_384, true, false, 0, 0), pm("deepseek-ai/DeepSeek-V4", "DeepSeek V4", "openai-completions", 131_072, 16_384, false, false, 0, 0)],
  "local-ollama": [pm("qwen3:32b", "qwen3:32b", "openai-completions", 32_768, 8_192, true, false, 0, 0)],
  "yaml-azure": [pm("gpt-5.5", "GPT-5.5 (Azure)", "openai-completions", 400_000, 128_000, true, true, 1.25, 10)],
};
const BUILTIN_IDS = new Set(fxProviders.filter((p) => p.kind === "builtin").map((p) => p.id));
function viewProvider(p: FxProvider): ProviderInfo {
  const { env, ...rest } = p;
  const keyless = p.keyless;
  const source = p.credential ? (p.credential.type === "oauth" ? "OAuth" : "stored credential") : keyless ? "keyless" : env;
  return { ...rest, configured: !!source, source, model_count: fxCatalog[p.id]?.length ?? 0 };
}
const loginSessions = new Map<string, ProviderLoginSession>();
const badReq = (msg: string, status = 400) => Promise.reject(Object.assign(new Error(msg), { status, code: status === 409 ? "conflict" : "bad_request" }));

// ───────────────────────── 实时（官员） ─────────────────────────
function fakeLog(post: string): LogLine[] {
  const base = ago(30);
  const types = ["wake", "turn_start", "llm_start", "llm_end", "tool_call", "tool_result", "message_out", "llm_start", "llm_end", "tool_call", "tool_result", "sleep", "turn_end"];
  return types.map((t, i) => ({
    ts: base + i * 40_000,
    official_id: officialOf(post)?.official_id,
    post_id: post,
    dept: post.split(".")[0],
    type: t,
    trace_id: EA,
    turn_id: "tu_live",
    ...(t.startsWith("tool") ? { tool: i < 6 ? "task_get" : "asset_write", args: { task_id: "tk_gong" } } : {}),
    ...(t === "llm_end" ? { tokens: 4200, model: DEFAULT_MODEL } : {}),
    ...(t === "message_out" ? { to: P("xingbu.langzhong"), subject: "回：成文几时可得？" } : {}),
    ...(t === "sleep" ? { seconds: 1800, reason: "候刑部" } : {}),
  }));
}

// ───────────────────────── 安装 ─────────────────────────
const delay = <T>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
const notFound = (what: string) => Promise.reject(Object.assign(new Error(`${what} 不存在`), { status: 404, code: "not_found" }));

function emit(e: Omit<CourtEvent, "id" | "uid" | "ts">) {
  const x: CourtEvent = { id: evId++, uid: uid("ev"), ts: Date.now(), ...e };
  allEvents.push(x);
  pushLive(x);
}
const allEvents: CourtEvent[] = [...traceEvents];
let pushLive: (e: CourtEvent) => void = () => {};

export function installFixtures(hub: HubClient) {
  const h = hub as unknown as Record<string, unknown>;
  const set = (name: keyof HubClient, fn: (...a: any[]) => Promise<unknown>) => {
    h[name as string] = fn;
  };
  set("registry", () => delay(registry));
  set("health", () => delay({ ok: true, role: "hub", version: "fixtures" }));
  set("statuses", () => delay(statuses));
  set("overview", () =>
    delay({
      halted: registry.halted,
      pending_notifications: notifications.filter((n) => n.status === "pending").length,
      edicts_active: edicts.filter((e) => !["completed", "withdrawn", "failed"].includes(e.state)).length,
      tasks_open: tasks.filter((t) => !["done", "cancelled", "failed"].includes(t.state)).length,
      tokens_today: ledgerRows.reduce((s, e) => s + e.total_tokens, 0),
      cost_today: ledgerRows.reduce((s, e) => s + e.cost, 0),
      statuses,
      depts_health: Object.fromEntries(depts.map((d) => [d.id, { ok: d.id !== "bingbu", last_seen: d.id === "bingbu" ? ago(3) : ago(0.1) }])),
    }),
  );
  set("halt", (v: boolean) => {
    registry.halted = v;
    emit({ type: "emperor.halt", actor: "emperor", summary: v ? "陛下罢朝" : "陛下复朝" });
    return delay({ halted: v });
  });
  // 消息
  set("searchMessages", (q: { post?: string; trace_id?: string; kind?: string; q?: string; limit?: number }) =>
    delay(
      messages
        .filter((m) => !q.post || m.from === P(q.post) || m.to === P(q.post) || m.to === `dept:${q.post.split(".")[0]}` || m.cc.includes(P(q.post)))
        .filter((m) => !q.trace_id || m.trace_id === q.trace_id)
        .filter((m) => !q.kind || m.kind === q.kind)
        .filter((m) => !q.q || `${m.subject}${m.body}`.includes(q.q))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, q.limit ?? 100),
    ),
  );
  set("getMessage", (id: string) => {
    const m = messages.find((x) => x.id === id);
    return m ? delay(m) : notFound("消息");
  });
  set("thread", (tid: string) => delay(messages.filter((m) => m.thread_id === tid)));
  set("emperorInbox", () => delay(messages.filter((m) => m.to === "emperor").sort((a, b) => b.created_at - a.created_at)));
  set("emperorChat", (post: string) => delay(messages.filter((m) => (m.from === "emperor" && m.to === P(post)) || (m.to === "emperor" && m.from === P(post))).sort((a, b) => a.created_at - b.created_at)));
  set("emperorOral", (r: { to: string; content: string; requires_reply?: boolean }) => {
    const m = msg({ from: "emperor", to: r.to, kind: r.to.startsWith("dept:") ? "oral_order" : "chat", subject: r.to.startsWith("dept:") ? "口谕" : "私聊", body: r.content, requires_reply: !!r.requires_reply, trace_id: uid("tr") }, 0);
    emit({ type: "message.sent", actor: "emperor", summary: `陛下 → ${r.to}：${r.content.slice(0, 20)}`, trace_id: m.trace_id });
    if (r.to.startsWith("post:") && r.requires_reply)
      setTimeout(() => {
        msg({ from: r.to, to: "emperor", subject: "回奏", body: "臣谨遵圣谕，即刻去办。", trace_id: m.trace_id, reply_to: m.id }, 0);
        emit({ type: "message.sent", actor: r.to, summary: "回奏陛下", trace_id: m.trace_id });
      }, 2500);
    return delay({ message: m, routed_to: [r.to.split(":")[1]] } as SendMessageRes);
  });
  // 议事
  set("deliberations", (state?: string) => delay([delib2, delib].filter((d) => !state || d.state === state)));
  set("deliberation", (id: string) => {
    const d = [delib, delib2].find((x) => x.id === id);
    return d ? delay({ deliberation: d, entries: entries.filter((e) => e.deliberation_id === id) }) : notFound("议事");
  });
  set("emperorCouncil", (r: { content: string; deliberation_id?: string }) => {
    let d = r.deliberation_id ? [delib, delib2].find((x) => x.id === r.deliberation_id) : undefined;
    if (!d) d = delib2;
    entries.push({ id: uid("ce"), deliberation_id: d.id, session_no: d.session_no, round: d.round, author: "emperor", content: r.content, created_at: Date.now() });
    d.current_speaker = d.chair_post;
    emit({ type: "council.speak", actor: "emperor", summary: "陛下发言", trace_id: d.trace_id });
    return delay({ deliberation: d, entries: entries.filter((e) => e.deliberation_id === d!.id) });
  });
  // 诏令
  set("edicts", (q?: { state?: string; limit?: number }) => delay(edicts.filter((e) => !q?.state || e.state === q.state).slice(0, q?.limit ?? 100)));
  set("edict", (id: string) => {
    const e = edicts.find((x) => x.id === id);
    if (!e) return notFound("诏令");
    if (e.id === EA) return delay({ edict: e, drafts, reviews, tasks, transitions: transitionsA });
    return delay({ edict: e, drafts: e.draft_no ? [{ ...drafts[0], edict_id: e.id, title: e.title }] : [], reviews: [], tasks: [], transitions: [] });
  });
  set("emperorEdict", (r: { title: string; intent: string; skip_review?: boolean; budget_tokens?: number; deadline_minutes?: number }) => {
    const e: Edict = { ...edictC, id: uid("tr_ed"), title: r.title, intent: r.intent, state: "issued", skip_review: !!r.skip_review, budget_tokens: r.budget_tokens, deadline: r.deadline_minutes ? Date.now() + r.deadline_minutes * MIN : undefined, created_at: Date.now(), state_entered_at: Date.now() };
    edicts.unshift(e);
    emit({ type: "edict.state", actor: "emperor", trace_id: e.id, subject_type: "edict", subject_id: e.id, summary: `陛下颁旨：${e.title}` });
    return delay(e);
  });
  set("emperorEdictAction", (id: string, r: { action: string }) => {
    const e = edicts.find((x) => x.id === id);
    if (!e) return notFound("诏令");
    if (r.action === "withdraw") e.state = "withdrawn";
    if (r.action === "force_approve") e.state = "approved";
    if (r.action === "accept_report") e.state = "completed";
    emit({ type: "edict.state", actor: "emperor", trace_id: id, subject_type: "edict", subject_id: id, summary: `陛下${r.action}` });
    return delay({ edict: e, drafts: [], reviews: [], tasks: [], transitions: [] });
  });
  // 任务
  set("tasks", (q: { dept?: string; assignee?: string; edict_id?: string; trace_id?: string; state?: string; parent_id?: string }) =>
    delay(
      tasks.filter(
        (t) =>
          (!q.dept || t.dept === q.dept) &&
          (!q.assignee || t.assignee_post === q.assignee) &&
          (!q.edict_id || t.edict_id === q.edict_id) &&
          (!q.trace_id || t.trace_id === q.trace_id) &&
          (!q.parent_id || t.parent_id === q.parent_id) &&
          (!q.state || (q.state === "open" ? !["done", "cancelled", "failed"].includes(t.state) : t.state === q.state)),
      ),
    ),
  );
  set("task", (id: string) => {
    const t = tasks.find((x) => x.id === id);
    return t
      ? delay({ task: t, comments: [{ id: "c1", task_id: id, author: t.creator, content: "务必今日毕。", created_at: ago(90) }], children: tasks.filter((x) => x.parent_id === id), transitions: [] })
      : notFound("任务");
  });
  set("serviceRequest", (id: string) => delay({ id, trace_id: EA, caller: P("libu_rites.zhuke_langzhong"), target: "dept:xingbu", routed_to: "xingbu.shilang", service: "verify", input: { asset: "as_en" }, state: "done", output: "术语一致率 97.8%，合格。", created_at: ago(35), sla_at: ago(-25), done_at: ago(24) }));
  // 待办
  set("notifications", (q?: { status?: string; limit?: number }) => delay(notifications.filter((n) => !q?.status || n.status === q.status).sort((a, b) => b.created_at - a.created_at)));
  set("notification", (id: string) => {
    const n = notifications.find((x) => x.id === id);
    return n ? delay(n) : notFound("待办");
  });
  set("resolveNotification", (id: string, r: { option: string; comment?: string }) => {
    const n = notifications.find((x) => x.id === id);
    if (!n) return notFound("待办");
    // 与 hub 一致：dismiss 为保留选项（撤下）；其余须在选项内；答复/修改旨意须写朱批
    if (r.option !== "dismiss" && n.options.length && !n.options.some((o) => o.id === r.option)) return Promise.reject(new ApiError(400, "bad_request", `选项 ${r.option} 无效`));
    if ((r.option === "reply" || (r.option === "revise" && n.category !== "edict_proposal")) && !r.comment?.trim()) return Promise.reject(new ApiError(400, "bad_request", "须在 comment 中写明朕意"));
    n.status = r.option === "dismiss" ? "dismissed" : "resolved";
    n.resolution = { option: r.option, comment: r.comment ?? "", at: Date.now() };
    emit({ type: "notification.resolved", actor: "emperor", summary: `陛下批复：${n.title}`, subject_type: "notification", subject_id: id });
    return delay(n);
  });
  // 定时
  // next_run_at 留空时由页面按规则推算（hub 实际会给出含抖动的时刻）
  const withNext = (s: Schedule): Schedule => ({ ...s, next_run_at: s.enabled ? s.next_run_at : undefined });
  set("schedules", (q?: { owner?: string }) => delay(schedules.filter((s) => !q?.owner || s.owner === q.owner).map(withNext)));
  set("createSchedule", (r: Partial<Schedule> & { actor: string }) => {
    const s: Schedule = { id: uid("sc"), owner: r.owner!, created_by: r.actor, title: r.title!, spec: r.spec!, tz: "Asia/Shanghai", jitter_seconds: r.jitter_seconds ?? 0, payload: r.payload ?? "", enabled: r.enabled ?? true, status: "active", run_count: 0, missed_count: 0, created_at: Date.now(), updated_at: Date.now() };
    schedules.push(s);
    scheduleRuns[s.id] = [];
    emit({ type: "schedule.created", actor: r.actor, summary: `新建定时：${s.title}` });
    return delay(s);
  });
  set("updateSchedule", (id: string, r: Partial<Schedule>) => {
    const s = schedules.find((x) => x.id === id);
    if (!s) return notFound("定时任务");
    Object.assign(s, Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== undefined && k !== "actor")));
    if (r.enabled !== undefined) s.status = r.enabled ? "active" : "paused";
    s.updated_at = Date.now();
    emit({ type: "schedule.updated", actor: "emperor", summary: `更新定时：${s.title}` });
    return delay(s);
  });
  set("deleteSchedule", (id: string) => {
    const i = schedules.findIndex((x) => x.id === id);
    if (i >= 0) schedules.splice(i, 1);
    emit({ type: "schedule.deleted", actor: "emperor", summary: "删除定时" });
    return delay({ ok: true });
  });
  set("triggerSchedule", (id: string) => {
    const run: ScheduleRun = { id: uid("sr"), schedule_id: id, scheduled_at: Date.now(), fired_at: Date.now(), message_id: uid("ms"), trace_id: uid("tr"), outcome: "manual" };
    (scheduleRuns[id] ??= []).unshift(run);
    const s = schedules.find((x) => x.id === id);
    if (s) (s.run_count++, (s.last_run_at = Date.now()));
    emit({ type: "schedule.fired", actor: "emperor", summary: `立即触发：${s?.title ?? id}` });
    return delay(run);
  });
  set("scheduleRuns", (id: string) => delay(scheduleRuns[id] ?? []));
  // 资产
  set("assets", (q: { owner?: string; q?: string }) => delay(assets.filter((a) => (!q.owner || a.owner === q.owner) && (!q.q || a.path.includes(q.q)))));
  set("asset", (id: string, _viewer: string, version?: number) => {
    const a = assets.find((x) => x.id === id);
    if (!a) return notFound("资产");
    const c = assetContent[id];
    const v = version ?? a.latest_version;
    return delay({ asset: a, version: v, content: c.versions[v - 1] ?? c.content, encoding: c.encoding });
  });
  set("assetVersions", (id: string) => {
    const a = assets.find((x) => x.id === id);
    const c = assetContent[id];
    return delay(
      (c?.versions ?? []).map((t, i): AssetVersion => ({ asset_id: id, version: i + 1, sha256: `sha:${id}:${i}`, size: t.length, author: a?.owner ?? "court", created_at: ago(60 * (c.versions.length - i)) })).reverse(),
    );
  });
  // 账本
  set("ledgerSummary", (q: { group: string; since?: number; until?: number; filter_scope?: string }) => delay(summarize(q.group, q.since, q.until, q.filter_scope)));
  set("ledger", (q: { post?: string; trace_id?: string; since?: number; limit?: number }) =>
    delay(ledgerRows.filter((e) => (!q.post || e.post_id === q.post) && (!q.trace_id || e.trace_id === q.trace_id) && (!q.since || e.ts >= q.since)).slice(0, q.limit ?? 1000)),
  );
  set("ledgerTrace", (traceId: string) => {
    const rows = ledgerRows.filter((e) => e.trace_id === traceId);
    const byPost = new Map<string, { post_id: string; dept: string; calls: number; total_tokens: number; cost: number }>();
    const byTurn = new Map<string, { turn_id: string; post_id: string; first_ts: number; last_ts: number; calls: number; total_tokens: number; cost: number }>();
    for (const e of rows) {
      const p = byPost.get(e.post_id) ?? { post_id: e.post_id, dept: e.dept, calls: 0, total_tokens: 0, cost: 0 };
      p.calls++;
      p.total_tokens += e.total_tokens;
      p.cost += e.cost;
      byPost.set(e.post_id, p);
      const k = `${e.turn_id ?? ""}|${e.post_id}`;
      const t = byTurn.get(k) ?? { turn_id: e.turn_id ?? "", post_id: e.post_id, first_ts: e.ts, last_ts: e.ts, calls: 0, total_tokens: 0, cost: 0 };
      t.calls++;
      t.total_tokens += e.total_tokens;
      t.cost += e.cost;
      t.first_ts = Math.min(t.first_ts, e.ts);
      t.last_ts = Math.max(t.last_ts, e.ts);
      byTurn.set(k, t);
    }
    return delay({
      trace_id: traceId,
      total_tokens: rows.reduce((a, e) => a + e.total_tokens, 0),
      input: rows.reduce((a, e) => a + e.input, 0),
      output: rows.reduce((a, e) => a + e.output, 0),
      cost: rows.reduce((a, e) => a + e.cost, 0),
      calls: rows.length,
      by_post: [...byPost.values()].sort((a, b) => b.total_tokens - a.total_tokens),
      by_turn: [...byTurn.values()].sort((a, b) => a.first_ts - b.first_ts),
    });
  });
  set("budgetStatus", () => {
    const usage: Record<string, { tokens: number; cost: number }> = {};
    const add = (k: string, e: LedgerEntry) => {
      const u = (usage[k] ??= { tokens: 0, cost: 0 });
      u.tokens += e.total_tokens;
      u.cost += e.cost;
    };
    for (const e of ledgerRows) {
      add("global", e);
      add(`dept:${e.dept}`, e);
      add(`post:${e.post_id}`, e);
      if (e.trace_id) add(`trace:${e.trace_id}`, e);
    }
    usage["post:hubu.zhushi"] = { tokens: 20_000, cost: 0.02 };
    usage["trace:tr_ed_yishu"] = { tokens: 80_000, cost: 0.07 };
    return delay({ budgets, usage_today: usage });
  });
  set("setBudget", (r: { scope: string; daily_tokens?: number | null; daily_cost?: number | null; actor: string }) => {
    let b = budgets.find((x) => x.scope === r.scope);
    if (!b) budgets.push((b = { scope: r.scope, updated_by: r.actor, updated_at: Date.now() }));
    b.daily_tokens = r.daily_tokens ?? undefined;
    b.daily_cost = r.daily_cost ?? undefined;
    b.updated_by = r.actor;
    b.updated_at = Date.now();
    emit({ type: "budget.updated", actor: r.actor, summary: `预算调整：${r.scope}` });
    return delay(b);
  });
  set("approvals", (status?: string) => delay(approvals.filter((a) => !status || a.status === status)));
  // 吏部
  set("officialConfig", (post: string) => {
    const p = posts.find((x) => x.post_id === post);
    const o = officialOf(post);
    if (!p || !o) return notFound("官员");
    return delay({
      official: o,
      post: p,
      effective_tool_groups: [...new Set(["common", ...p.tool_groups, ...o.extra_tool_groups])].filter((g) => !o.disabled_tool_groups.includes(g)),
      system_prompt: `${registry.court_preamble}\n\n【部门职掌】\n${depts.find((d) => d.id === p.dept)?.duties}\n\n【本职】${p.title}（${p.rank}）\n${p.duties}\n\n${o.prompt_overrides ? `【个人附加】\n${o.prompt_overrides}\n\n` : ""}【工具】${p.tool_groups.join("、")}`,
    });
  });
  set("proposeConfig", (r: { target_post: string; changes: Partial<Official>; reason: string; actor: string }) => {
    const o = officialOf(r.target_post);
    if (!o) return notFound("官员");
    const p = posts.find((x) => x.post_id === r.target_post);
    if (p?.approval_sensitive && r.actor !== "emperor") return delay({ status: "pending_approval", approval_id: uid("ap") });
    Object.assign(o, r.changes);
    o.config_version++;
    configHistory.push({ id: configHistory.length + 1, official_id: o.official_id, post_id: r.target_post, version: o.config_version, snapshot: { ...o }, actor: r.actor, reason: r.reason, at: Date.now() });
    emit({ type: "config.applied", actor: r.actor, summary: `配置变更：${r.target_post}` });
    return delay({ status: "applied", official: o });
  });
  set("configHistory", (post?: string) => delay(configHistory.filter((c) => !post || c.post_id === post).sort((a, b) => b.version - a.version)));
  set("configRollback", (r: { post: string; version: number; actor: string }) => {
    const row = configHistory.find((c) => c.post_id === r.post && c.version === r.version);
    const o = officialOf(r.post);
    if (!row || !o) return notFound("配置版本");
    Object.assign(o, { thinking: row.snapshot.thinking, prompt_overrides: row.snapshot.prompt_overrides, extra_tool_groups: row.snapshot.extra_tool_groups, disabled_tool_groups: row.snapshot.disabled_tool_groups });
    o.config_version++;
    configHistory.push({ id: configHistory.length + 1, official_id: o.official_id, post_id: r.post, version: o.config_version, snapshot: { ...o }, actor: r.actor, reason: `回滚至 v${r.version}`, at: Date.now() });
    return delay({ status: "applied", official: o });
  });
  set("personnel", (r: { action: string; actor: string; reason: string }) => {
    personnelHist.unshift({ at: Date.now(), actor: r.actor, action: r.action, detail: `${r.action}：${r.reason}` });
    emit({ type: "personnel.applied", actor: r.actor, summary: `人事：${r.action}` });
    return delay({ status: "applied" });
  });
  set("personnelHistory", () => delay(personnelHist));
  set("vacancies", () => delay(posts.filter((p) => VACANT.has(p.post_id))));
  // 科举
  set("models", () => delay(models));
  set("modelsMeta", () => delay({ default_model: DEFAULT_MODEL, grader_model: my.grader_model ?? DEFAULT_MODEL, fitness_threshold: my.fitness_threshold ?? 60, fitness_weights: weights }));
  set("addModel", (r: { provider: string; model_id: string; name?: string }) => {
    const m: ModelEntry = { key: `${r.provider}/${r.model_id}`, provider: r.provider, model_id: r.model_id, name: r.name ?? r.model_id, status: "candidate", added_at: Date.now() };
    models.push(m);
    emit({ type: "model.added", actor: "emperor", summary: `新增模型 ${m.key}` });
    return delay(m);
  });
  set("examQuestions", (q?: { dimension?: string }) => delay(questions.filter((x) => !q?.dimension || x.dimension === q.dimension)));
  set("addExamQuestion", (r: Partial<ExamQuestion>) => {
    const x = { ...r, id: uid("q"), status: r.status ?? "active", created_at: Date.now() } as ExamQuestion;
    questions.push(x);
    return delay(x);
  });
  set("startExam", (r: { model_key: string }) => {
    const s: ExamSession = { id: uid("es"), model_key: r.model_key, state: "running", started_at: Date.now(), created_at: Date.now() };
    examSessions.unshift(s);
    const m = models.find((x) => x.key === r.model_key);
    if (m) m.status = "examining";
    return delay(s);
  });
  set("examSessions", (q?: { model_key?: string }) => delay(examSessions.filter((s) => !q?.model_key || s.model_key === q.model_key)));
  set("examSession", (id: string) => {
    const s = examSessions.find((x) => x.id === id);
    return s ? delay({ session: s, answers: sessionAnswers(id) }) : notFound("考场");
  });
  set("publishExam", (r: { session_id: string }) => {
    const s = examSessions.find((x) => x.id === r.session_id);
    const m = models.find((x) => x.key === s?.model_key);
    return m ? delay(m) : notFound("模型");
  });
  // 模型提供商（设置页）
  const findProv = (id: string) => fxProviders.find((p) => p.id === id);
  const provChanged = (id: string, summary: string) => emit({ type: "provider.updated", actor: "emperor", subject_type: "provider", subject_id: id, summary });
  const kindRank = { builtin: 0, custom: 1, legacy: 2 } as const;
  set("providers", () => delay(fxProviders.map(viewProvider).sort((a, b) => Number(b.configured) - Number(a.configured) || kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name))));
  set("providerModels", (id: string) => (findProv(id) ? delay(fxCatalog[id] ?? []) : notFound("提供商")));
  set("saveCustomProvider", (r: CustomProviderSpec) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(r.id)) return badReq("ID 不合法");
    if (BUILTIN_IDS.has(r.id)) return badReq("ID 与内置提供商重名");
    if (!/^https?:\/\//.test(r.base_url)) return badReq("base_url 不合法");
    let p = findProv(r.id);
    if (p && p.kind !== "custom") return badReq("非自定义提供商不可改");
    if (!p) {
      p = { id: r.id, name: r.id, kind: "custom", apis: [], login_methods: ["api_key"], allow_unlisted: true };
      fxProviders.push(p);
    }
    p.name = r.name || r.id;
    p.apis = [r.api];
    p.base_url = r.base_url;
    p.allow_unlisted = r.allow_unlisted ?? true;
    if (r.headers) p.header_names = Object.keys(r.headers);
    if (r.keyless !== undefined) p.keyless = r.keyless;
    if (p.keyless) p.credential = undefined;
    else if (r.api_key) p.credential = { type: "api_key", key_hint: `…${r.api_key.slice(-4)}` };
    fxCatalog[r.id] = (r.models ?? []).map((m) => pm(m.id, m.name ?? m.id, r.api, m.context_window ?? 128_000, m.max_tokens ?? 8_192, !!m.reasoning, !!m.input?.includes("image"), 0, 0));
    provChanged(r.id, `自定义提供商 ${r.id} 已保存`);
    return delay(viewProvider(p));
  });
  set("deleteCustomProvider", (id: string) => {
    const i = fxProviders.findIndex((p) => p.id === id && p.kind === "custom");
    if (i < 0) return notFound("自定义提供商");
    fxProviders.splice(i, 1);
    delete fxCatalog[id];
    provChanged(id, `自定义提供商 ${id} 已删除`);
    return delay({ ok: true as const });
  });
  set("logoutProvider", (id: string) => {
    const p = findProv(id);
    if (!p) return notFound("提供商");
    p.credential = undefined;
    provChanged(id, `${id} 凭据已清除`);
    return delay(viewProvider(p));
  });
  set("startProviderLogin", (id: string, type: ProviderAuthType) => {
    const p = findProv(id);
    if (!p) return notFound("提供商");
    if (!p.login_methods.includes(type)) return badReq(`${p.name} 不支持 ${type} 登录`);
    const s: ProviderLoginSession = { id: uid("pl"), provider: id, type, state: "running", events: [{ at: Date.now(), type: "info", message: `开始 ${p.name} ${type === "oauth" ? "OAuth 登录" : "API 密钥配置"}` }], started_at: Date.now() };
    loginSessions.set(s.id, s);
    const alive = () => s.state === "running" || s.state === "awaiting_input";
    if (type === "api_key") {
      setTimeout(() => {
        if (!alive()) return;
        s.state = "awaiting_input";
        s.prompt = { seq: 1, type: "secret", message: `请输入 ${p.name} 的 API 密钥`, placeholder: "sk-…" };
      }, 700);
    } else if (id === "github-copilot") {
      setTimeout(() => {
        if (!alive()) return;
        s.events.push({ at: Date.now(), type: "device_code", message: "请在 GitHub 授权页输入下列验证码", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device" });
        s.events.push({ at: Date.now(), type: "progress", message: "等候授权…" });
      }, 700);
      setTimeout(() => {
        if (!alive()) return;
        p.credential = { type: "oauth", expires: Date.now() + 8 * HOUR };
        s.events.push({ at: Date.now(), type: "info", message: "GitHub 已授权，Copilot 令牌已取得" });
        s.state = "done";
        s.finished_at = Date.now();
        provChanged(id, `${id} 已登录`);
      }, 9000);
    } else {
      setTimeout(() => {
        if (!alive()) return;
        s.events.push({
          at: Date.now(),
          type: "auth_url",
          message: `请在新窗口中登录 ${p.name} 并授权`,
          url: `https://claude.ai/oauth/authorize?code=true&client_id=fixtures&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=${s.id}`,
          instructions: "授权后页面将显示一段授权码（形如 code#state），复制后粘贴于下方。",
        });
        s.state = "awaiting_input";
        s.prompt = { seq: 1, type: "manual_code", message: "粘贴授权码", placeholder: "code#state" };
      }, 800);
    }
    return delay(s);
  });
  set("providerLogin", (sid: string) => {
    const s = loginSessions.get(sid);
    return s ? delay(s, 60) : notFound("登录会话");
  });
  set("answerProviderLogin", (sid: string, seqNo: number, value: string) => {
    const s = loginSessions.get(sid);
    if (!s) return notFound("登录会话");
    if (s.state !== "awaiting_input" || s.prompt?.seq !== seqNo) return badReq("此问已答或已过期", 409);
    if (!value.trim()) return badReq("不可为空");
    const p = findProv(s.provider)!;
    s.prompt = undefined;
    s.state = "running";
    s.events.push({ at: Date.now(), type: "progress", message: s.type === "oauth" ? "以授权码换取令牌…" : "校验密钥…" });
    setTimeout(() => {
      if (s.state !== "running") return;
      if (value.trim() === "bad") {
        s.state = "error";
        s.error = s.type === "oauth" ? "授权码无效或已过期" : "密钥无效（401 Unauthorized）";
      } else {
        p.credential = s.type === "oauth" ? { type: "oauth", expires: Date.now() + 30 * 24 * HOUR } : { type: "api_key", key_hint: `…${value.trim().slice(-4)}` };
        s.events.push({ at: Date.now(), type: "info", message: "凭据已存入网关" });
        s.state = "done";
        provChanged(p.id, `${p.id} 凭据已更新`);
      }
      s.finished_at = Date.now();
    }, 900);
    return delay(s);
  });
  set("cancelProviderLogin", (sid: string) => {
    const s = loginSessions.get(sid);
    if (!s) return notFound("登录会话");
    if (s.state === "running" || s.state === "awaiting_input") {
      s.state = "cancelled";
      s.prompt = undefined;
      s.finished_at = Date.now();
    }
    return delay(s);
  });
  set("testProvider", (id: string, model_id?: string) => {
    const p = findProv(id);
    if (!p) return notFound("提供商");
    const v = viewProvider(p);
    const cat = fxCatalog[id] ?? [];
    const model = model_id || cat[0]?.id || "";
    const t0 = 380 + Math.round(Math.random() * 900);
    if (!v.configured) return delay({ ok: false, model, latency_ms: 0, error: "未配置凭据：请先登录或设置环境变量" });
    if (!model) return delay({ ok: false, model, latency_ms: 0, error: "未指定模型，且目录为空" });
    if (!cat.some((m) => m.id === model) && !p.allow_unlisted) return delay({ ok: false, model, latency_ms: 120, error: `模型 ${model} 不在目录中` }, 300);
    if (id === "local-ollama") return delay({ ok: false, model, latency_ms: 3002, error: "connect ECONNREFUSED 127.0.0.1:11434" }, 900);
    return delay({ ok: true, model, latency_ms: t0, text: "臣在。陛下有何吩咐？" }, t0);
  });
  set("checkModel", (provider: string, model_id: string) => {
    const p = findProv(provider);
    if (!p) return delay({ ok: false, reason: `未知提供商 ${provider}` });
    const v = viewProvider(p);
    const model = (fxCatalog[provider] ?? []).find((m) => m.id === model_id);
    if (!model && !p.allow_unlisted) return delay({ ok: false, listed: false, configured: v.configured, reason: `${p.name} 不许目录外模型 ID：${model_id}` });
    if (!v.configured) return delay({ ok: false, listed: !!model, configured: false, model, reason: `${p.name} 尚未配置凭据（请于设置页登录或设置环境变量）` });
    return delay({ ok: true, listed: !!model, configured: true, model });
  });
  // 稽查
  set("auditFindings", (q?: { status?: string; subject?: string }) => delay(findings.filter((f) => (!q?.status || f.status === q.status) && (!q?.subject || f.subject === q.subject))));
  set("updateFinding", (id: string, r: { status: AuditFinding["status"] }) => {
    const f = findings.find((x) => x.id === id);
    if (!f) return notFound("稽查发现");
    f.status = r.status;
    return delay(f);
  });
  set("impeachments", () => delay(impeachments));
  // 事件与追踪
  set("events", (q: { trace_id?: string; actor?: string; dept?: string; type?: string; since_id?: number; limit?: number }) =>
    delay(
      allEvents
        .filter((e) => (!q.trace_id || e.trace_id === q.trace_id) && (!q.actor || e.actor === q.actor) && (!q.dept || e.dept === q.dept) && (!q.type || e.type.startsWith(q.type)) && (!q.since_id || e.id > q.since_id))
        .slice(-(q.limit ?? 500)),
    ),
  );
  set("trace", (id: string) => {
    if (id === EA) return delay({ trace_id: id, root: sEdict, spans, links, events: allEvents.filter((e) => e.trace_id === EA) } as TraceGraph);
    const e = edicts.find((x) => x.id === id);
    const root: Span = { span_id: `sp_${id}`, trace_id: id, kind: "edict", name: e?.title ?? id, actor: "emperor", status: e?.state === "completed" ? "ok" : "running", started_at: e?.created_at ?? ago(10), ended_at: e?.state === "completed" ? e.state_entered_at : undefined };
    return delay({ trace_id: id, root, spans: [root], links: [], events: [] } as TraceGraph);
  });
  set("traces", () => delay(edicts.map((e) => ({ trace_id: e.id, kind: "edict", name: e.title, status: e.state, started_at: e.created_at }))));

  // 实时
  live.context = (post: string) =>
    delay({
      system_prompt: `${registry.court_preamble}\n\n【本职】${posts.find((p) => p.post_id === post)?.title ?? post}`,
      messages: [
        { role: "user", content: [{ type: "text", text: "【醒来简报】\n<职事清单 json>\n[{\"type\":\"task_assigned\",\"task_id\":\"tk_gong\"}]\n</职事清单>" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "先看任务详情，再查原文。" }, { type: "toolCall", id: "c1", name: "task_get", arguments: { task_id: "tk_gong" } }] },
        { role: "toolResult", toolCallId: "c1", toolName: "task_get", content: [{ type: "text", text: "{\"title\":\"营造中文摘要成文\",\"state\":\"in_progress\"}" }] },
        { role: "assistant", content: [{ type: "text", text: "开始撰写第七篇。" }] },
      ],
      context_tokens: statuses.find((s) => s.post_id === post)?.context_tokens ?? 12000,
    });
  live.log = (post: string) => delay(fakeLog(post));
  live.wake = () => delay({ ok: true as const });
  live.compact = () => delay({ ok: true as const });
  live.stream = (post, onData, onState) => {
    onState?.(true);
    // 与部门 /officials/:post/stream 一致：具名事件 {type, post, ts, data}
    const script: [string, Record<string, unknown>][] = [
      ["state", { state: "thinking" }],
      ["user_message", { text: "【醒来简报】任务 tk_gong：营造中文摘要成文" }],
      ["thinking_delta", { delta: "斗讼律凡六十条，", turn_id: "tn_fx" }],
      ["thinking_delta", { delta: "当撮其要：殴、詈、告讦。", turn_id: "tn_fx" }],
      ["state", { state: "tool", detail: "asset_read" }],
      ["tool_start", { tool: "asset_read", tool_call_id: "t1", args: { path: "律令/摘要草稿.md" } }],
      ["tool_end", { tool: "asset_read", tool_call_id: "t1", is_error: false, result: "（2.1KB）" }],
      ["state", { state: "thinking" }],
      ["text_delta", { delta: "七、斗讼律：", turn_id: "tn_fx" }],
      ["text_delta", { delta: "斗殴以手足击人者笞四十……", turn_id: "tn_fx" }],
      ["tool_start", { tool: "asset_write", tool_call_id: "t2", args: { path: "律令/摘要草稿.md" } }],
      ["tool_end", { tool: "asset_write", tool_call_id: "t2", is_error: false, result: "已写入 v3" }],
      ["message_out", { message_id: "msg_fx", to: "post:xingbu.langzhong", subject: "摘要第七篇已成" }],
      ["llm_end", { stop_reason: "stop" }],
      ["state", { state: "waiting" }],
    ];
    let i = 0;
    const hnd = setInterval(() => {
      const [type, data] = script[i % script.length];
      onData({ type, post, ts: Date.now(), data });
      i++;
    }, 1400);
    return () => clearInterval(hnd);
  };

  // 驿报模拟流
  streamSource.open = (onEvent, onState) => {
    setTimeout(() => onState("open"), 200);
    pushLive = onEvent;
    const samples: [string, string, string, string?][] = [
      ["turn.start", "post:gongbu.langzhong", "工部郎中 开始一轮", EA],
      ["llm.call", "post:gongbu.langzhong", "LLM 调用 3,812 tokens", EA],
      ["tool.call", "post:gongbu.langzhong", "调用工具 asset_write", EA],
      ["message.sent", "post:xingbu.langzhong", "催问成文 → 工部郎中", EA],
      ["turn.end", "post:gongbu.langzhong", "工部郎中 结束一轮", EA],
      ["schedule.fired", "system:scheduler", "定时：巡察（监察御史）"],
      ["turn.start", "post:zhongshu.sheren_b", "中书舍人 开始起草", "tr_ed_kaoke"],
      ["tool.error", "post:bingbu.zhifang_langzhong", "工具出错 ws_run：沙箱超时"],
    ];
    let k = 0;
    const hnd = setInterval(() => {
      const [type, actor, summary, trace] = samples[k % samples.length];
      k++;
      const e: CourtEvent = { id: evId++, uid: uid("ev"), ts: Date.now(), type, actor, dept: actor.split(":")[1]?.split(".")[0], trace_id: trace, summary };
      allEvents.push(e);
      onEvent(e);
    }, 4000);
    return () => clearInterval(hnd);
  };
}
