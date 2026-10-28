// 皇城 hub HTTP API 契约 + 类型化客户端。
// 约定：
//   - 全部 JSON；错误返回 { error: string, code: ErrorCode } 与相应 HTTP 状态码。
//   - 部门 runtime 调用时带 Authorization: Bearer <dept_token> 与 X-Acting-Post: <post_id>。
//     hub 校验 dept_token 属于该部门、acting post 当前属于该部门，并按工具组做 ACL。
//   - 网关带 Authorization: Bearer <gateway_token>。皇帝（Web UI）调用 /api/emperor/* 与只读接口不带 token。
//   - 所有写接口接受可选 idem_key；同 idem_key 重放返回首次结果（hub 表 idempotency 保存）。
//   - 状态机写接口接受可选 expected_version；不符返回 409 code=version_conflict。
import type {
  Address,
  Approval,
  Asset,
  AssetVersion,
  AuditFinding,
  Briefing,
  Budget,
  BudgetCheck,
  CouncilEntry,
  CourtEvent,
  Deliberation,
  DeptId,
  Edict,
  EdictDraft,
  EdictReview,
  ExamAnswer,
  ExamQuestion,
  ExamSession,
  Impeachment,
  InboxItem,
  LedgerEntry,
  Message,
  MessageKind,
  ModelEntry,
  Notification,
  NotificationCategory,
  Official,
  OfficialStatus,
  Priority,
  Registry,
  ReviewIssue,
  Schedule,
  ScheduleRun,
  ScheduleSpec,
  ServiceRequest,
  Stance,
  Task,
  TaskComment,
  TaskState,
  ThinkingLevel,
  TraceGraph,
  Transition,
  Visibility,
} from "./types.ts";
import type { McpAccess, McpInternalState, McpServerInput, McpServerStatus, McpServerView, McpTestRes, McpWriteMeta, McpWriteRes } from "./mcp.ts";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "invalid_state"
  | "rate_limited"
  | "budget_exceeded"
  | "halted"
  | "unavailable"
  | "internal";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ───────────────────────── 请求/响应类型 ─────────────────────────
export interface WriteMeta {
  idem_key?: string;
  trace_id?: string;
  /** 调用方当前 span（官员的 turn/tool span），hub 据此挂接父子关系 */
  parent_span_id?: string;
}

export interface SendMessageReq extends WriteMeta {
  from: Address;
  to: Address;
  cc?: Address[];
  kind: MessageKind;
  subject: string;
  body: string;
  requires_reply?: boolean;
  reply_to?: string;
  thread_id?: string;
  priority?: Priority;
  meta?: Record<string, unknown>;
  /** 来源消息的 hop_count（转发/回复链），hub 据此 +1 */
  parent_hop?: number;
}
export interface SendMessageRes {
  message: Message;
  routed_to: string[]; // 实际投递到的 post_id（to + cc）
}

export interface InboxRes {
  items: InboxItem[];
  latest_seq: number;
}

export interface SearchMessagesQuery {
  post?: string; // 收件或发件涉及该职位
  q?: string;
  kind?: MessageKind;
  trace_id?: string;
  limit?: number;
}

export interface DeliberationDetail {
  deliberation: Deliberation;
  entries: CouncilEntry[];
}

export interface EdictDetail {
  edict: Edict;
  drafts: EdictDraft[];
  reviews: EdictReview[];
  tasks: Task[];
  transitions: Transition[];
  /** 写接口（起草/复署/审核/分派）附带：已自动知会了谁（工具据此提示官员无需另行发信） */
  note?: string;
}

export interface SubmitDraftReq extends WriteMeta {
  post: string;
  title: string;
  objective: string;
  constraints: string;
  acceptance: string;
  deadline_text: string;
  budget_tokens?: number;
  suggested_depts: DeptId[];
  text: string;
  responses?: { issue_id: string; response: string }[];
  expected_version?: number;
}
export interface ReviewReq extends WriteMeta {
  post: string;
  decision: "approve" | "reject";
  issues: Omit<ReviewIssue, "id">[];
  opinion: string;
  expected_version?: number;
}
export interface RemonstrateReq extends WriteMeta {
  post: string;
  risk: string;
  alternative: string;
}
export interface DispatchTaskSpec {
  dept: DeptId;
  title: string;
  instructions: string;
  acceptance: string;
  deadline_minutes?: number;
  verify_by?: "self" | "superior" | "xingbu";
}
export interface DispatchReq extends WriteMeta {
  post: string;
  tasks: DispatchTaskSpec[];
  note?: string;
  expected_version?: number;
}
export interface ReportReq extends WriteMeta {
  post: string;
  summary: string;
  failures?: string;
}
export interface ProposeEdictReq extends WriteMeta {
  post: string;
  deliberation_id?: string;
  title: string;
  intent: string;
  rationale: string;
}
export interface ClarifyReq extends WriteMeta {
  post: string;
  question: string;
}

