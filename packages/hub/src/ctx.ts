// hub 内部服务契约。各模块只通过 HubCtx 互相调用；实现分布在 services/*.ts。
// 约定：所有写方法都是同步的（node:sqlite 同步 API），在 db.tx 内调用安全；
// 需要网络 IO 的（门铃、SSE 推送）在提交后异步进行，失败不影响事务。
import type {
  Address,
  Approval,
  Asset,
  CourtEvent,
  Deliberation,
  DeptDef,
  DeptId,
  Edict,
  Message,
  ModelEntry,
  Notification,
  NotificationCategory,
  Official,
  OfficialStatus,
  PendingItem,
  PostDef,
  Registry,
  Schedule,
  ScheduleRun,
  ServiceRequest,
  Span,
  Task,
  Briefing,
  LedgerEntry,
  BudgetCheck,
  AuditFinding,
} from "@court/shared";
import type { CourtConfig, ModelsConfig, SendMessageReq, SendMessageRes, EventIn, ErrorCode } from "@court/shared";
import type { Db } from "./db.ts";

export class HubError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export const bad = (msg: string) => new HubError(400, "bad_request", msg);
export const forbidden = (msg: string) => new HubError(403, "forbidden", msg);
export const notFound = (what: string) => new HubError(404, "not_found", `${what} 不存在`);
export const invalidState = (msg: string) => new HubError(409, "invalid_state", msg);
export const versionConflict = (cur: number) => new HubError(409, "version_conflict", `版本冲突，当前版本 ${cur}，请重新读取后再操作`);
export const rateLimited = (msg: string) => new HubError(429, "rate_limited", msg);

/** 请求方身份（auth 中间件解析） */
export interface Principal {
  /** mcp = MCP 中转站（broker token），只能访问 /api/internal/mcp/* */
  kind: "emperor" | "dept" | "gateway" | "system" | "mcp";
  dept?: DeptId;
  /** dept 调用时经校验的 acting post（X-Acting-Post） */
  post?: string;
}

// ───────────────────────── A 组实现 ─────────────────────────
export interface RegistryService {
  /** 完整名册快照（带 version，任何人事/配置变化 version+1） */
  snapshot(): Registry;
  version(): number;
  bump(reason: string): void;
  dept(id: string): (DeptDef & { countersign?: boolean }) | undefined;
  depts(): (DeptDef & { countersign?: boolean })[];
  post(postId: string): PostDef | undefined;
  posts(dept?: string): PostDef[];
  /** 职位当前在任官员 */
  officialOf(postId: string): Official | undefined;
  official(officialId: string): Official | undefined;
  postOf(officialId: string): string | undefined;
  saveOfficial(o: Official, actor: Address, reason: string): Official; // 写 config_history，version+1
  /** 按路由角色挑选：在部门内按 roles 优先级，挑「健康 + 在任 + 未结任务最少」者；exclude 用于避开某人 */
  pickPost(dept: string, roles: string[], opts?: { exclude?: string[] }): string | undefined;
  /** 部门路由：消息类型/服务名 → post */
  routeDept(dept: string, key: string, opts?: { exclude?: string[] }): string | undefined;
  /** 有效工具组与工具名（服务端 ACL 用） */
  toolsOf(postId: string): Set<string>;
  hasTool(postId: string, tool: string): boolean;
  deptToken(dept: string): string | undefined;
  deptByToken(token: string): DeptId | undefined;
  isHalted(): boolean;
  setHalted(v: boolean): void;
  /** 渲染某职位完整系统提示词（通则→部门→职位→个人覆盖→工具/服务清单） */
  systemPrompt(postId: string): string;
  model(key: string): ModelEntry | undefined;
  models(): ModelEntry[];
  saveModel(m: ModelEntry): void;
}

export interface EventService {
  /** 写事件（去重 uid）并推送 SSE */
  emit(e: Omit<CourtEvent, "id" | "uid" | "ts"> & { uid?: string; ts?: number }): CourtEvent | undefined;
  ingest(events: EventIn[]): number;
  /** 创建或更新 span（kind/name/actor 等），返回 span_id */
  span(s: Partial<Span> & { trace_id: string; kind: Span["kind"]; name: string; actor: Address; span_id?: string }): string;
  endSpan(spanId: string, status: Span["status"], attrs?: Record<string, unknown>): void;
  link(fromSpan: string, toSpan: string, kind: "message" | "service" | "causes", traceId: string, label?: string): void;
  /** 只推 SSE、不入库的轻量事件（如 status.changed）；id 为负数（不可作 Last-Event-ID 续传） */
  publish(e: Omit<CourtEvent, "id" | "uid" | "ts">): CourtEvent;
  /** SSE 订阅（Web） */
  subscribe(fn: (e: CourtEvent) => void): () => void;
}

export interface MessageService {
  /**
   * 发送消息：校验地址、风暴限流（hop、对话来回、广播人数）、部门路由、分配 seq、计算是否唤醒、
   * 写 span + 事件，提交后对相关部门发门铃。to=emperor 时转为皇帝待办（fyi）或议事记录。
   */
  send(req: SendMessageReq, principal?: Principal): SendMessageRes;
  get(id: string): Message | undefined;
  /** 某职位 after 之后的收件 */
  inbox(postId: string, after: number, limit: number): { items: { delivery: import("@court/shared").Delivery; message: Message }[]; latest_seq: number };
  ack(postId: string, seq: number): void;
  ackedSeq(postId: string): number;
  latestSeq(postId: string): number;
  thread(threadId: string): Message[];
  /** 系统消息快捷方式：通知某职位（wake 控制是否唤醒） */
  notifyPost(postId: string, kind: Message["kind"], subject: string, body: string, opts?: { trace_id?: string; wakes?: boolean; meta?: Record<string, unknown>; from?: Address; priority?: Message["priority"] }): Message;
}

