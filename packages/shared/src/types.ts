// 朝廷领域模型（hub、gateway、dept、web 共用）。时间一律为 epoch 毫秒。

// ───────────────────────── 地址 ─────────────────────────
// 地址统一为字符串：
//   "emperor"            皇帝
//   "post:<post_id>"     职位（官员通过职位寻址，调岗不断址）
//   "dept:<dept_id>"     部门（由 hub 按路由规则分派给某职位）
//   "system:<name>"      系统（hub 看门狗、调度器、稽查规则、考场等）
export type Address = string;

export type DeptId =
  | "zhengshitang"
  | "zhongshu"
  | "menxia"
  | "shangshu"
  | "libu"
  | "hubu"
  | "libu_rites"
  | "bingbu"
  | "xingbu"
  | "gongbu"
  | "yushitai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ───────────────────────── 名册 ─────────────────────────
export interface ServiceDef {
  name: string;
  description: string;
  /** JSON Schema（宽松，仅供展示与提示） */
  input_schema?: Record<string, unknown>;
  sla_seconds: number;
  /** 部门级服务按这些路由角色依次挑选健康官员 */
  route_roles?: string[];
}

export interface ScheduleSpec {
  cron?: string;
  every_seconds?: number;
  at?: number;
}

export interface DefaultSchedule {
  title: string;
  spec: ScheduleSpec;
  payload: string;
  jitter_seconds?: number;
}

export interface DeptDef {
  id: DeptId;
  name: string; // 中文名，如「门下省」
  brief: string; // 一句话职掌
  duties: string; // 部门职掌（进系统提示）
  /** 容器内主机名与端口（docker 网络寻址） */
  host: string;
  port: number;
  /** 收件路由：消息类型/服务名 → 路由角色优先级。"*" 为默认 */
  routing: Record<string, string[]>;
  services: ServiceDef[];
  default_schedules?: DefaultSchedule[];
}

export interface PostDef {
  post_id: string; // 如 "menxia.jishizhong_a"
  dept: DeptId;
  title: string; // 如「给事中」
  rank: string; // 品阶，如「正五品上」
  benguan?: string; // 本官（政事堂宰相用）
  duties: string;
  /** 工具上限（吏部只能在此范围内增减） */
  tool_groups: string[];
  /** 路由角色：head | deputy | duty | chair | member | recorder | drafter | reviewer | remonstrator | dispatcher | executor | verifier | auditor | examiner | grader | budget | personnel | translator | polisher | ... */
  roles: string[];
  services?: ServiceDef[];
  activity: "always" | "on_demand";
  /** 可打断 sleep 的来源：emperor | edict | urgent | any */
  interruptible_by: string[];
  /** 无指令时默认 wait_for 的超时（秒） */
  default_wait_seconds: number;
  /** 改其配置/人事须皇帝批准 */
  approval_sensitive: boolean;
  default_schedules?: DefaultSchedule[];
  /** 额外职位提示词 */
  prompt?: string;
}

export interface Official {
  official_id: string;
  name: string; // 唐风姓名（虚构）
  model: string; // 模型键 "provider/model_id"
  thinking: ThinkingLevel;
  prompt_overrides: string; // 吏部可改的个人提示词附加段
  extra_tool_groups: string[]; // 吏部在职位上限内授予的工具组（空=职位全部）
  disabled_tool_groups: string[];
  status: "active" | "suspended" | "dismissed";
  config_version: number;
  created_at: number;
}

export interface Appointment {
  post_id: string;
  official_id: string;
  since: number;
}

export interface Registry {
  version: number;
  depts: DeptDef[];
  posts: PostDef[];
  officials: Official[];
  appointments: Appointment[];
  models: ModelEntry[];
  /** 朝廷通则（所有官员共享的系统提示开头） */
  court_preamble: string;
  halted: boolean; // 罢朝
}

// ───────────────────────── 消息 ─────────────────────────
export type MessageKind =
  | "chat" // 对话（含皇帝私聊）
  | "oral_order" // 口谕
  | "council" // 政事堂议事
  | "edict_notice" // 诏令流转通知
  | "task_notice" // 任务流转通知
  | "service_request"
  | "service_result"
  | "schedule" // 定时任务触发
  | "notification_reply" // 皇帝批复回写
  | "audit" // 稽查发现/弹劾
  | "fyi" // 抄送/知会，不唤醒
  | "system";

export type Priority = "low" | "normal" | "high" | "urgent";