export interface TaskListQuery {
  assignee?: string;
  dept?: DeptId;
  state?: TaskState | "open";
  trace_id?: string;
  edict_id?: string;
  parent_id?: string;
  limit?: number;
}
export interface CreateTaskReq extends WriteMeta {
  post: string; // 创建者
  dept: DeptId;
  parent_id?: string;
  assignee_post?: string;
  title: string;
  instructions: string;
  acceptance: string;
  deadline_minutes?: number;
  verify_by?: "self" | "superior" | "xingbu";
}
export type TaskActionReq = WriteMeta & {
  post: string;
  expected_version?: number;
} & (
    | { action: "assign"; assignee_post: string; note?: string }
    | { action: "start" }
    | { action: "update"; progress: string }
    | { action: "submit"; result: string; asset_ids?: string[] }
    | { action: "verify"; pass: boolean; comment: string }
    | { action: "block"; reason: string }
    | { action: "unblock"; note?: string }
    | { action: "comment"; content: string }
    | { action: "reassign"; assignee_post: string; reason: string }
    | { action: "cancel"; reason: string }
    | { action: "fail"; reason: string }
    | { action: "extend"; minutes: number; reason: string }
  );
export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  children: Task[];
  transitions: Transition[];
  /** 任务动作附带：已自动知会了谁、附件分享情况 */
  note?: string;
  /** 任务动作附带：被跳过的附件等告警 */
  warnings?: string[];
}

export interface CallServiceReq extends WriteMeta {
  caller: Address;
  target: Address;
  service: string;
  input: unknown;
}
export interface ServiceResultReq extends WriteMeta {
  post: string;
  ok: boolean;
  output: string;
}

export interface PetitionReq extends WriteMeta {
  post: string;
  kind: "action_required" | "fyi";
  category?: NotificationCategory;
  title: string;
  body: string;
  options?: { id: string; label: string }[];
  related?: { type: string; id: string };
}
export interface ResolveNotificationReq {
  option: string;
  comment?: string;
}

export interface CreateScheduleReq extends WriteMeta {
  actor: Address;
  owner: Address; // post:x | dept:y
  title: string;
  spec: ScheduleSpec;
  tz?: string;
  jitter_seconds?: number;
  payload: string;
  expires_at?: number;
  enabled?: boolean;
}
export interface UpdateScheduleReq extends WriteMeta {
  actor: Address;
  title?: string;
  spec?: ScheduleSpec;
  payload?: string;
  enabled?: boolean;
  jitter_seconds?: number;
  expires_at?: number | null;
}

export interface PutAssetReq extends WriteMeta {
  actor: Address; // 写入者
  owner: Address; // post:x | dept:y | court
  path: string;
  content: string; // encoding 决定
  encoding?: "utf8" | "base64";
  mime?: string;
  visibility?: Visibility;
}
export interface AssetListQuery {
  viewer: Address; // emperor 可看全部
  owner?: Address;
  q?: string;
  limit?: number;
}
export interface AssetContent {
  asset: Asset;
  version: number;
  content: string;
  encoding: "utf8" | "base64";
}

export interface LedgerSummaryRow {
  key: string;
  calls: number;
  input: number;
  output: number;
  total_tokens: number;
  cost: number;
}
export interface LedgerSummaryQuery {
  group: "dept" | "post" | "model" | "trace" | "hour" | "official" | "purpose";
  since?: number;
  until?: number;
  filter_scope?: string; // 如 dept:libu
}
/** 某 trace 的用量合计（不受条数上限影响） */
export interface LedgerTraceUsage {
  trace_id: string;
  total_tokens: number;
  input: number;
  output: number;
  cost: number;
  calls: number;
  by_post: { post_id: string; dept: string; calls: number; total_tokens: number; cost: number }[];
  /** 按轮次（turn_id；无轮次的记账归入 turn_id=""）——Web 据 turn span 的 attrs.turn_id 归到节点 */
  by_turn: { turn_id: string; post_id: string; first_ts: number; last_ts: number; calls: number; total_tokens: number; cost: number }[];
}
/** 模型池元数据（config/models.yaml） */
export interface ModelsMeta {
  default_model: string;
  grader_model: string;
  fitness_threshold: number;
  fitness_weights: Record<string, Record<string, number>>;
}
export interface BudgetCheckReq {
  post_id: string;
  trace_id?: string;
  estimate_tokens: number;
}
export interface BudgetStatus {
  budgets: Budget[];
  usage_today: Record<string, { tokens: number; cost: number }>; // key = scope
}

export interface ConfigProposeReq extends WriteMeta {
  actor: Address;
  target_post: string;
  changes: {
    prompt_overrides?: string;
    thinking?: ThinkingLevel;
    extra_tool_groups?: string[];
    disabled_tool_groups?: string[];
  };
  reason: string;
}
export interface ConfigProposeRes {
  status: "applied" | "pending_approval";
  approval_id?: string;
  official?: Official;
}
export interface ConfigHistoryRow {
  id: number;
  official_id: string;
  post_id: string;
  version: number;
  snapshot: Official;
  actor: Address;
  reason: string;
  at: number;
}

export type PersonnelReq = WriteMeta & {
  actor: Address;
  reason: string;
} & (
    | { action: "appoint"; official_id: string; post_id: string }
    | { action: "transfer"; official_id: string; to_post_id: string }
    | { action: "dismiss"; official_id: string }
    | { action: "set_model"; official_id: string; model: string }
    | { action: "new_official"; post_id: string; name?: string; model: string }
  );