export interface NotificationService {
  /** 创建皇帝待办（dedupe_key 去重：已有 pending 则返回原条） */
  create(n: Omit<Notification, "id" | "status" | "created_at"> & { status?: Notification["status"] }): Notification;
  get(id: string): Notification | undefined;
  list(status?: string, limit?: number): Notification[];
  /** 皇帝批复：标记 resolved，调用该类别注册的处理器，并回写发起人（notification_reply 消息，唤醒） */
  resolve(id: string, option: string, comment: string): Notification;
  /** 注册某类别的批复处理器（B 组为 edict_proposal/remonstrance/escalation/report/... 注册） */
  onResolve(category: NotificationCategory, handler: (n: Notification, option: string, comment: string) => void): void;
  /** 官员上奏限流检查（每人每小时 petitionPerHour） */
  checkPetitionRate(from: Address): void;
}

export interface ApprovalService {
  /** 创建审批 + 对应皇帝待办（options: approve/reject）；批准后执行 apply */
  request(type: Approval["type"], payload: Record<string, unknown>, requestedBy: Address, title: string, body: string): Approval;
  /** 注册审批类型的执行器 */
  onApprove(type: Approval["type"], apply: (a: Approval) => void): void;
}

export interface IdempotencyService {
  /** 若 key 已存在返回缓存结果；否则执行 fn 并缓存（fn 抛错不缓存） */
  wrap<T>(key: string | undefined, fn: () => T): T;
}

export interface LedgerService {
  append(entries: LedgerEntry[]): number;
  check(postId: string, traceId: string | undefined, estimateTokens: number): BudgetCheck;
  usageToday(scope: string): { tokens: number; cost: number };
}

export interface AssetService {
  put(req: import("@court/shared").PutAssetReq): Asset;
  canRead(asset: Asset, viewer: Address): boolean;
  /** 读内容（记录访问审计） */
  read(id: string, viewer: Address, version?: number): import("@court/shared").AssetContent;
  list(q: import("@court/shared").AssetListQuery): Asset[];
}

export interface ScheduleService {
  create(req: import("@court/shared").CreateScheduleReq): Schedule;
  /** 播种默认定时任务（幂等） */
  seedDefaults(): void;
  /** 调度器 tick：触发到期定时任务（投递 schedule 消息），返回本次触发记录 */
  tick(now: number): ScheduleRun[];
}

export interface DoorbellService {
  /** 提交后异步通知相关部门 runtime 拉取 */
  ring(posts: string[]): void;
  control(dept: string, path: string, body: unknown): Promise<void>;
  deptHealth(): Record<string, { ok: boolean; last_seen: number }>;
  markSeen(dept: string): void;
}

// ───────────────────────── B 组实现 ─────────────────────────
export interface WorkflowService {
  // 议事
  /** 皇帝发言：无 open 议事则开议；否则开启新场次。返回议事 */
  emperorSpeaks(content: string, deliberationId?: string): Deliberation;
  // 诏令
  issueEdict(input: { title: string; intent: string; deliberation_id?: string; skip_review?: boolean; budget_tokens?: number; deadline_minutes?: number; actor: Address }): Edict;
  getEdict(id: string): Edict | undefined;
  // 任务
  getTask(id: string): Task | undefined;
  openTaskCount(postId: string): number;
  // 服务
  getServiceRequest(id: string): ServiceRequest | undefined;
  /** 看门狗：租约过期改派、SLA 逐级上报 */
  watchdogTick(now: number): void;
}

export interface BriefingService {
  /** 某职位醒来简报：新消息 + 职事清单（按优先级、最多 K 条） */
  build(postId: string, after: number, wakeReason: string): Briefing;
  /** 某职位当前是否有待办职事（用于判断超时醒来是否需要调 LLM） */
  pendingItems(postId: string): PendingItem[];
}

export interface ExamService {
  start(modelKey: string, actor: Address): import("@court/shared").ExamSession;
  /** 后台考场循环（作答经网关），由 main 启动 */
  startRunner(): void;
  seedQuestions(): void;
}

export interface AuditService {
  /** 确定性稽查规则巡检（每 N 分钟），产出 findings 并唤醒御史 */
  runRules(now: number): AuditFinding[];
}

export interface HubCtx {
  db: Db;
  court: CourtConfig;
  modelsCfg: ModelsConfig;
  dataDir: string;
  gatewayUrl: string;
  gatewayToken: string;
  /** 网关管理接口 token（缺省退回 gatewayToken） */
  gatewayAdminToken?: string;
  controlToken: string;
  /** MCP 中转站（broker）地址；可变（测试/编排可改写） */
  mcpUrl: string;
  /** hub ↔ broker 共用密钥（只写入 DATA_DIR/hub/tokens.json） */
  mcpToken: string;
  now(): number;
  registry: RegistryService;
  events: EventService;
  messages: MessageService;
  notifications: NotificationService;
  approvals: ApprovalService;
  idem: IdempotencyService;
  ledger: LedgerService;
  assets: AssetService;
  schedules: ScheduleService;
  doorbell: DoorbellService;
  workflow: WorkflowService;
  briefing: BriefingService;
  exams: ExamService;
  audit: AuditService;
  mcp: import("./services/mcp.ts").McpService;
  /** 记录状态迁移（transitions 表 + 事件） */
  transition(subjectType: "edict" | "task" | "deliberation", subjectId: string, from: string, to: string, actor: Address, reason: string, traceId?: string): void;
  statuses(): OfficialStatus[];
}