export interface Message {
  id: string;
  from: Address;
  to: Address;
  cc: Address[];
  kind: MessageKind;
  subject: string;
  body: string;
  requires_reply: boolean;
  reply_to?: string;
  thread_id: string;
  trace_id: string;
  span_id: string;
  priority: Priority;
  hop_count: number;
  meta?: Record<string, unknown>;
  created_at: number;
}

/** 投递记录：某职位收件箱中的一条（含抄送） */
export interface Delivery {
  post_id: string;
  seq: number; // 该职位单调递增
  message_id: string;
  wakes: boolean; // 是否唤醒
  role: "to" | "cc";
  created_at: number;
}

export interface InboxItem {
  delivery: Delivery;
  message: Message;
}

// ───────────────────────── 议事 ─────────────────────────
export type Stance = "support" | "oppose" | "reserve" | "pass";

export interface Deliberation {
  id: string;
  trace_id: string;
  topic: string;
  state: "open" | "concluded" | "closed";
  chair_post: string;
  members: string[]; // 发言成员（不含堂后官）
  session_no: number; // 皇帝每次发言开启一个新场次
  round: number; // 本场次第几轮（1..max_rounds）
  max_rounds: number;
  speaker_queue: string[]; // 本轮尚未发言者（按序）
  current_speaker?: string;
  conclusion?: CouncilConclusion;
  token_spent: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface CouncilConclusion {
  summary: string;
  dissent: string;
  proposed_edict?: { title: string; intent: string };
  confidence: number; // 0..1
  concluded_by: string;
  at: number;
}

export interface CouncilEntry {
  id: string;
  deliberation_id: string;
  session_no: number;
  round: number;
  author: Address;
  stance?: Stance;
  content: string;
  created_at: number;
}

// ───────────────────────── 诏令 ─────────────────────────
export type EdictState =
  | "issued"
  | "drafting"
  | "reviewing"
  | "remonstrated"
  | "escalated"
  | "approved"
  | "awaiting_sign"
  | "executing"
  | "reported"
  | "completed"
  | "withdrawn"
  | "failed"
  | "blocked_budget";

export const REJECT_REASONS = ["违法越权", "不可行", "超预算", "表述不清", "与前诏冲突", "缺验收标准"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface Edict {
  id: string; // 亦即 trace_id
  title: string;
  intent: string; // 皇帝原话/旨意
  state: EdictState;
  version: number;
  deliberation_id?: string;
  skip_review: boolean; // 墨敕
  drafter_post?: string;
  reviewer_post?: string;
  dispatcher_post?: string;
  draft_no: number; // 当前草稿号（0=尚无）
  reject_count: number;
  remonstrated_draft_nos: number[];
  budget_tokens?: number;
  deadline?: number;
  report?: { summary: string; failures: string; by: string; at: number };
  created_at: number;
  state_entered_at: number;
  sla_at?: number;
  lease_until?: number;
}

export interface EdictDraft {
  edict_id: string;
  no: number;
  title: string;
  objective: string;
  constraints: string;
  acceptance: string;
  deadline_text: string;
  budget_tokens?: number;
  suggested_depts: DeptId[];
  text: string; // 诏书正文
  responses: { issue_id: string; response: string }[];
  author_post: string;
  countersigned_by?: string;
  created_at: number;
}

export interface ReviewIssue {
  id: string;
  severity: "blocking" | "advisory";
  clause: string;
  reason: RejectReason;
  required_change: string;
}

export interface EdictReview {
  id: string;
  edict_id: string;
  draft_no: number;
  reviewer_post: string;
  decision: "approve" | "reject";
  issues: ReviewIssue[];
  opinion: string;
  created_at: number;
}

export interface Transition {
  id: number;
  subject_type: "edict" | "task" | "deliberation";
  subject_id: string;
  from_state: string;
  to_state: string;
  actor: Address;
  reason: string;
  at: number;
}

// ───────────────────────── 任务 ─────────────────────────
export type TaskState =
  | "pending"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "submitted"
  | "returned"
  | "done"
  | "cancelled"
  | "failed";

export interface Task {
  id: string;
  trace_id: string;
  edict_id?: string;
  parent_id?: string;
  dept: DeptId;
  assignee_post?: string;
  creator: Address;
  title: string;
  instructions: string;
  acceptance: string;
  deadline?: number;
  verify_by: "self" | "superior" | "xingbu";
  verifier_post?: string;
  state: TaskState;
  version: number;
  result?: string;
  result_assets: string[];
  return_count: number;
  reassign_count: number;
  block_reason?: string;
  created_at: number;
  updated_at: number;
  state_entered_at: number;
  lease_until?: number;
}

export interface TaskComment {
  id: string;
  task_id: string;
  author: Address;
  content: string;
  created_at: number;
}

// ───────────────────────── 服务调用 ─────────────────────────
export interface ServiceRequest {
  id: string;
  trace_id: string;
  caller: Address;
  target: Address; // post:x | dept:y
  routed_to?: string; // post_id
  service: string;
  input: unknown;
  state: "pending" | "done" | "failed" | "cancelled" | "expired";
  output?: string;
  request_message_id?: string;
  created_at: number;
  sla_at: number;
  done_at?: number;
}

// ───────────────────────── 皇帝待办 ─────────────────────────
export type NotificationCategory =
  | "edict_proposal" // 政事堂拟旨，待照准
  | "council_conclusion"
  | "remonstrance" // 谏诤
  | "escalation" // 封驳升级/SLA 上报
  | "report" // 复奏待御览
  | "approval" // 配置/人事/定时/资产访问/预算审批
  | "impeachment"
  | "budget"
  | "exam"
  | "petition" // 上奏
  | "progress" // 进展知会
  | "incident"
  | "audit_report"
  | "clarification";

export interface NotificationOption {
  id: string;
  label: string;
}

export interface Notification {
  id: string;
  kind: "action_required" | "fyi";
  category: NotificationCategory;
  title: string;
  body: string;
  from: Address;
  related?: { type: string; id: string };
  options: NotificationOption[];
  status: "pending" | "resolved" | "dismissed";
  resolution?: { option: string; comment: string; at: number };
  dedupe_key?: string;
  trace_id?: string;
  created_at: number;
}

export interface Approval {
  id: string;
  type: "config_change" | "personnel" | "schedule" | "asset_access" | "budget" | "new_official";
  payload: Record<string, unknown>;
  requested_by: Address;
  status: "pending" | "approved" | "rejected";
  notification_id: string;
  created_at: number;
  decided_at?: number;
}

// ───────────────────────── 定时任务 ─────────────────────────
export interface Schedule {
  id: string;
  owner: Address; // post:x | dept:y
  created_by: Address;
  title: string;
  spec: ScheduleSpec;
  tz: string;
  jitter_seconds: number;
  payload: string;
  enabled: boolean;
  status: "active" | "pending_approval" | "paused" | "expired";
  expires_at?: number;
  next_run_at?: number;
  last_run_at?: number;
  run_count: number;
  missed_count: number;
  created_at: number;
  updated_at: number;
}

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  scheduled_at: number;
  fired_at: number;
  message_id?: string;
  trace_id?: string;
  outcome: "fired" | "skipped_unhandled" | "catchup" | "manual";
}

// ───────────────────────── 资产 ─────────────────────────
export type Visibility = "private" | "department" | "court";

export interface Asset {
  id: string;
  owner: Address; // post:x（个人私产随职位地址；见 owner_official）| dept:y | court
  owner_official?: string; // 个人资产实际属于官员 persona（调岗跟人走）
  path: string;
  visibility: Visibility;
  shared_with: Address[];
  mime: string;
  size: number;
  sha256: string;
  latest_version: number;
  trace_id?: string;
  created_at: number;
  updated_at: number;
}

export interface AssetVersion {
  asset_id: string;
  version: number;
  sha256: string;
  size: number;
  author: Address;
  created_at: number;
}

// ───────────────────────── 账本与预算 ─────────────────────────
export interface LedgerEntry {
  id: string;
  idem_key: string;
  ts: number;
  post_id: string;
  official_id: string;
  dept: string;
  trace_id?: string;
  turn_id?: string;
  purpose: "turn" | "compaction" | "exam" | "grading" | "other";
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost: number; // USD
  duration_ms: number;
  ok: boolean;
  error?: string;
}

/** scope: "global" | "dept:<id>" | "post:<id>" | "trace:<id>" */
export interface Budget {
  scope: string;
  daily_tokens?: number;
  daily_cost?: number;
  updated_by: Address;
  updated_at: number;
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  scope?: string; // 触发拦截的维度
  remaining_tokens?: number;
}

// ───────────────────────── 模型池与科举 ─────────────────────────
export type ExamDimension =
  | "reasoning"
  | "instruction"
  | "writing"
  | "translation"
  | "tool_use"
  | "json"
  | "code"
  | "summary";

export const EXAM_DIMENSIONS: ExamDimension[] = [
  "reasoning",
  "instruction",
  "writing",
  "translation",
  "tool_use",
  "json",
  "code",
  "summary",
];

export type ExamDifficulty = "basic" | "hard";

export type ExamQuestionKind =
  | "exact"
  | "contains"
  | "regex"
  | "json_keys"
  | "tool_call"
  | "rubric"
  | "json_exact"
  | "numeric"
  | "multi_regex"
  | "length_range"
  | "code_output"
  | "tool_calls";

export type ExamScoresByDifficulty = Partial<Record<ExamDifficulty, Partial<Record<ExamDimension, number>>>>;

/** 科举实测指标（考场计时计费所得，非阅卷） */
export interface ExamMetrics {
  /** 速度分 0..100：作答耗时中位数映射（≤2s=100，≥60s=0，其间按对数线性） */
  speed?: number;
  /** 性价比分 0..100：每题平均成本映射（≤$0.0001=100，≥$0.01=0，其间按对数线性）；全部成本为 0（价格未知）时缺省 */
  cost_efficiency?: number;
  median_latency_ms?: number;
  cost_per_question?: number;
}

export interface ModelEntry {
  key: string; // "provider/model_id"
  provider: string;
  model_id: string;
  name: string;
  /** 自定义 OpenAI 兼容模型时需要 */
  api?: string;
  base_url?: string;
  context_window?: number;
  status: "candidate" | "examining" | "examined" | "failed" | "retired";
  scores?: Partial<Record<ExamDimension, number>>; // 0..100
  fitness?: Partial<Record<DeptId, number>>; // 0..100
  /** 分难度维度分（放榜时随 scores 公开） */
  scores_by_difficulty?: ExamScoresByDifficulty;
  /** 实测指标：速度、性价比（非阅卷所得，放榜时公开） */
  metrics?: ExamMetrics;
  added_at: number;
  notes?: string;
}

export interface ExamQuestion {
  id: string;
  dimension: ExamDimension;
  prompt: string;
  /**
   * 判分方式。基础：exact/contains/regex 自动判；json_keys 判 JSON 含键；tool_call 判是否以正确参数调用工具；rubric 需阅卷。
   * 难题（确定性判分）：json_exact 解析后深度全等；numeric 数值（可带容差）；multi_regex 多条正则全中且禁用模式皆不中（可附长度约束，按条给分）；
   * length_range 长度区间；code_output 代码输出逐字比对；tool_calls 多次/嵌套参数工具调用（含禁用干扰工具）。
   */
  kind: ExamQuestionKind;
  /**
   * exact/contains/regex/json_keys(逗号分隔)/tool_call(JSON: {name, args})/json_exact(目标 JSON)/numeric("42" 或 "7.6±0.05")/
   * multi_regex(JSON: {all, none, flags?, length?})/length_range(JSON: {min, max, unit})/code_output(期望输出原文)/tool_calls(JSON: {calls, forbid?, exact_count?})
   */
  expected?: string;
  /** 难度：basic（缺省）权重 1；hard 权重 3 */
  difficulty?: ExamDifficulty;
  /** 自定义计分权重（缺省按难度） */
  weight?: number;
  rubric?: string;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  author: Address;
  status: "active" | "draft" | "retired";
  created_at: number;
}

export interface ExamSession {
  id: string;
  model_key: string;
  state: "pending" | "running" | "grading" | "done" | "failed";
  started_at?: number;
  finished_at?: number;
  scores?: Partial<Record<ExamDimension, number>>;
  total?: number;
  /** 分难度维度分（basic / hard 各自的加权均分） */
  scores_by_difficulty?: ExamScoresByDifficulty;
  /** 实测指标（非阅卷）：速度、性价比 */
  metrics?: ExamMetrics;
  error?: string;
  created_at: number;
}

export interface ExamAnswer {
  id: string;
  session_id: string;
  question_id: string;
  output: string;
  tool_calls?: unknown;
  latency_ms: number;
  tokens: number;
  cost: number;
  auto_score?: number; // 0..100
  grader_score?: number;
  grader?: Address;
  comment?: string;
  state: "answered" | "needs_grading" | "graded" | "error";
}

// ───────────────────────── 稽查 ─────────────────────────
export interface AuditFinding {
  id: string;
  rule: string; // loop_chat | idle_spin | overdue | tool_errors | claimed_no_output | privilege_attempt | injection_suspect | budget_burn
  severity: "low" | "medium" | "high";
  subject: Address;
  trace_id?: string;
  summary: string;
  evidence: Record<string, unknown>;
  status: "open" | "reviewed" | "impeached" | "dismissed";
  created_at: number;
}

export interface Impeachment {
  id: string;
  by: Address;
  target: Address;
  charges: string;
  evidence: string;
  finding_ids: string[];
  status: "pending" | "dismissed" | "to_libu" | "to_hubu" | "to_xingbu";
  notification_id: string;
  created_at: number;
}

// ───────────────────────── 事件、追踪、心跳 ─────────────────────────
export interface CourtEvent {
  id: number; // hub 自增
  uid: string; // 来源唯一 ID（去重）
  ts: number;
  type: string; // 例如 message.sent edict.state task.state turn.start turn.end llm.call tool.call schedule.fired ...
  actor: Address;
  dept?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  subject_type?: string;
  subject_id?: string;
  summary: string;
  data?: Record<string, unknown>;
}

export type SpanKind =
  | "edict"
  | "deliberation"
  | "draft"
  | "review"
  | "remonstrance"
  | "dispatch"
  | "report"
  | "task"
  | "turn"
  | "message"
  | "service"
  | "schedule"
  | "tool"
  | "notification";

export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  kind: SpanKind;
  name: string;
  actor: Address;
  status: "running" | "ok" | "error" | "rejected" | "cancelled";
  started_at: number;
  ended_at?: number;
  attrs?: Record<string, unknown>;
}