export interface PersonnelRes {
  status: "applied" | "pending_approval";
  approval_id?: string;
}

export interface AddModelReq {
  provider: string;
  model_id: string;
  name?: string;
  api?: string;
  base_url?: string;
  context_window?: number;
  notes?: string;
}
// ── 模型提供商（设置页；密钥只存网关，任何接口都不回传密钥本体） ──
export type ProviderAuthType = "api_key" | "oauth";
export interface ProviderInfo {
  id: string;
  name: string;
  /** builtin = pi 内置；custom = 设置页自定义（OpenAI 兼容等）；legacy = config/models.yaml 的 provider: custom */
  kind: "builtin" | "custom" | "legacy";
  base_url?: string;
  apis: string[];
  model_count: number;
  /** 可在设置页发起的登录方式（provider 自带交互流程） */
  login_methods: ProviderAuthType[];
  /** 鉴权是否齐备（存储凭据或环境变量） */
  configured: boolean;
  /** 鉴权来源标签：stored credential / OPENCODE_API_KEY / OAuth … */
  source?: string;
  /** 已存凭据的非密信息 */
  credential?: { type: ProviderAuthType; key_hint?: string; env_names?: string[]; expires?: number };
  /** pi 认得的环境变量名（供参考） */
  env_vars?: string[];
  /** 允许使用目录外的模型 ID（按该提供商的接口与地址推断） */
  allow_unlisted: boolean;
  /** 动态目录（登录后刷新） */
  dynamic?: boolean;
  /** 自定义提供商的额外请求头名（值不回传） */
  header_names?: string[];
  /** 自定义提供商：无鉴权服务 */
  keyless?: boolean;
}
export interface ProviderModelInfo {
  id: string;
  name: string;
  api: string;
  context_window: number;
  max_tokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface CustomProviderModelSpec {
  id: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  /** 默认 ["text"] */
  input?: ("text" | "image")[];
}
export interface CustomProviderSpec {
  /** 小写字母数字与 -_.，不得与内置提供商重名 */
  id: string;
  name?: string;
  /** openai-completions | openai-responses | anthropic-messages | google-generative-ai */
  api: string;
  base_url: string;
  /** 额外请求头（值视同密钥，不回传） */
  headers?: Record<string, string>;
  models?: CustomProviderModelSpec[];
  /** 默认 true */
  allow_unlisted?: boolean;
  /** 只写：设置后存入网关凭据库；留空表示不改 */
  api_key?: string;
  /** 无鉴权服务（本地 Ollama/vLLM 等） */
  keyless?: boolean;
}
export interface ProviderLoginPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}
export interface ProviderLoginEvent {
  at: number;
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  user_code?: string;
  verification_uri?: string;
  links?: { url: string; label?: string }[];
}
export interface ProviderLoginSession {
  id: string;
  provider: string;
  type: ProviderAuthType;
  state: "running" | "awaiting_input" | "done" | "error" | "cancelled";
  /** state = awaiting_input 时的待答提示；seq 用于防止重复作答 */
  prompt?: ProviderLoginPrompt & { seq: number };
  events: ProviderLoginEvent[];
  error?: string;
  started_at: number;
  finished_at?: number;
}
export interface ProviderTestRes {
  ok: boolean;
  model: string;
  latency_ms: number;
  text?: string;
  error?: string;
}
export interface ModelCheckRes {
  ok: boolean;
  /** 模型在目录内（false = 目录外按推断构造） */
  listed?: boolean;
  configured?: boolean;
  model?: ProviderModelInfo;
  reason?: string;
}
export interface ExamSessionDetail {
  session: ExamSession;
  answers: (ExamAnswer & { question: ExamQuestion })[];
}

export interface ImpeachReq extends WriteMeta {
  post: string;
  target: Address;
  charges: string;
  evidence: string;
  finding_ids?: string[];
}
export interface AuditReportReq extends WriteMeta {
  post: string;
  title: string;
  body: string;
}

export interface EventIn {
  uid: string;
  ts: number;
  type: string;
  actor: Address;
  dept?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  subject_type?: string;
  subject_id?: string;
  summary: string;
  data?: Record<string, unknown>;
  /** 若是 span 生命周期事件，可附带 span 以便 hub upsert */
  span?: {
    span_id: string;
    trace_id: string;
    parent_span_id?: string;
    kind: import("./types.ts").SpanKind;
    name: string;
    actor: Address;
    status: import("./types.ts").Span["status"];
    started_at: number;
    ended_at?: number;
    attrs?: Record<string, unknown>;
  };
}

export interface EventsQuery {
  trace_id?: string;
  actor?: Address;
  dept?: string;
  type?: string; // 前缀匹配
  since_id?: number;
  limit?: number;
}