export interface TraceGraph {
  trace_id: string;
  root?: Span;
  spans: Span[];
  /** 额外边：消息 from→to、服务调用等（span 间父子边由 parent_span_id 隐含） */
  links: { from_span: string; to_span: string; kind: "message" | "service" | "causes"; label?: string }[];
  events: CourtEvent[];
}

export type OfficialState =
  | "idle"
  | "sleeping"
  | "waiting"
  | "thinking"
  | "tool"
  | "paused"
  | "suspended" // 停俸（预算）
  | "sick" // 提供商故障
  | "offline"
  | "vacant";

export interface OfficialStatus {
  post_id: string;
  official_id?: string;
  dept: string;
  state: OfficialState;
  status_text?: string;
  current_turn_id?: string;
  current_trace_id?: string;
  next_wake_at?: number;
  wait_filter?: WaitFilter;
  last_progress_at: number;
  turns_last_hour: number;
  tokens_today: number;
  context_tokens?: number;
  updated_at: number;
}

export interface WaitFilter {
  from?: Address[];
  kinds?: MessageKind[];
  trace_id?: string;
  reply_to?: string;
  /** 等待某皇帝待办被批复 */
  notification_id?: string;
}

/** 醒来简报中的结构化职事（真实模型与 mock 大脑都依据它行动） */
export type PendingItem =
  | { type: "message"; message_id: string; from: Address; kind: MessageKind; subject: string; requires_reply: boolean; trace_id: string }
  | { type: "council_turn"; deliberation_id: string; round: number; topic: string }
  | { type: "council_chair"; deliberation_id: string; round: number; all_spoken: boolean; /** 议题（mock 大脑据此拟旨意标题；可选） */ topic?: string }
  | { type: "edict_draft"; edict_id: string; title: string; draft_no_next: number; rejected: boolean; open_issue_ids: string[] }
  | { type: "edict_countersign"; edict_id: string; title: string; draft_no: number }
  | { type: "edict_review"; edict_id: string; title: string; draft_no: number; prior_issue_ids: string[] }
  | { type: "edict_dispatch"; edict_id: string; title: string; suggested_depts: DeptId[] }
  | { type: "edict_report"; edict_id: string; title: string; tasks_total: number; tasks_open: number }
  | { type: "task_assigned"; task_id: string; title: string; state: TaskState; is_head: boolean }
  | { type: "task_verify"; task_id: string; title: string }
  | { type: "service_request"; request_id: string; service: string; caller: Address }
  | { type: "schedule"; schedule_id: string; title: string; payload: string }
  | { type: "notification_reply"; notification_id: string; option: string; comment: string }
  | { type: "audit_finding"; finding_id: string; rule: string; subject: Address }
  | { type: "exam_grading"; answer_id: string; session_id: string };

export interface Briefing {
  post_id: string;
  generated_at: number;
  wake_reason: string;
  items: PendingItem[];
  /** 未列出的计数（超出 K 条） */
  more: number;
  latest_seq: number;
}