export interface EmperorCouncilReq {
  content: string;
  deliberation_id?: string; // 续议
}
export interface EmperorEdictReq {
  title: string;
  intent: string;
  deliberation_id?: string;
  skip_review?: boolean; // 墨敕
  budget_tokens?: number;
  deadline_minutes?: number;
}
export interface EmperorOralReq {
  to: Address; // post:x | dept:y
  content: string;
  requires_reply?: boolean;
}
export interface EmperorEdictActionReq {
  action: "withdraw" | "force_approve" | "insist" | "revise" | "accept_report" | "retry";
  comment?: string;
}
export interface Overview {
  halted: boolean;
  pending_notifications: number;
  edicts_active: number;
  tasks_open: number;
  tokens_today: number;
  cost_today: number;
  statuses: OfficialStatus[];
  depts_health: Record<string, { ok: boolean; last_seen: number }>;
}

export interface HealthRes {
  ok: boolean;
  role: string;
  version: string;
  details?: Record<string, unknown>;
}

// ───────────────────────── 部门控制面（hub → dept） ─────────────────────────
export interface DoorbellReq {
  posts: string[];
}

// ───────────────────────── 客户端 ─────────────────────────
export interface ClientOptions {
  baseUrl: string;
  token?: string;
  actingPost?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function qs(q: object | undefined): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export class HttpClient {
  constructor(public opts: ClientOptions) {}

  withPost(post: string): this {
    const Ctor = this.constructor as new (o: ClientOptions) => this;
    return new Ctor({ ...this.opts, actingPost: post });
  }

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (this.opts.actingPost) headers["x-acting-post"] = this.opts.actingPost;
    let res: Response;
    try {
      res = await f(this.opts.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new ApiError(503, "unavailable", `无法连接 ${this.opts.baseUrl}${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, (data?.code as ErrorCode) ?? "internal", data?.error ?? res.statusText);
    }
    return data as T;
  }
}

/** hub 客户端：部门 runtime、网关、测试都用它。方法与路由一一对应。 */
export class HubClient extends HttpClient {
  // 名册与心跳
  registry = () => this.req<Registry>("GET", "/api/registry");
  /** 网关专用：所有部门 token → dept 映射（需 gateway token） */
  internalTokens = () => this.req<Record<string, string>>("GET", "/api/internal/tokens");
  health = () => this.req<HealthRes>("GET", "/api/health");
  heartbeat = (statuses: OfficialStatus[]) => this.req<{ ok: true; halted: boolean; registry_version: number }>("POST", "/api/heartbeat", { statuses });
  statuses = () => this.req<OfficialStatus[]>("GET", "/api/statuses");

  // 消息
  sendMessage = (r: SendMessageReq) => this.req<SendMessageRes>("POST", "/api/messages", r);
  inbox = (post: string, after: number, limit = 100) => this.req<InboxRes>("GET", `/api/inbox/${post}${qs({ after, limit })}`);
  inboxCursor = (post: string) => this.req<{ acked_seq: number; latest_seq: number }>("GET", `/api/inbox/${post}/cursor`);
  ackInbox = (post: string, seq: number) => this.req<{ ok: true }>("POST", `/api/inbox/${post}/ack`, { seq });
  getMessage = (id: string) => this.req<Message>("GET", `/api/messages/${id}`);
  thread = (threadId: string) => this.req<Message[]>("GET", `/api/threads/${threadId}`);
  searchMessages = (q: SearchMessagesQuery) => this.req<Message[]>("GET", `/api/messages${qs(q)}`);
  briefing = (post: string, after: number, wake_reason: string) =>
    this.req<Briefing>("GET", `/api/briefing/${post}${qs({ after, wake_reason })}`);

  // 议事
  deliberations = (state?: string) => this.req<Deliberation[]>("GET", `/api/deliberations${qs({ state })}`);
  deliberation = (id: string) => this.req<DeliberationDetail>("GET", `/api/deliberations/${id}`);
  councilSpeak = (id: string, r: WriteMeta & { post: string; stance: Stance; content: string }) =>
    this.req<DeliberationDetail>("POST", `/api/deliberations/${id}/speak`, r);
  councilNextRound = (id: string, r: WriteMeta & { post: string; note?: string }) =>
    this.req<DeliberationDetail>("POST", `/api/deliberations/${id}/next-round`, r);
  councilConclude = (
    id: string,
    r: WriteMeta & { post: string; summary: string; dissent: string; proposed_edict?: { title: string; intent: string }; confidence: number },
  ) => this.req<DeliberationDetail>("POST", `/api/deliberations/${id}/conclude`, r);

  // 诏令
  edicts = (q?: { state?: string; limit?: number }) => this.req<Edict[]>("GET", `/api/edicts${qs(q)}`);
  edict = (id: string) => this.req<EdictDetail>("GET", `/api/edicts/${id}`);
  proposeEdict = (r: ProposeEdictReq) => this.req<Notification>("POST", "/api/edicts/propose", r);
  submitDraft = (id: string, r: SubmitDraftReq) => this.req<EdictDetail>("POST", `/api/edicts/${id}/draft`, r);
  countersign = (id: string, r: WriteMeta & { post: string; approve: boolean; comment: string }) =>
    this.req<EdictDetail>("POST", `/api/edicts/${id}/countersign`, r);
  review = (id: string, r: ReviewReq) => this.req<EdictDetail>("POST", `/api/edicts/${id}/review`, r);
  remonstrate = (id: string, r: RemonstrateReq) => this.req<EdictDetail>("POST", `/api/edicts/${id}/remonstrate`, r);
  dispatch = (id: string, r: DispatchReq) => this.req<EdictDetail>("POST", `/api/edicts/${id}/dispatch`, r);
  report = (id: string, r: ReportReq) => this.req<EdictDetail>("POST", `/api/edicts/${id}/report`, r);
  clarify = (id: string, r: ClarifyReq) => this.req<Notification>("POST", `/api/edicts/${id}/clarify`, r);

  // 任务
  tasks = (q: TaskListQuery) => this.req<Task[]>("GET", `/api/tasks${qs(q)}`);
  task = (id: string) => this.req<TaskDetail>("GET", `/api/tasks/${id}`);
  createTask = (r: CreateTaskReq) => this.req<Task>("POST", "/api/tasks", r);
  taskAction = (id: string, r: TaskActionReq) => this.req<TaskDetail>("POST", `/api/tasks/${id}/action`, r);

  // 服务
  callService = (r: CallServiceReq) => this.req<ServiceRequest>("POST", "/api/services/call", r);
  serviceResult = (id: string, r: ServiceResultReq) => this.req<ServiceRequest>("POST", `/api/services/${id}/result`, r);
  serviceRequest = (id: string) => this.req<ServiceRequest>("GET", `/api/services/${id}`);

  // 皇帝待办（官员侧）
  petition = (r: PetitionReq) => this.req<Notification>("POST", "/api/notifications", r);
  notifications = (q?: { status?: string; limit?: number }) => this.req<Notification[]>("GET", `/api/notifications${qs(q)}`);
  notification = (id: string) => this.req<Notification>("GET", `/api/notifications/${id}`);

  // 定时任务
  schedules = (q?: { owner?: Address }) => this.req<Schedule[]>("GET", `/api/schedules${qs(q)}`);
  createSchedule = (r: CreateScheduleReq) => this.req<Schedule>("POST", "/api/schedules", r);
  updateSchedule = (id: string, r: UpdateScheduleReq) => this.req<Schedule>("PATCH", `/api/schedules/${id}`, r);
  deleteSchedule = (id: string, actor: Address) => this.req<{ ok: true }>("DELETE", `/api/schedules/${id}${qs({ actor })}`);
  triggerSchedule = (id: string, actor: Address) => this.req<ScheduleRun>("POST", `/api/schedules/${id}/trigger`, { actor });
  scheduleRuns = (id: string) => this.req<ScheduleRun[]>("GET", `/api/schedules/${id}/runs`);

  // 资产
  assets = (q: AssetListQuery) => this.req<Asset[]>("GET", `/api/assets${qs(q)}`);
  asset = (id: string, viewer: Address, version?: number) => this.req<AssetContent>("GET", `/api/assets/${id}${qs({ viewer, version })}`);
  putAsset = (r: PutAssetReq) => this.req<Asset>("PUT", "/api/assets", r);
  shareAsset = (id: string, r: WriteMeta & { actor: Address; with: Address[]; visibility?: Visibility }) =>
    this.req<Asset>("POST", `/api/assets/${id}/share`, r);
  deleteAsset = (id: string, actor: Address) => this.req<{ ok: true }>("DELETE", `/api/assets/${id}${qs({ actor })}`);
  assetVersions = (id: string, viewer: Address) => this.req<AssetVersion[]>("GET", `/api/assets/${id}/versions${qs({ viewer })}`);

  // 账本与预算
  ledgerAppend = (entries: LedgerEntry[]) => this.req<{ ok: true; inserted: number }>("POST", "/api/ledger", { entries });
  ledgerSummary = (q: LedgerSummaryQuery) => this.req<LedgerSummaryRow[]>("GET", `/api/ledger/summary${qs(q)}`);
  ledger = (q: { post?: string; trace_id?: string; since?: number; limit?: number }) => this.req<LedgerEntry[]>("GET", `/api/ledger${qs(q)}`);
  /** 某 trace 的用量合计（按职位、按轮次） */
  ledgerTrace = (traceId: string) => this.req<LedgerTraceUsage>("GET", `/api/ledger/trace/${encodeURIComponent(traceId)}`);
  budgetStatus = () => this.req<BudgetStatus>("GET", "/api/budget");
  setBudget = (r: WriteMeta & { actor: Address; scope: string; daily_tokens?: number | null; daily_cost?: number | null; reason?: string }) =>
    this.req<Budget | { status: "pending_approval"; approval_id: string }>("PUT", "/api/budget", r);
  budgetCheck = (r: BudgetCheckReq) => this.req<BudgetCheck>("POST", "/api/budget/check", r);

  // 吏部配置
  officialConfig = (post: string) => this.req<{ official: Official; post: import("./types.ts").PostDef; effective_tool_groups: string[]; system_prompt: string }>("GET", `/api/config/${post}`);
  proposeConfig = (r: ConfigProposeReq) => this.req<ConfigProposeRes>("POST", "/api/config/propose", r);
  configHistory = (post?: string) => this.req<ConfigHistoryRow[]>("GET", `/api/config/history${qs({ post })}`);
  configRollback = (r: WriteMeta & { actor: Address; post: string; version: number; reason: string }) => this.req<ConfigProposeRes>("POST", "/api/config/rollback", r);

  // 户部人事
  personnel = (r: PersonnelReq) => this.req<PersonnelRes>("POST", "/api/personnel", r);
  personnelHistory = () => this.req<{ at: number; actor: Address; action: string; detail: string }[]>("GET", "/api/personnel/history");
  vacancies = () => this.req<import("./types.ts").PostDef[]>("GET", "/api/posts/vacancies");
  approvals = (status?: string) => this.req<Approval[]>("GET", `/api/approvals${qs({ status })}`);

  // 模型与科举
  models = () => this.req<ModelEntry[]>("GET", "/api/models");
  modelsMeta = () => this.req<ModelsMeta>("GET", "/api/models/meta");
  addModel = (r: AddModelReq) => this.req<ModelEntry>("POST", "/api/models", r);
  // 模型提供商（皇帝专用，经 hub 转网关）
  providers = () => this.req<ProviderInfo[]>("GET", "/api/providers");
  providerModels = (id: string) => this.req<ProviderModelInfo[]>("GET", `/api/providers/${encodeURIComponent(id)}/models`);
  saveCustomProvider = (r: CustomProviderSpec) => this.req<ProviderInfo>("POST", "/api/providers", r);
  deleteCustomProvider = (id: string) => this.req<{ ok: true }>("DELETE", `/api/providers/${encodeURIComponent(id)}`);
  logoutProvider = (id: string) => this.req<ProviderInfo>("DELETE", `/api/providers/${encodeURIComponent(id)}/credential`);
  startProviderLogin = (id: string, type: ProviderAuthType) => this.req<ProviderLoginSession>("POST", `/api/providers/${encodeURIComponent(id)}/login`, { type });
  providerLogin = (sid: string) => this.req<ProviderLoginSession>("GET", `/api/provider-logins/${encodeURIComponent(sid)}`);
  answerProviderLogin = (sid: string, seq: number, value: string) => this.req<ProviderLoginSession>("POST", `/api/provider-logins/${encodeURIComponent(sid)}/answer`, { seq, value });
  cancelProviderLogin = (sid: string) => this.req<ProviderLoginSession>("DELETE", `/api/provider-logins/${encodeURIComponent(sid)}`);
  testProvider = (id: string, model_id?: string) => this.req<ProviderTestRes>("POST", `/api/providers/${encodeURIComponent(id)}/test`, { model_id });
  checkModel = (provider: string, model_id: string) => this.req<ModelCheckRes>("GET", `/api/providers/${encodeURIComponent(provider)}/check${qs({ model_id })}`);
  // MCP 工具（皇帝；或持 mcp_admin 工具组的官员，经 X-Acting-Post）
  mcpServers = () => this.req<McpServerView[]>("GET", "/api/mcp/servers");
  mcpServer = (id: string) => this.req<McpServerView>("GET", `/api/mcp/servers/${encodeURIComponent(id)}`);
  createMcpServer = (r: McpServerInput & McpWriteMeta) => this.req<McpWriteRes>("POST", "/api/mcp/servers", r);
  updateMcpServer = (id: string, r: McpServerInput & McpWriteMeta) => this.req<McpWriteRes>("PATCH", `/api/mcp/servers/${encodeURIComponent(id)}`, r);
  deleteMcpServer = (id: string, r: McpWriteMeta = {}) => this.req<McpWriteRes>("DELETE", `/api/mcp/servers/${encodeURIComponent(id)}${qs(r)}`);
  /** 测试已存配置（连上、列工具） */
  testMcpServer = (id: string) => this.req<McpTestRes>("POST", `/api/mcp/servers/${encodeURIComponent(id)}/test`, {});
  /** 测试草稿（仅皇帝）；base_id 给出时，null 值的密钥沿用该服务器已存值 */
  testMcpDraft = (r: { base_id?: string; server: McpServerInput }) => this.req<McpTestRes>("POST", "/api/mcp/test", r);
  restartMcpServer = (id: string) => this.req<McpServerStatus>("POST", `/api/mcp/servers/${encodeURIComponent(id)}/restart`, {});
  mcpStatus = () => this.req<McpServerStatus[]>("GET", "/api/mcp/status");
  /** 某职位（现任官员）可用的 MCP 服务器 */
  mcpAccess = (post: string) => this.req<McpAccess>("GET", `/api/mcp/access${qs({ post })}`);
  /** broker 拉全量配置（含密钥；仅 broker token） */
  mcpInternalState = () => this.req<McpInternalState>("GET", "/api/internal/mcp/state");
  examQuestions = (q?: { dimension?: string; viewer?: Address }) => this.req<ExamQuestion[]>("GET", `/api/exams/questions${qs(q)}`);
  addExamQuestion = (r: WriteMeta & Omit<ExamQuestion, "id" | "created_at" | "status"> & { status?: ExamQuestion["status"] }) =>
    this.req<ExamQuestion>("POST", "/api/exams/questions", r);
  startExam = (r: { model_key: string; actor: Address }) => this.req<ExamSession>("POST", "/api/exams/start", r);
  examSessions = (q?: { model_key?: string }) => this.req<ExamSession[]>("GET", `/api/exams/sessions${qs(q)}`);
  examSession = (id: string) => this.req<ExamSessionDetail>("GET", `/api/exams/sessions/${id}`);
  gradeAnswer = (id: string, r: WriteMeta & { post: string; score: number; comment: string }) => this.req<ExamAnswer>("POST", `/api/exams/answers/${id}/grade`, r);
  publishExam = (r: { session_id: string; actor: Address }) => this.req<ModelEntry>("POST", "/api/exams/publish", r);

  // 稽查
  auditFindings = (q?: { status?: string; subject?: Address; limit?: number }) => this.req<AuditFinding[]>("GET", `/api/audit/findings${qs(q)}`);
  updateFinding = (id: string, r: { actor: Address; status: AuditFinding["status"]; note?: string }) => this.req<AuditFinding>("POST", `/api/audit/findings/${id}`, r);
  impeach = (r: ImpeachReq) => this.req<Impeachment>("POST", "/api/audit/impeach", r);
  auditReport = (r: AuditReportReq) => this.req<Notification>("POST", "/api/audit/report", r);
  impeachments = () => this.req<Impeachment[]>("GET", "/api/audit/impeachments");

  // 事件与追踪
  postEvents = (events: EventIn[]) => this.req<{ ok: true; inserted: number }>("POST", "/api/events", { events });
  events = (q: EventsQuery) => this.req<CourtEvent[]>("GET", `/api/events${qs(q)}`);
  trace = (id: string) => this.req<TraceGraph>("GET", `/api/traces/${id}`);
  traces = (q?: { limit?: number; kind?: string }) =>
    this.req<{ trace_id: string; kind: string; name: string; status: string; started_at: number; ended_at?: number }[]>("GET", `/api/traces${qs(q)}`);

  // 皇帝
  overview = () => this.req<Overview>("GET", "/api/emperor/overview");
  /** 发给皇帝的来信（官员回复口谕/私聊等） */
  emperorInbox = (q?: { from?: Address; limit?: number }) => this.req<Message[]>("GET", `/api/emperor/inbox${qs(q)}`);
  /** 皇帝与某职位的往来（私聊记录） */
  emperorChat = (post: string, limit = 100) => this.req<Message[]>("GET", `/api/emperor/chat/${post}${qs({ limit })}`);
  emperorCouncil = (r: EmperorCouncilReq) => this.req<DeliberationDetail>("POST", "/api/emperor/council", r);
  emperorEdict = (r: EmperorEdictReq) => this.req<Edict>("POST", "/api/emperor/edicts", r);
  emperorOral = (r: EmperorOralReq) => this.req<SendMessageRes>("POST", "/api/emperor/oral", r);
  emperorEdictAction = (id: string, r: EmperorEdictActionReq) => this.req<EdictDetail>("POST", `/api/emperor/edicts/${id}/action`, r);
  resolveNotification = (id: string, r: ResolveNotificationReq) => this.req<Notification>("POST", `/api/emperor/notifications/${id}/resolve`, r);
  halt = (halted: boolean) => this.req<{ halted: boolean }>("POST", "/api/emperor/halt", { halted });
}

/** 部门 API 客户端（其他部门官员调用 / hub 控制面 / Web 经 hub 代理） */
export class DeptClient extends HttpClient {
  health = () => this.req<HealthRes & { officials: OfficialStatus[] }>("GET", "/health");
  info = () => this.req<{ dept: import("./types.ts").DeptDef; officials: OfficialStatus[] }>("GET", "/dept");
  services = () => this.req<import("./types.ts").ServiceDef[]>("GET", "/dept/services");
  deptInbox = (r: Omit<SendMessageReq, "to">) => this.req<SendMessageRes>("POST", "/dept/inbox", r);
  deptService = (name: string, r: Omit<CallServiceReq, "target" | "service">) => this.req<ServiceRequest>("POST", `/dept/services/${name}`, r);
  officialStatus = (post: string) => this.req<OfficialStatus>("GET", `/officials/${post}/status`);
  sendToOfficial = (post: string, r: Omit<SendMessageReq, "to">) => this.req<SendMessageRes>("POST", `/officials/${post}/messages`, r);
  officialService = (post: string, name: string, r: Omit<CallServiceReq, "target" | "service">) =>
    this.req<ServiceRequest>("POST", `/officials/${post}/services/${name}`, r);
  wake = (post: string, reason: string) => this.req<{ ok: true }>("POST", `/officials/${post}/wake`, { reason });
  context = (post: string) => this.req<{ system_prompt: string; messages: unknown[]; context_tokens: number }>("GET", `/officials/${post}/context`);
  log = (post: string, q?: { date?: string; tail?: number }) => this.req<Record<string, unknown>[]>("GET", `/officials/${post}/log${qs(q)}`);
  // 控制面（仅 hub 持 control token）
  doorbell = (r: DoorbellReq) => this.req<{ ok: true }>("POST", "/control/doorbell", r);
  reload = () => this.req<{ ok: true }>("POST", "/control/reload", {});
  pause = (posts?: string[]) => this.req<{ ok: true }>("POST", "/control/pause", { posts });
  resume = (posts?: string[]) => this.req<{ ok: true }>("POST", "/control/resume", { posts });
  compact = (post: string) => this.req<{ ok: true }>("POST", `/control/compact/${post}`, {});
}

/** 沙箱客户端（兵/工/刑部 runtime 调用） */
export interface ExecReq {
  workspace: string; // 部门工作区名，如 bingbu
  command: string;
  cwd?: string;
  timeout_seconds?: number;
  background?: boolean;
}
export interface ExecRes {
  job_id: string;
  state: "running" | "done" | "killed" | "timeout" | "error";
  exit_code?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
}
export class SandboxClient extends HttpClient {
  exec = (r: ExecReq) => this.req<ExecRes>("POST", "/exec", r);
  job = (id: string) => this.req<ExecRes>("GET", `/jobs/${id}`);
  cancel = (id: string) => this.req<ExecRes>("POST", `/jobs/${id}/cancel`, {});
  readFile = (workspace: string, path: string) => this.req<{ content: string; encoding: "utf8" | "base64"; size: number }>("GET", `/fs/read${qs({ workspace, path })}`);
  writeFile = (r: { workspace: string; path: string; content: string; encoding?: "utf8" | "base64" }) => this.req<{ ok: true; size: number }>("POST", "/fs/write", r);
  list = (workspace: string, path = ".") => this.req<{ name: string; type: "file" | "dir"; size: number }[]>("GET", `/fs/list${qs({ workspace, path })}`);
  fetchUrl = (r: { url: string; max_bytes?: number }) => this.req<{ status: number; content_type: string; text: string; truncated: boolean }>("POST", "/fetch", r);
}

// ───────────────────────── LLM 网关 ─────────────────────────
/** 网关调用元数据（streamProxy 的 options.metadata 与 /api/complete 的 metadata 同构） */
export interface GatewayMeta {
  post_id: string; // 官员职位；系统用途用 "system.<name>"，如 system.kaochang（考场）
  official_id?: string;
  dept?: string;
  trace_id?: string;
  turn_id?: string;
  call_idx?: number;
  purpose: "turn" | "compaction" | "exam" | "grading" | "other";
}
export interface GatewayCompleteReq {
  model_key: string; // provider/model_id
  context: {
    systemPrompt?: string;
    messages: unknown[]; // pi-ai Message[]
    tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  };
  options?: { reasoning?: string; maxTokens?: number; sessionId?: string };
  metadata: GatewayMeta;
  /** 预算检查豁免（考场/阅卷由 hub 发起，计入账本但不受官员预算限制） */
  skip_budget?: boolean;
}
export interface GatewayCompleteRes {
  message: {
    role: "assistant";
    content: ({ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> })[];
    stopReason: string;
    errorMessage?: string;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };
    durationMs?: number;
  };
}
export interface GatewayModelInfo {
  key: string;
  provider: string;
  model_id: string;
  name: string;
  api: string;
  context_window: number;
  max_tokens: number;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  available: boolean;
}
export class GatewayClient extends HttpClient {
  health = () => this.req<HealthRes>("GET", "/health");
  models = () => this.req<GatewayModelInfo[]>("GET", "/api/models");
  complete = (r: GatewayCompleteReq) => this.req<GatewayCompleteRes>("POST", "/api/complete", r);
  // 管理接口（仅网关 token，即 hub）
  adminProviders = () => this.req<ProviderInfo[]>("GET", "/admin/providers");
  adminProviderModels = (id: string) => this.req<ProviderModelInfo[]>("GET", `/admin/providers/${encodeURIComponent(id)}/models`);
  adminSaveProvider = (r: CustomProviderSpec) => this.req<ProviderInfo>("POST", "/admin/providers", r);
  adminDeleteProvider = (id: string) => this.req<{ ok: true }>("DELETE", `/admin/providers/${encodeURIComponent(id)}`);
  adminLogout = (id: string) => this.req<ProviderInfo>("DELETE", `/admin/providers/${encodeURIComponent(id)}/credential`);
  adminStartLogin = (id: string, type: ProviderAuthType) => this.req<ProviderLoginSession>("POST", `/admin/providers/${encodeURIComponent(id)}/login`, { type });
  adminLogin = (sid: string) => this.req<ProviderLoginSession>("GET", `/admin/logins/${encodeURIComponent(sid)}`);
  adminAnswerLogin = (sid: string, seq: number, value: string) => this.req<ProviderLoginSession>("POST", `/admin/logins/${encodeURIComponent(sid)}/answer`, { seq, value });
  adminCancelLogin = (sid: string) => this.req<ProviderLoginSession>("DELETE", `/admin/logins/${encodeURIComponent(sid)}`);
  adminTestProvider = (id: string, model_id?: string) => this.req<ProviderTestRes>("POST", `/admin/providers/${encodeURIComponent(id)}/test`, { model_id });
  adminCheckModel = (provider: string, model_id: string) => this.req<ModelCheckRes>("GET", `/admin/providers/${encodeURIComponent(provider)}/check${qs({ model_id })}`);
}
