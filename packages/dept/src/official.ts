// 官员运行时：一个职位一个实例，持续运行（design §4.1）。实现 ToolContext 供工具使用。
//   等待（持久化等待条件）→ 唤醒（门铃/计时/人工/巡检）→ 简报 → pi Agent 一轮 → 持久化会话 → 推进 cursor → 设定下一次等待
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, streamProxy, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  getCurrentSystemMessage,
  isContextOverflow,
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type Model,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  ApiError,
  DeptClient,
  JsonlLog,
  LIMITS,
  MCP_TOOL_PREFIX,
  McpClient,
  dayStart,
  newId,
  objectSpanId,
  parseAddress,
  truncate,
  type Briefing,
  type CallServiceReq,
  type DeptDef,
  type GatewayClient,
  type HubClient,
  type InboxItem,
  type McpCatalog,
  type Message,
  type Official,
  type OfficialState,
  type OfficialStatus,
  type PostDef,
  type Registry,
  type SandboxClient,
  type SendMessageReq,
  type SendMessageRes,
  type ServiceRequest,
  type WaitFilter,
} from "@court/shared";
import type { ToolContext, TurnInfo } from "./tool-context.ts";
import { renderBriefing, renderSteer } from "./briefing-render.ts";
import {
  buildCompactedMessages,
  estimateContextTokens,
  fallbackSummary,
  generateSummary,
  splitForCompaction,
} from "./compaction.ts";
import type { DeptEvents, LiveBus } from "./events.ts";
import { buildMcpTools, keepToolsOfFailingServers } from "./mcp-tools.ts";
import { redactMcpSecretsInArgs } from "./tools/mcp.ts";
import { resolveModel } from "./model.ts";
import type { Semaphore } from "./semaphore.ts";
import { SUMMARY_PREFIX, SessionStore } from "./session.ts";
import { WaitStateStore, WakeSignal, defaultWaitState, describeWait, shouldWakeFor, type WaitState } from "./wake.ts";

export type ToolsFactory = (ctx: ToolContext) => AgentTool<any>[];

/** 官员运行时对部门运行时的依赖（便于测试注入） */
export interface OfficialDeps {
  dept: string;
  dataDir: string;
  /** 带部门 token 的 hub 客户端（官员内部再 withPost） */
  hub: HubClient;
  gateway: GatewayClient;
  gatewayUrl: string;
  deptToken: string;
  sandbox?: SandboxClient;
  /** MCP 中转站客户端（部门 token；官员内部再 withPost）。缺省 = 不装 MCP 工具 */
  mcp?: McpClient;
  /** 轮次边界（含启动）等 MCP 工具清单的上限，缺省 MCP_BOUNDARY_WAIT_MS；测试可调小 */
  mcpBoundaryWaitMs?: number;
  /** 测试用：替代 streamProxy 的 StreamFn（仍会收到 metadata） */
  streamFn?: StreamFn;
  buildTools: ToolsFactory;
  events: DeptEvents;
  live: LiveBus;
  llmSemaphore: Semaphore;
  registry(): Registry;
  deptUrl(dept: string): string;
  /** 本部门内唤醒（投递给同部门官员后直接按铃） */
  localWake(posts: string[], reason: string): void;
  /** 部门级暂停原因（罢朝/hub 不可达/停机），无则 undefined */
  globalPauseReason(): string | undefined;
  /** 网关报罢朝时通知部门运行时 */
  onHalted?(): void;
  /** 测试用：覆盖安全阀/时序参数 */
  limits?: Partial<Limits>;
}

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

export type LlmErrorKind = "budget" | "halted" | "sick" | "overflow" | "other";

/** 网关明确错误码（plan「运行时发现」第 2 条）：带码时以码为准 */
const GATEWAY_ERROR_CODE = /BUDGET_EXCEEDED|\bHALTED\b|CONTEXT_TOO_LONG|CIRCUIT_OPEN|RATE_LIMITED|UPSTREAM_ERROR|AUTH_ERROR|MODEL_NOT_FOUND/;

/** 网关/LLM 错误分类（errorMessage 可能带 "Proxy error: " 前缀）。明确错误码优先于启发式匹配。 */
export function classifyLlmError(msg: string | undefined): LlmErrorKind {
  const m = msg ?? "";
  if (/BUDGET_EXCEEDED/i.test(m)) return "budget";
  if (/\bHALTED\b|罢朝/.test(m)) return "halted";
  if (/CONTEXT_TOO_LONG/.test(m)) return "overflow";
  // 限流/熔断/上游暂时故障：原文可能含 "too many tokens" 之类，须先于溢出启发式判定
  if (/CIRCUIT_OPEN|RATE_LIMITED|UPSTREAM_ERROR/.test(m)) return "sick";
  if (/context[_ ]length|context window|maximum context|too many tokens|prompt is too long|上下文过长/i.test(m)) return "overflow";
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|Connection closed|network|Proxy error: (429|5\d\d)|\b50[0234]\b|unavailable|overloaded|无法连接/i.test(
      m,
    )
  )
    return "sick";
  return "other";
}

/** 一条出错的 assistant 消息归类：网关带码时以码为准；无码时才用 pi-ai 的上下文溢出识别 */
export function classifyAssistantError(m: AssistantMessage, contextWindow?: number): LlmErrorKind {
  if (!GATEWAY_ERROR_CODE.test(m.errorMessage ?? "") && isContextOverflow(m, contextWindow)) return "overflow";
  return classifyLlmError(m.errorMessage);
}

/** 可中止的等待；结束时移除 abort 监听（stopController.signal 长寿，否则每次去抖都会累积一个监听器） */
/**
 * 本轮的触发源：turn span 的父 span（首个触发职事——来信取其消息 span，任务/服务/议事取 hub 对象 span）
 * 与 attrs（task_id / edict_id / message_ids），供追踪图把轮次挂到正确的公文节点下。
 * 诏令起草/审核类职事不指向诏令根 span（会让轮次落到根节点），交给来信或 Web 的时间窗回退。
 */
export function turnOrigin(messages: Message[], briefing: Briefing, traceId: string): { parent_span_id?: string; attrs: Record<string, unknown> } {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const attrs: Record<string, unknown> = {};
  let parent: string | undefined;
  for (const it of briefing.items) {
    if (!attrs.task_id && (it.type === "task_assigned" || it.type === "task_verify")) attrs.task_id = it.task_id;
    if (!attrs.edict_id && "edict_id" in it && it.edict_id) attrs.edict_id = it.edict_id;
    if (parent) continue;
    if (it.type === "message") {
      const m = byId.get(it.message_id);
      if (m?.span_id && m.trace_id === traceId) parent = m.span_id;
    } else if (it.type === "task_assigned" || it.type === "task_verify") parent = objectSpanId(it.task_id);
    else if (it.type === "service_request") parent = objectSpanId(it.request_id);
    else if (it.type === "council_turn" || it.type === "council_chair") parent = objectSpanId(it.deliberation_id);
  }
  // 职事里没有可挂的：取本 trace 的首封来信
  parent ??= messages.find((m) => m.span_id && m.trace_id === traceId)?.span_id;
  for (const m of messages) {
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    if (!attrs.task_id && typeof meta.task_id === "string") attrs.task_id = meta.task_id;
    if (!attrs.edict_id && typeof meta.edict_id === "string") attrs.edict_id = meta.edict_id;
  }
  if (messages.length) attrs.message_ids = messages.slice(0, 20).map((m) => m.id);
  return { parent_span_id: parent, attrs };
}

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** 至多等 p ms 毫秒，返回是否按时了结（计时器总会清除，不拖住进程退出） */
async function settleWithin(p: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (!p) return true;
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((r) => {
        t = setTimeout(() => r(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

const BUDGET_RECHECK_MS = 10 * 60_000;
const SICK_BASE_MS = 60_000;
const SICK_MAX_MS = 30 * 60_000;
const HALT_RECHECK_MS = 30_000;
const LOG_TRUNCATE = 2000;
const STALL_GRACE_MS = 60_000;
/** MCP 工具清单：按时刷新间隔 / 失败（或有服务器出错）后重试间隔 / 拉清单超时 / 轮次边界至多等多久 */
const MCP_REFRESH_MS = 5 * 60_000;
const MCP_RETRY_MS = 60_000;
const MCP_CATALOG_TIMEOUT_MS = 30_000;
const MCP_BOUNDARY_WAIT_MS = 5_000;
/** 官员目录锁：同一官员同时只能由一个部门运行（跨部门调岗时旧部门收尾期间新部门不得接手） */
const LOCK_REFRESH_MS = 10_000;
const LOCK_STALE_MS = 45_000;

interface NextWait {
  kind: "sleep" | "wait" | "end";
  seconds: number;
  filter?: WaitFilter;
  reason: string;
}

interface Blocked {
  state: Extract<OfficialState, "suspended" | "sick" | "paused">;
  until: number;
  reason: string;
  /** 解除后以此原因开一轮 */
  wakeReason: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n");
  return JSON.stringify(content ?? "");
}

function short(v: unknown, max = LOG_TRUNCATE): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return truncate(s ?? "", max).text;
}

export class OfficialRuntime implements ToolContext {
  post: PostDef;
  official: Official;
  readonly workspace: string;
  readonly hub: HubClient;
  readonly sandbox?: SandboxClient;
  readonly mcp?: McpClient;

  private cfgSystemPrompt = "";
  private configVersion = -1;
  private configDirty = true;
  // MCP 动态工具（docs/mcp.md §4）：轮次边界（含启动）按需拉清单，清单版本变化才重建；只在边界改动 agent 的工具
  private mcpCatalogClient?: McpClient;
  private mcpTools: AgentTool<any>[] = [];
  /** 已装上的清单（出错服务器已并入其旧工具）；version 用来判断是否需要重建 */
  private mcpAppliedCatalog?: McpCatalog;
  private mcpDirty = true;
  /** 下次按时刷新的时刻（成功后 +5 分钟；失败或有服务器出错 +1 分钟） */
  private mcpNextRefreshAt = 0;
  /** 进行中的拉取：边界上等不完就留在后台，拉到的清单待下个边界装上 */
  private mcpCatalogFetch?: Promise<void>;
  private mcpFetchedCatalog?: McpCatalog;
  private agent?: Agent;
  private readonly L: Limits;
  private readonly dir: string;
  private readonly session: SessionStore;
  private readonly stateStore: WaitStateStore;
  private readonly logger: JsonlLog;
  private lastLogPruneAt = 0;
  private readonly memoryFile: string;
  private readonly lockFile: string;
  private lockTimer?: NodeJS.Timeout;
  private wait!: WaitState;

  private readonly signal = new WakeSignal();
  private readonly resumeSignal = new WakeSignal();
  private readonly stopController = new AbortController();
  private stopping = false;
  /** 停机时当前轮被强行中止：该轮不推进 cursor（与崩溃恢复同样处理，消息下次重现） */
  private stopAborted = false;
  private loopPromise?: Promise<void>;
  private turnPromise?: Promise<void>;

  private localPause?: string;
  private blocked?: Blocked;
  private sickAttempt = 0;
  private forcedWake?: string;
  private seenSeq = 0;
  private pendingHubAck?: number;
  private compactionRequest?: { summary?: string; reason: string };

  // 当前轮
  private current?: TurnInfo & { started_at: number; ack_seq: number; backlog: boolean };
  private nextWait?: NextWait;
  private toolCallCount = 0;
  private callIdx = 0;
  private toolNames: string[] = [];
  private toolSpanStarts = new Map<string, { span_id: string; at: number }>();
  private turnAssistants: AssistantMessage[] = [];
  private steeredIds = new Set<string>();
  /** 本轮已排入 steer 队列、尚未被 Agent 取用的皇帝来信 */
  private pendingSteers = new Map<AgentMessage, { id: string; seq: number }>();
  /** 本轮已实际注入上下文的皇帝来信 */
  private consumedSteers: { id: string; seq: number }[] = [];
  /** 已在前几轮注入处理、但 cursor 尚未越过的来信（id → seq）：下轮简报不再呈上，也不据此唤醒 */
  private carriedSteers = new Map<string, number>();
  private turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

  // 状态
  private state: OfficialState = "idle";
  private statusText?: string;
  private lastProgressAt = Date.now();
  private lastTurnEndAt = 0;
  private turnStarts: number[] = [];
  /** 无实效轮次（只调用了只读/结束类工具）的开始时间 */
  private idleTurnStarts: number[] = [];
  private tokensToday = 0;
  private tokensDay = dayStart();
  private ctxTokens = 0;
  private cappedNotified = false;

  constructor(
    post: PostDef,
    official: Official,
    private readonly deps: OfficialDeps,
  ) {
    this.L = { ...LIMITS, ...deps.limits };
    this.post = post;
    this.official = official;
    this.workspace = deps.dept;
    this.hub = deps.hub.withPost(post.post_id);
    this.sandbox = deps.sandbox;
    if (deps.mcp) {
      this.mcp = deps.mcp.withPost(post.post_id);
      // 列清单另用短超时：broker 单服务器列工具 20s 封顶，不能让它拖住轮次边界
      this.mcpCatalogClient = new McpClient({ ...this.mcp.opts, timeoutMs: MCP_CATALOG_TIMEOUT_MS });
    }
    this.dir = join(deps.dataDir, "officials", official.official_id);
    mkdirSync(this.dir, { recursive: true });
    this.session = new SessionStore(join(this.dir, "session.jsonl"));
    this.stateStore = new WaitStateStore(join(this.dir, "state.json"));
    this.logger = new JsonlLog(join(this.dir, "logs"));
    this.memoryFile = join(this.dir, "memory.md");
    this.lockFile = join(this.dir, "runtime.lock");
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  get postId(): string {
    return this.post.post_id;
  }

  get officialId(): string {
    return this.official.official_id;
  }

  get inTurn(): boolean {
    return !!this.current;
  }

  async start(): Promise<void> {
    this.acquireLock();
    try {
      await this.startInner();
    } catch (e) {
      this.releaseLock();
      throw e;
    }
  }

  private async startInner(): Promise<void> {
    await this.refreshConfig();
    // 先试拉 MCP 清单（限时、失败不碍事）：重建的 agent 一开始就带着已有的 MCP 工具，免得首轮才宣告「新增」
    await this.refreshMcp();
    const local = this.stateStore.load();
    let hubAcked = 0;
    try {
      hubAcked = (await this.hub.inboxCursor(this.postId)).acked_seq;
    } catch {
      /* hub 暂不可达：以本地为准 */
    }
    if (local && local.post_id === this.postId) {
      this.wait = { ...local, acked_seq: Math.max(local.acked_seq, hubAcked) };
    } else {
      // 首次就任或调岗：游标按新职位
      this.wait = defaultWaitState(this.post, hubAcked);
    }
    this.seenSeq = this.wait.acked_seq;
    // 上次确认 hub 失败（或 hub 游标落后于本地）：启动后补报，免得接任者重复处理
    if (this.wait.acked_seq > hubAcked) this.pendingHubAck = this.wait.acked_seq;
    this.saveWait();
    const loaded = this.session.load();
    if (loaded.abortedTurnId || loaded.synthesizedResults) {
      this.log("error", { error: "崩溃恢复", aborted_turn_id: loaded.abortedTurnId, synthesized_results: loaded.synthesizedResults });
    }
    this.buildAgent(loaded.messages);
    this.ctxTokens = estimateContextTokens(this.agent!.state.messages);
    this.updateStateFromWait();
    this.log("wake", { reason: "startup", acked_seq: this.wait.acked_seq });
    this.signal.kick("startup");
    this.loopPromise = this.loop();
  }

  /** 停止：不开新轮；当前轮 drainMs 内结束，否则中止 */
  async stop(drainMs = 30_000): Promise<void> {
    if (this.stopping) return this.loopPromise;
    this.stopping = true;
    this.stopController.abort();
    this.signal.kick("stop");
    this.resumeSignal.kick("stop");
    let finished = await settleWithin(this.turnPromise, drainMs);
    if (!finished) {
      this.log("error", { error: "停机：当前轮超时被中止" });
      this.stopAborted = true;
      this.agent?.abort();
      finished = await settleWithin(this.turnPromise, 5_000);
    }
    if (finished) await settleWithin(this.loopPromise, 5_000);
    if (this.pendingHubAck !== undefined) await settleWithin(this.flushHubAck(), 3_000);
    if (this.wait) this.saveWait();
    this.state = "offline";
    this.publishState();
    // 轮仍未了结（工具不理会中止）：不删锁，让它自然过期，免得新部门与残留的轮同写会话
    this.releaseLock(finished);
  }

  private readLock(): { dept?: string; post_id?: string; at?: number } | undefined {
    try {
      return JSON.parse(readFileSync(this.lockFile, "utf8"));
    } catch {
      return undefined; // 无锁或损坏：可接管
    }
  }

  private writeLock(): void {
    try {
      const tmp = this.lockFile + ".tmp";
      writeFileSync(tmp, JSON.stringify({ dept: this.deps.dept, post_id: this.postId, pid: process.pid, at: Date.now() }));
      renameSync(tmp, this.lockFile);
    } catch {
      /* 写锁失败不影响运行 */
    }
  }

  /** 同一官员目录只允许一个部门运行；他部门的锁未过期则拒绝启动（部门运行时稍后重试） */
  private acquireLock(): void {
    const cur = this.readLock();
    if (cur?.dept && cur.dept !== this.deps.dept && Date.now() - Number(cur.at ?? 0) < LOCK_STALE_MS) {
      throw new Error(`官员 ${this.officialId} 仍在 ${cur.dept}（${cur.post_id ?? "?"}）收尾，稍后再接任`);
    }
    this.writeLock();
    this.lockTimer = setInterval(() => this.writeLock(), LOCK_REFRESH_MS);
    this.lockTimer.unref?.();
  }

  private releaseLock(remove = true): void {
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = undefined;
    if (!remove || this.readLock()?.dept !== this.deps.dept) return;
    try {
      rmSync(this.lockFile, { force: true });
    } catch {
      /* 忽略 */
    }
  }

  /** 新来信/门铃/巡检/本地唤醒 */
  kick(reason: string): void {
    if (this.current) void this.checkSteer();
    this.signal.kick(reason);
  }

  /** 人工唤醒：无视等待条件，立即开一轮 */
  wakeManual(reason: string): void {
    this.forcedWake = `manual:${reason || "人工唤醒"}`;
    // 抱恙立即重试；停俸立即复查预算（陛下增拨后宣召即可复职，仍超额则继续停俸）
    if (this.blocked?.state === "sick" || this.blocked?.state === "suspended") this.blocked.until = Date.now();
    this.signal.kick("manual");
    this.resumeSignal.kick("manual");
  }

  /** 预算有变：停俸者立即复查（仍超额则继续停俸） */
  recheckBudget(): void {
    if (this.blocked?.state !== "suspended") return;
    this.blocked.until = Date.now();
    this.resumeSignal.kick("budget");
  }

  pause(reason: string): void {
    this.localPause = reason;
    this.publishState();
  }

  resume(): void {
    this.localPause = undefined;
    if (this.blocked?.state === "paused") this.blocked.until = Date.now();
    this.resumeSignal.kick("resume");
    this.signal.kick("resync");
  }

  /** 部门运行时恢复（hub 重新可达/罢朝解除）时调用 */
  notifyGlobalResume(): void {
    if (this.blocked?.state === "paused") this.blocked.until = Date.now();
    this.resumeSignal.kick("resume");
    this.signal.kick("resync");
  }

  markConfigDirty(): void {
    this.configDirty = true;
  }

  /** 控制面 /control/mcp：MCP 配置/授权有变，下个轮次边界重新拉取工具清单 */
  markMcpDirty(): void {
    this.mcpDirty = true;
  }

  /** 当前装上的 MCP 工具名（调试/测试用） */
  mcpToolNames(): string[] {
    return this.mcpTools.map((t) => t.name);
  }

  /** 控制面/工具：请求压缩（轮间执行） */
  requestCompaction(summary?: string): void {
    this.compactionRequest = { summary, reason: summary ? "self" : "requested" };
    if (!this.current) this.signal.kick("compact");
  }

  /** 循环卡死：在一轮中超过 maxTurnMs + 宽限 */
  isStalled(now = Date.now()): boolean {
    return !!this.current && now - this.current.started_at > this.L.maxTurnMs + STALL_GRACE_MS;
  }

  contextView(): { system_prompt: string; messages: unknown[]; context_tokens: number } {
    const msgs = this.agent?.state.messages ?? [];
    return { system_prompt: this.agent?.state.systemPrompt ?? this.cfgSystemPrompt, messages: msgs, context_tokens: this.ctxTokens };
  }

  readLog(date?: string, tail?: number): Record<string, unknown>[] {
    return this.logger.read(date, tail);
  }

  // ───────────────────────── 配置与 Agent ─────────────────────────

  private async refreshConfig(): Promise<void> {
    const cfg = await this.hub.officialConfig(this.postId);
    this.post = cfg.post;
    this.official = cfg.official;
    const changed = cfg.system_prompt !== this.cfgSystemPrompt || cfg.official.config_version !== this.configVersion;
    this.cfgSystemPrompt = cfg.system_prompt;
    this.configVersion = cfg.official.config_version;
    this.configDirty = false;
    if (this.agent && changed) {
      this.applyConfigToAgent();
      this.log("config_reload", { config_version: this.configVersion, model: this.official.model, thinking: this.official.thinking });
    }
  }

  /**
   * 轮次边界（含启动）：mcpDirty 或到点 → 拉清单，至多等 mcpBoundaryWaitMs；等不完的拉取留在后台，下个边界再装。
   * 失败保持现有 MCP 工具、稍后再试；任何情况都不抛出、不拖住本轮太久。
   */
  private async refreshMcp(): Promise<void> {
    if (!this.mcpCatalogClient) return;
    if (!this.mcpCatalogFetch && (this.mcpDirty || Date.now() >= this.mcpNextRefreshAt)) this.mcpCatalogFetch = this.fetchMcpCatalog();
    if (this.mcpCatalogFetch) await settleWithin(this.mcpCatalogFetch, this.deps.mcpBoundaryWaitMs ?? MCP_BOUNDARY_WAIT_MS);
    const fetched = this.mcpFetchedCatalog;
    if (!fetched) return;
    this.mcpFetchedCatalog = undefined;
    this.applyMcpCatalog(fetched);
  }

  /** 拉一次清单，结果暂存（不碰 agent）。拉取期间再来的 markMcpDirty 会让下个边界重拉 */
  private async fetchMcpCatalog(): Promise<void> {
    this.mcpDirty = false;
    try {
      const catalog = await this.mcpCatalogClient!.catalog();
      const anyServerFailing = (catalog.servers ?? []).some((s) => s.error);
      this.mcpFetchedCatalog = catalog;
      this.mcpNextRefreshAt = Date.now() + (anyServerFailing ? MCP_RETRY_MS : MCP_REFRESH_MS);
    } catch (e) {
      this.mcpNextRefreshAt = Date.now() + MCP_RETRY_MS;
      this.log("mcp_refresh_failed", { error: short((e as Error)?.message ?? String(e), 500), kept: this.mcpTools.length });
    } finally {
      this.mcpCatalogFetch = undefined;
    }
  }

  /** 版本变化才重建 MCP 工具；出错的服务器沿用其旧工具（与 broker 不可达时一致，免得工具忽增忽减） */
  private applyMcpCatalog(fetched: McpCatalog): void {
    if (fetched.version === this.mcpAppliedCatalog?.version) return;
    const catalog = keepToolsOfFailingServers(fetched, this.mcpAppliedCatalog);
    try {
      this.mcpTools = buildMcpTools(catalog, this.mcp!, this);
    } catch (e) {
      this.log("mcp_refresh_failed", { error: short((e as Error)?.message ?? String(e), 500), kept: this.mcpTools.length });
      return;
    }
    this.mcpAppliedCatalog = catalog;
    const errors = (catalog.servers ?? []).filter((s) => s.error).map((s) => ({ server: s.id, error: short(s.error, 300) }));
    this.log("mcp_tools", { version: catalog.version, count: this.mcpTools.length, servers: (catalog.servers ?? []).map((s) => s.id), errors: errors.length ? errors : undefined });
    // pi 在下一次请求前自动以 system 消息宣告工具增删
    if (this.agent) this.agent.state.tools = this.allTools();
  }

  /** 基础工具（按工具组）+ 当前 MCP 工具（同名以基础工具为准） */
  private allTools(): AgentTool<any>[] {
    const base = this.deps.buildTools(this);
    if (!this.mcpTools.length) return base;
    const names = new Set(base.map((t) => t.name));
    return [...base, ...this.mcpTools.filter((t) => !names.has(t.name))];
  }

  private currentModel(): Model<Api> {
    const entry = this.deps.registry().models.find((m) => m.key === this.official.model);
    return resolveModel(this.official.model, entry);
  }

  private systemMessage(tools: AgentTool<any>[]): SystemMessage | undefined {
    return createInitialSystemMessage(this.cfgSystemPrompt, tools.map((t) => toToolDeclaration(t)));
  }

  private buildAgent(history: AgentMessage[]): void {
    const tools = this.allTools();
    const sys = this.systemMessage(tools);
    const messages = [...(sys ? [sys] : []), ...history.filter((m) => m.role !== "system")];
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.cfgSystemPrompt,
        model: this.currentModel(),
        thinkingLevel: this.official.thinking,
        tools,
        messages,
      },
      streamFn: this.streamFn,
      sessionId: this.sessionId,
      toolExecution: "sequential",
      beforeToolCall: async () => this.beforeToolCall(),
    });
    this.agent.subscribe((e) => this.onAgentEvent(e));
  }

  /** 配置变更：换模型/思考强度/工具，重建开头的系统消息（系统提示只读，由会话中的系统消息重放） */
  private applyConfigToAgent(): void {
    const agent = this.agent!;
    const tools = this.allTools();
    agent.state.model = this.currentModel();
    agent.state.thinkingLevel = this.official.thinking;
    agent.state.tools = tools;
    const sys = this.systemMessage(tools);
    agent.state.messages = [...(sys ? [sys] : []), ...agent.state.messages.filter((m) => m.role !== "system")];
  }

  get sessionId(): string {
    return `ses_${this.officialId}`;
  }

  private streamFn: StreamFn = async (model, context, options) => {
    const release = await this.deps.llmSemaphore.acquire();
    const turn = this.current;
    const metadata = {
      post_id: this.postId,
      official_id: this.officialId,
      dept: this.deps.dept,
      trace_id: turn?.trace_id,
      turn_id: turn?.turn_id,
      call_idx: this.callIdx++,
      purpose: "turn" as const,
    };
    try {
      const stream = this.deps.streamFn
        ? await this.deps.streamFn(model, context, { ...options, sessionId: this.sessionId, metadata })
        : streamProxy(model, context, {
            ...options,
            proxyUrl: this.deps.gatewayUrl,
            authToken: this.deps.deptToken,
            sessionId: this.sessionId,
            metadata,
          });
      stream.result().then(release, release);
      return stream;
    } catch (e) {
      release();
      throw e;
    }
  };

  private async beforeToolCall(): Promise<{ block: boolean; reason: string; terminate: boolean } | undefined> {
    this.toolCallCount++;
    if (this.toolCallCount > this.L.maxToolCallsPerTurn) {
      if (this.toolCallCount > this.L.maxToolCallsPerTurn + 3) {
        this.log("error", { error: `本轮工具调用超过上限 ${this.L.maxToolCallsPerTurn}，中止本轮` });
        this.agent?.abort();
      }
      return {
        block: true,
        reason: `本轮工具调用已达上限（${this.L.maxToolCallsPerTurn} 次），已拒绝执行。请立即用 end_turn / wait_for / sleep 结束本轮。`,
        terminate: true,
      };
    }
    return undefined;
  }

  // ───────────────────────── 主循环 ─────────────────────────

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        await this.step();
        failures = 0;
      } catch (e) {
        failures++;
        this.log("error", { error: `主循环异常：${(e as Error).message}` });
        // 唤醒原因已取走：回退「已检视」游标，稍后重新评估收件
        this.seenSeq = this.wait.acked_seq;
        await delayMs(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), this.stopController.signal);
        this.signal.kick("resync");
      }
    }
  }

  private pauseReason(): string | undefined {
    return this.localPause ?? this.deps.globalPauseReason();
  }

  private async step(): Promise<void> {
    // 暂停（罢朝/hub 不可达/控制面）：不开新轮
    const paused = this.pauseReason();
    if (paused) {
      this.setState("paused", paused);
      await this.resumeSignal.wait(Date.now() + 5_000);
      this.resumeSignal.drain();
      return;
    }
    if (this.pendingHubAck !== undefined) await this.flushHubAck();
    if (this.configDirty) await this.refreshConfig();
    await this.refreshMcp();
    if (this.compactionRequest) {
      await this.runCompaction({ summary: this.compactionRequest.summary, reason: this.compactionRequest.reason });
      this.compactionRequest = undefined;
    }

    // 停俸/抱恙/网关罢朝：到点再试
    if (this.blocked) {
      const b = this.blocked;
      if (Date.now() < b.until) {
        this.setState(b.state, b.reason);
        await this.resumeSignal.wait(b.until);
        this.resumeSignal.drain();
        return;
      }
      if (b.state === "suspended") {
        const check = await this.hub.budgetCheck({ post_id: this.postId, estimate_tokens: 2000 }).catch(() => undefined);
        if (!check?.allowed) {
          b.until = Date.now() + BUDGET_RECHECK_MS;
          b.reason = `停俸：${check?.reason ?? "预算仍超额"}`;
          return;
        }
      }
      this.blocked = undefined;
      this.forcedWake = this.forcedWake ?? b.wakeReason;
    }

    let wakeReason = this.forcedWake;
    let prefetched: Briefing | undefined;
    if (!wakeReason) {
      this.updateStateFromWait();
      await this.signal.wait(this.wait.next_wake_at);
      if (this.stopping) return;
      let reasons: string[] = [];
      if (this.signal.pending) {
        await delayMs(this.L.wakeDebounceMs, this.stopController.signal);
        reasons = this.signal.drain();
      }
      if (this.stopping) return;
      if (this.forcedWake) {
        wakeReason = this.forcedWake;
      } else if (reasons.some((r) => r !== "compact")) {
        const hit = await this.evaluateInbox();
        if (hit) wakeReason = hit;
      }
      if (!wakeReason) {
        if (Date.now() < this.wait.next_wake_at) return; // 继续等
        if (!this.wait.agent_set) {
          // 默认等待超时：无事则代码级续睡，不调 LLM
          prefetched = await this.hub.briefing(this.postId, this.wait.acked_seq, "timeout");
          if (prefetched.items.length === 0) {
            this.extendIdle();
            return;
          }
          wakeReason = "timeout";
        } else {
          wakeReason = this.wait.mode === "sleep" ? "sleep_end" : "wait_timeout";
        }
      }
    }
    this.forcedWake = undefined;
    if (this.stopping || this.pauseReason()) {
      this.forcedWake = wakeReason; // 恢复后再办
      return;
    }

    // 安全阀：两轮最小间隔、每小时轮次上限
    const gap = this.lastTurnEndAt + this.L.minTurnGapMs - Date.now();
    if (gap > 0) await delayMs(gap, this.stopController.signal);
    const now = Date.now();
    this.turnStarts = this.turnStarts.filter((t) => t > now - 3600_000);
    this.idleTurnStarts = this.idleTurnStarts.filter((t) => t > now - 3600_000);
    // 分级上限：无实效轮次（空转）≤ maxTurnsPerHour；全部轮次 ≤ maxTurnsPerHourHard（防失控）。
    // 有实效的公务（推动公文、发信、产出）不受空转上限约束，避免繁忙职位（如右仆射）被误伤。
    const idleCapped = this.idleTurnStarts.length >= this.L.maxTurnsPerHour;
    const hardCapped = this.turnStarts.length >= (this.L.maxTurnsPerHourHard ?? this.L.maxTurnsPerHour * 4);
    if (idleCapped || hardCapped) {
      const until = (hardCapped ? this.turnStarts[0] : this.idleTurnStarts[0]) + 3600_000;
      const what = hardCapped ? `总轮次已达硬上限 ${this.L.maxTurnsPerHourHard}` : `空转轮次已达上限 ${this.L.maxTurnsPerHour}`;
      if (!this.cappedNotified) {
        this.cappedNotified = true;
        this.log("sleep", { reason: "turn_capped", until, idle_turns: this.idleTurnStarts.length, turns: this.turnStarts.length });
        this.deps.events.emit({
          type: "turn.capped",
          actor: `post:${this.postId}`,
          summary: `${this.post.title}本小时${what}，强制休息至 ${new Date(until).toISOString()}`,
          data: { until, turns_last_hour: this.turnStarts.length, idle_turns_last_hour: this.idleTurnStarts.length, hard: hardCapped },
        });
      }
      // 报 suspended：hub 派活时避开（pickPost 跳过不健康者），已派之事由看门狗按租约改派
      this.setState("suspended", `本小时${what}，暂歇`);
      this.forcedWake = wakeReason;
      await this.resumeSignal.wait(until);
      this.resumeSignal.drain();
      return;
    }
    this.cappedNotified = false;
    if (this.stopping) return;

    const p = this.runTurn(wakeReason, prefetched);
    this.turnPromise = p;
    try {
      await p;
    } catch (e) {
      // 轮未能完成（多为开轮时拉简报失败）：保留唤醒原因待重试（否则人工唤醒/抱恙重试等会丢），清掉残留的当前轮
      this.forcedWake = this.forcedWake ?? wakeReason;
      this.current = undefined;
      throw e;
    } finally {
      this.turnPromise = undefined;
    }
  }

  /** 拉取新收件，判断是否满足等待条件。返回唤醒原因或 undefined */
  private async evaluateInbox(): Promise<string | undefined> {
    const after = Math.max(this.wait.acked_seq, this.seenSeq);
    const res = await this.hub.inbox(this.postId, after, 100);
    const items = res.items.filter((i) => i.delivery.seq > after).sort((a, b) => a.delivery.seq - b.delivery.seq);
    let hit: InboxItem | undefined;
    for (const it of items) {
      if (this.carriedSteers.has(it.message.id)) continue; // 已在轮中注入处理过
      if (shouldWakeFor(this.wait, this.post, it)) {
        hit = it;
        break;
      }
    }
    if (items.length) this.seenSeq = Math.max(this.seenSeq, items[items.length - 1].delivery.seq);
    if (!hit) return undefined;
    const m = hit.message;
    this.log("wake", { reason: "message", message_id: m.id, from: m.from, kind: m.kind, seq: hit.delivery.seq });
    return m.from === "emperor" || this.wait.mode === "sleep" ? `interrupt:${m.from}` : `message:${m.from}`;
  }

  private extendIdle(): void {
    const w = this.wait;
    w.idle_backoff = Math.min(w.idle_backoff * 2, Math.max(1, this.L.idleBackoffMaxSeconds / Math.max(1, this.post.default_wait_seconds)));
    const seconds = Math.min(this.post.default_wait_seconds * w.idle_backoff, this.L.idleBackoffMaxSeconds);
    w.next_wake_at = Date.now() + seconds * 1000;
    this.saveWait();
    this.log("wait", { reason: "idle_timeout_no_work", seconds, idle_backoff: w.idle_backoff });
    this.updateStateFromWait();
  }

  // ───────────────────────── 一轮 ─────────────────────────

  private async runTurn(wakeReason: string, prefetched?: Briefing): Promise<void> {
    // 配置变更在轮边界生效
    if (this.configDirty) await this.refreshConfig();
    await this.refreshMcp();
    const acked = this.wait.acked_seq;
    for (const [id, seq] of this.carriedSteers) if (seq <= acked) this.carriedSteers.delete(id);
    const carried = this.carriedSteers;
    const briefing0 = prefetched ?? (await this.hub.briefing(this.postId, acked, wakeReason));
    const inbox = await this.hub.inbox(this.postId, acked, 100);
    if (this.stopping) {
      this.forcedWake = wakeReason; // 停机期间不再开新轮
      return;
    }
    // 前几轮已注入处理过的皇帝来信：不再呈上（cursor 越过后自然确认）
    const briefing: Briefing = carried.size
      ? { ...briefing0, items: briefing0.items.filter((it) => !(it.type === "message" && carried.has(it.message_id))) }
      : briefing0;
    const fresh = inbox.items
      .filter((i) => i.delivery.seq > acked && !carried.has(i.message.id))
      .sort((a, b) => a.delivery.seq - b.delivery.seq);
    const rendered = fresh.slice(0, this.L.briefingMaxItems);
    const truncatedInbox = fresh.length > rendered.length || inbox.items.length >= 100;
    const lastRendered = rendered.length ? rendered[rendered.length - 1].delivery.seq : acked;
    const ackSeq = truncatedInbox ? lastRendered : Math.max(acked, lastRendered, Math.min(briefing.latest_seq, inbox.latest_seq));

    const turnId = newId("tn");
    const spanId = newId("sp");
    const traceId = this.pickTrace(rendered.map((r) => r.message), briefing);
    const origin = turnOrigin(rendered.map((r) => r.message), briefing, traceId);
    const startedAt = Date.now();
    this.current = { turn_id: turnId, trace_id: traceId, span_id: spanId, wake_reason: wakeReason, started_at: startedAt, ack_seq: ackSeq, backlog: truncatedInbox };
    this.nextWait = undefined;
    this.toolCallCount = 0;
    this.callIdx = 0;
    this.toolNames = [];
    this.toolSpanStarts.clear();
    this.turnAssistants = [];
    this.steeredIds.clear();
    this.pendingSteers.clear();
    this.consumedSteers = [];
    this.turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
    this.turnStarts.push(startedAt);
    this.lastProgressAt = startedAt;

    this.session.appendTurn(turnId, "running", { trace_id: traceId, ack_seq: ackSeq });
    this.log("turn_start", { wake_reason: wakeReason, items: briefing.items.length, new_messages: rendered.length, ack_seq: ackSeq });
    const turnSpanName = `${this.post.title}·${this.official.name} 一轮`;
    this.deps.events.emit({
      type: "turn.start",
      actor: `post:${this.postId}`,
      trace_id: traceId,
      span_id: spanId,
      summary: `${this.post.title}${this.official.name}醒来办事（${wakeReason}）`,
      data: { turn_id: turnId, wake_reason: wakeReason, items: briefing.items.length, new_messages: rendered.length },
      span: {
        span_id: spanId,
        trace_id: traceId,
        parent_span_id: origin.parent_span_id,
        kind: "turn",
        name: turnSpanName,
        actor: `post:${this.postId}`,
        status: "running",
        started_at: startedAt,
        attrs: { turn_id: turnId, wake_reason: wakeReason, ...origin.attrs },
      },
    });
    this.setState("thinking");

    const text = renderBriefing({
      wakeReason,
      now: startedAt,
      briefing,
      newMessages: rendered.map((r) => r.message),
      moreMessages: Math.max(0, fresh.length - rendered.length),
      memory: truncate(this.memoryRead(), this.L.memoryNoteMaxBytes).text,
    });

    const agent = this.agent!;
    let abortedReason: string | undefined;
    const timer = setTimeout(() => {
      abortedReason = `本轮超过 ${Math.round(this.L.maxTurnMs / 60_000)} 分钟上限`;
      this.log("error", { error: abortedReason });
      agent.abort();
    }, this.L.maxTurnMs);
    let overflowRetried = false;
    let errorKind: LlmErrorKind | undefined;
    let errorMessage: string | undefined;
    try {
      await agent.prompt({ role: "user", content: text, timestamp: startedAt });
      for (;;) {
        const last = this.turnAssistants[this.turnAssistants.length - 1];
        if (!last || last.stopReason !== "error") break;
        const kind = classifyAssistantError(last, agent.state.model.contextWindow);
        if (kind === "overflow" && !overflowRetried && !abortedReason) {
          overflowRetried = true;
          this.log("error", { error: "上下文过长，强制压缩后重试", detail: last.errorMessage });
          const msgs = agent.state.messages;
          if (msgs[msgs.length - 1] === last) agent.state.messages = msgs.slice(0, -1);
          await this.runCompaction({ reason: "overflow", mustKeepLastUser: true });
          const tail = agent.state.messages[agent.state.messages.length - 1];
          // 压缩期间本轮可能已超时：不再续跑（否则 continue 不受轮时限约束）
          if (!abortedReason && tail && (tail.role === "user" || tail.role === "toolResult")) {
            await agent.continue();
            continue;
          }
        }
        errorKind = kind;
        errorMessage = last.errorMessage;
        break;
      }
    } catch (e) {
      errorKind = "other";
      errorMessage = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    if (this.stopAborted) abortedReason = abortedReason ?? "停机中止";
    // 轮结束后仍在队列中的 steer 未被处理：清掉，下次简报再现
    if (agent.hasQueuedMessages()) agent.clearAllQueues();
    this.pendingSteers.clear();
    // 已注入的皇帝来信：与已确认段相连的随本轮确认；不相连的记下，免得下轮重复呈上、重复处理
    const cur = this.current!;
    for (const st of [...this.consumedSteers].sort((a, b) => a.seq - b.seq)) {
      if (st.seq === cur.ack_seq + 1) cur.ack_seq = st.seq;
      else if (st.seq > cur.ack_seq) this.carriedSteers.set(st.id, st.seq);
    }
    await this.finishTurn({ errorKind, errorMessage, abortedReason });
  }

  private pickTrace(messages: Message[], briefing: Briefing): string {
    for (const m of messages) if (m.trace_id) return m.trace_id;
    for (const it of briefing.items) {
      if ("trace_id" in it && it.trace_id) return it.trace_id;
      if ("edict_id" in it && it.edict_id) return it.edict_id;
    }
    return newId("tr");
  }

  private async finishTurn(r: { errorKind?: LlmErrorKind; errorMessage?: string; abortedReason?: string }): Promise<void> {
    const cur = this.current!;
    const processed = this.turnAssistants.some((a) => a.stopReason !== "error" && a.stopReason !== "aborted");
    const now = Date.now();

    if (r.errorKind) this.handleLlmError(r.errorKind, r.errorMessage ?? "");
    else if (processed) this.sickAttempt = 0; // 恢复正常：下次抱恙从 1 分钟重新退避

    // 下一次等待
    const nw = this.nextWait;
    if (nw?.kind === "sleep") {
      this.wait = { ...this.wait, mode: "sleep", agent_set: true, wait_filter: undefined, next_wake_at: now + nw.seconds * 1000, idle_backoff: 1, reason: nw.reason };
      this.log("sleep", { seconds: nw.seconds, reason: nw.reason });
      this.deps.events.emit({
        type: "sleep",
        actor: `post:${this.postId}`,
        trace_id: cur.trace_id,
        parent_span_id: cur.span_id,
        summary: `${this.post.title}${this.official.name}就寝 ${nw.seconds} 秒：${short(nw.reason, 200)}`,
        data: { seconds: nw.seconds, until: this.wait.next_wake_at, reason: nw.reason },
      });
    } else if (nw?.kind === "wait") {
      this.wait = { ...this.wait, mode: "wait", agent_set: true, wait_filter: nw.filter, next_wake_at: now + nw.seconds * 1000, idle_backoff: 1, reason: nw.reason };
      this.log("wait", { seconds: nw.seconds, filter: nw.filter, reason: nw.reason });
      this.deps.events.emit({
        type: "wait",
        actor: `post:${this.postId}`,
        trace_id: cur.trace_id,
        parent_span_id: cur.span_id,
        summary: `${this.post.title}${this.official.name}等候 ${JSON.stringify(nw.filter)}（最长 ${nw.seconds} 秒）`,
        data: { seconds: nw.seconds, until: this.wait.next_wake_at, filter: nw.filter },
      });
    } else {
      this.wait = { ...defaultWaitState(this.post, this.wait.acked_seq, now), reason: nw?.reason };
      this.log("wait", { seconds: this.post.default_wait_seconds, default: true, note: nw?.reason });
    }

    // 先持久化会话（轮记录），再推进 cursor（design P0-2）。停机强行中止的轮按崩溃处理，不推进。
    const status = processed && !r.abortedReason ? "done" : "aborted";
    const ackable = processed && !this.stopAborted;
    this.session.appendTurn(cur.turn_id, status, { trace_id: cur.trace_id, ack_seq: ackable ? cur.ack_seq : undefined, note: r.abortedReason ?? r.errorMessage });
    if (ackable && cur.ack_seq > this.wait.acked_seq) {
      this.wait.acked_seq = cur.ack_seq;
      this.saveWait();
      this.pendingHubAck = cur.ack_seq;
      await this.flushHubAck();
    } else {
      this.saveWait();
    }
    if (ackable) {
      // 「已检视」游标回到已确认处：本轮没呈上的积压（简报截断）须按新的等待条件重新评估，否则要等到超时才醒
      this.seenSeq = this.wait.acked_seq;
      for (const [id, seq] of this.carriedSteers) if (seq <= this.wait.acked_seq) this.carriedSteers.delete(id);
      if (cur.backlog) this.signal.kick("backlog");
    }

    if (!isProductiveTurn(this.toolNames)) this.idleTurnStarts.push(cur.started_at);
    const durationMs = now - cur.started_at;
    this.log("turn_end", {
      status,
      duration_ms: durationMs,
      tool_calls: this.toolCallCount,
      tools: this.toolNames,
      usage: this.turnUsage,
      error: r.errorMessage,
      aborted: r.abortedReason,
    });
    this.deps.events.emit({
      type: "turn.end",
      actor: `post:${this.postId}`,
      trace_id: cur.trace_id,
      span_id: cur.span_id,
      summary: `${this.post.title}${this.official.name}办毕一轮：工具 ${this.toolCallCount} 次，${durationMs}ms${r.errorMessage ? `，出错：${short(r.errorMessage, 200)}` : ""}`,
      data: { turn_id: cur.turn_id, tool_calls: this.toolCallCount, tools: this.toolNames, usage: this.turnUsage, duration_ms: durationMs, status, error: r.errorMessage },
      span: {
        span_id: cur.span_id,
        trace_id: cur.trace_id,
        kind: "turn",
        name: `${this.post.title}·${this.official.name} 一轮`,
        actor: `post:${this.postId}`,
        status: status === "done" && !r.errorKind ? "ok" : "error",
        started_at: cur.started_at,
        ended_at: now,
        attrs: { turn_id: cur.turn_id, tool_calls: this.toolCallCount, total_tokens: this.turnUsage.totalTokens },
      },
    });

    this.current = undefined;
    this.lastTurnEndAt = Date.now();
    this.lastProgressAt = this.lastTurnEndAt;
    this.ctxTokens = estimateContextTokens(this.agent!.state.messages);
    this.updateStateFromWait();

    // 自动压缩
    const window = this.agent!.state.model.contextWindow || this.L.defaultContextWindow;
    if (this.compactionRequest) {
      await this.runCompaction({ summary: this.compactionRequest.summary, reason: this.compactionRequest.reason });
      this.compactionRequest = undefined;
    } else if (this.ctxTokens > this.L.compactAtRatio * window) {
      await this.runCompaction({ reason: "auto" });
    }
  }

  private handleLlmError(kind: LlmErrorKind, message: string): void {
    const now = Date.now();
    switch (kind) {
      case "budget":
        this.blocked = { state: "suspended", until: now + BUDGET_RECHECK_MS, reason: "停俸：预算超额", wakeReason: "budget_restored" };
        this.log("budget_block", { error: message });
        this.deps.events.emit({ type: "budget_block", actor: `post:${this.postId}`, trace_id: this.current?.trace_id, summary: `${this.post.title}停俸（预算超额）`, data: { error: message } });
        break;
      case "halted":
        this.blocked = { state: "paused", until: now + HALT_RECHECK_MS, reason: "罢朝", wakeReason: "resync" };
        this.deps.onHalted?.();
        this.log("error", { error: "网关报罢朝，暂停", detail: message });
        break;
      case "sick": {
        const first = this.sickAttempt === 0;
        const delay = Math.min(SICK_BASE_MS * 2 ** this.sickAttempt, SICK_MAX_MS);
        this.sickAttempt++;
        this.blocked = { state: "sick", until: now + delay, reason: `抱恙：模型服务异常，${Math.round(delay / 1000)} 秒后重试`, wakeReason: "retry" };
        // 不刷屏：只在首次与退避封顶时上报
        if (first || delay === SICK_MAX_MS) {
          this.deps.events.emit({ type: "error", actor: `post:${this.postId}`, summary: `${this.post.title}抱恙：${short(message, 200)}`, data: { error: message, attempt: this.sickAttempt } });
        }
        this.log("error", { error: "LLM 服务异常", detail: message, retry_in_ms: delay });
        return;
      }
      case "overflow":
      case "other":
        this.log("error", { error: "LLM 调用出错", detail: message });
        this.deps.events.emit({ type: "error", actor: `post:${this.postId}`, trace_id: this.current?.trace_id, summary: `${this.post.title}调用模型出错：${short(message, 200)}`, data: { error: message } });
        break;
    }
    this.sickAttempt = 0;
  }

  private async flushHubAck(): Promise<void> {
    const seq = this.pendingHubAck;
    if (seq === undefined) return;
    try {
      await this.hub.ackInbox(this.postId, seq);
      if (this.pendingHubAck === seq) this.pendingHubAck = undefined;
    } catch (e) {
      this.log("error", { error: `确认收件失败（稍后重试）：${(e as Error).message}`, seq });
    }
  }

  /** 轮中：皇帝来信用 steer 注入 */
  private async checkSteer(): Promise<void> {
    const cur = this.current;
    if (!cur || !this.agent) return;
    try {
      const res = await this.hub.inbox(this.postId, cur.ack_seq, 50);
      if (this.current !== cur) return;
      for (const it of res.items.sort((a, b) => a.delivery.seq - b.delivery.seq)) {
        const m = it.message;
        if (it.delivery.seq <= cur.ack_seq || m.from !== "emperor" || this.steeredIds.has(m.id) || this.carriedSteers.has(m.id)) continue;
        this.steeredIds.add(m.id);
        const msg: AgentMessage = { role: "user", content: renderSteer(m), timestamp: Date.now() };
        // 是否确认要看它是否真被注入（轮末仍在队列里的会被清掉，下次简报再现）
        this.pendingSteers.set(msg, { id: m.id, seq: it.delivery.seq });
        this.agent.steer(msg);
        this.log("message_in", { steer: true, message_id: m.id, from: m.from });
      }
    } catch {
      /* 拉取失败：轮后再处理 */
    }
  }

  // ───────────────────────── 压缩 ─────────────────────────

  private async runCompaction(opts: { summary?: string; reason: string; mustKeepLastUser?: boolean }): Promise<boolean> {
    const agent = this.agent;
    if (!agent) return false;
    const all = agent.state.messages;
    const before = estimateContextTokens(all);
    const sys = getCurrentSystemMessage(all);
    const nonSys = all.filter((m) => m.role !== "system");
    let { older, kept } = splitForCompaction(nonSys, this.L.compactKeepRecentTokens, opts.mustKeepLastUser);
    // 旧摘要并入待摘要段
    while (kept.length && kept[0].role === "user" && textOf((kept[0] as { content: unknown }).content).startsWith(SUMMARY_PREFIX)) {
      older = [...older, kept[0]];
      kept = kept.slice(1);
    }
    if (!older.length && !opts.summary) return false;
    let summary = opts.summary;
    if (!summary) {
      try {
        summary = await generateSummary(this.deps.gateway, this.official.model, older, {
          post_id: this.postId,
          official_id: this.officialId,
          dept: this.deps.dept,
          trace_id: this.current?.trace_id,
          turn_id: this.current?.turn_id,
        });
      } catch (e) {
        this.log("error", { error: `生成摘要失败，改用机械截取：${(e as Error).message}` });
        summary = fallbackSummary(older);
      }
    }
    const next = buildCompactedMessages(sys, summary, kept);
    agent.state.messages = next;
    const after = estimateContextTokens(next);
    this.session.appendKeptAfterCompaction(summary, kept, { tokens_before: before, tokens_after: after });
    this.ctxTokens = after;
    this.log("compact", { reason: opts.reason, tokens_before: before, tokens_after: after, summarized: older.length, kept: kept.length });
    this.deps.events.emit({
      type: "compact",
      actor: `post:${this.postId}`,
      summary: `${this.post.title}整理上下文：${before} → ${after} tokens`,
      data: { reason: opts.reason, tokens_before: before, tokens_after: after },
    });
    this.deps.live.publish(this.postId, "compact", { tokens_before: before, tokens_after: after });
    return true;
  }

  // ───────────────────────── Agent 事件 ─────────────────────────

  private onAgentEvent(e: AgentEvent): void {
    const cur = this.current;
    this.lastProgressAt = Date.now();
    switch (e.type) {
      case "message_start":
        if (e.message.role === "assistant") {
          this.setState("thinking");
          this.log("llm_start", { call_idx: this.callIdx - 1, model: this.official.model });
        }
        break;
      case "message_update": {
        const ev = e.assistantMessageEvent;
        if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
          this.deps.live.publish(this.postId, ev.type, { delta: ev.delta, turn_id: cur?.turn_id });
        }
        break;
      }
      case "message_end": {
        const m = e.message;
        this.session.appendMessage(m);
        const st = this.pendingSteers.get(m);
        if (st) {
          this.pendingSteers.delete(m);
          this.consumedSteers.push(st);
        }
        if (m.role === "assistant") this.onAssistantEnd(m as AssistantMessage);
        else if (m.role === "user") this.deps.live.publish(this.postId, "user_message", { text: short(textOf((m as { content: unknown }).content), 4000) });
        break;
      }
      case "tool_execution_start": {
        this.setState("tool", e.toolName);
        this.toolNames.push(e.toolName);
        this.toolSpanStarts.set(e.toolCallId, { span_id: newId("sp"), at: Date.now() });
        const loggedArgs = redactMcpSecretsInArgs(e.toolName, e.args);
        this.log("tool_call", { tool: e.toolName, tool_call_id: e.toolCallId, args: short(loggedArgs) });
        this.deps.live.publish(this.postId, "tool_start", { tool: e.toolName, tool_call_id: e.toolCallId, args: short(loggedArgs, 1000) });
        break;
      }
      case "tool_execution_end": {
        const start = this.toolSpanStarts.get(e.toolCallId) ?? { span_id: newId("sp"), at: Date.now() };
        const resultText = short(textOf(e.result?.content));
        this.log("tool_result", { tool: e.toolName, tool_call_id: e.toolCallId, is_error: e.isError, result: resultText, duration_ms: e.durationMs });
        this.deps.live.publish(this.postId, "tool_end", { tool: e.toolName, tool_call_id: e.toolCallId, is_error: e.isError, result: short(resultText, 1000) });
        const traceId = this.current?.trace_id ?? cur?.trace_id;
        if (traceId) {
          this.deps.events.emit({
            type: "tool.call",
            actor: `post:${this.postId}`,
            trace_id: traceId,
            span_id: start.span_id,
            parent_span_id: cur?.span_id,
            summary: `${this.post.title}调用 ${e.toolName}${e.isError ? "（出错）" : ""}`,
            data: { tool: e.toolName, turn_id: cur?.turn_id, is_error: e.isError },
            span: {
              span_id: start.span_id,
              trace_id: traceId,
              parent_span_id: cur?.span_id,
              kind: "tool",
              name: e.toolName,
              actor: `post:${this.postId}`,
              status: e.isError ? "error" : "ok",
              started_at: start.at,
              ended_at: Date.now(),
              attrs: { turn_id: cur?.turn_id },
            },
          });
          if (e.isError) {
            this.deps.events.emit({
              type: "tool.error",
              actor: `post:${this.postId}`,
              trace_id: traceId,
              parent_span_id: start.span_id,
              summary: `${this.post.title}的工具 ${e.toolName} 出错：${short(resultText, 200)}`,
              data: { tool: e.toolName, error: short(resultText, 1000) },
            });
          }
        }
        this.setState("thinking");
        break;
      }
      default:
        break;
    }
  }

  private onAssistantEnd(m: AssistantMessage): void {
    const cur = this.current;
    this.turnAssistants.push(m);
    const u = m.usage;
    if (dayStart() !== this.tokensDay) {
      this.tokensDay = dayStart();
      this.tokensToday = 0;
    }
    this.tokensToday += u?.totalTokens ?? 0;
    if (u) {
      this.turnUsage.input += u.input;
      this.turnUsage.output += u.output;
      this.turnUsage.cacheRead += u.cacheRead;
      this.turnUsage.cacheWrite += u.cacheWrite;
      this.turnUsage.totalTokens += u.totalTokens;
      this.turnUsage.cost += u.cost?.total ?? 0;
      const ctx = u.input + u.cacheRead + u.cacheWrite + u.output;
      if (ctx > 0) this.ctxTokens = ctx;
    }
    this.log("llm_end", { model: m.model, stop_reason: m.stopReason, usage: u, duration_ms: m.durationMs, error: m.errorMessage });
    if (cur) {
      this.deps.events.emit({
        type: "llm.call",
        actor: `post:${this.postId}`,
        trace_id: cur.trace_id,
        parent_span_id: cur.span_id,
        summary: `${this.post.title}调用模型 ${m.model}（${u?.totalTokens ?? 0} tokens${m.stopReason === "error" ? "，出错" : ""}）`,
        data: { turn_id: cur.turn_id, model: m.model, provider: m.provider, stop_reason: m.stopReason, usage: u, duration_ms: m.durationMs, error: m.errorMessage },
      });
    }
    this.deps.live.publish(this.postId, "llm_end", { stop_reason: m.stopReason, usage: u, text: short(textOf(m.content), 2000) });
  }

  // ───────────────────────── 状态 ─────────────────────────

  private updateStateFromWait(): void {
    if (this.current) return;
    if (this.pauseReason()) return this.setState("paused", this.pauseReason());
    if (this.blocked) return this.setState(this.blocked.state, this.blocked.reason);
    const w = this.wait;
    if (w.mode === "sleep") this.setState("sleeping", w.reason);
    else if (w.agent_set) this.setState("waiting", w.reason);
    else this.setState("idle");
  }

  private setState(state: OfficialState, detail?: string): void {
    const changed = state !== this.state;
    this.state = state;
    if (changed) this.publishState(detail);
  }

  private publishState(detail?: string): void {
    this.deps.live.publish(this.postId, "state", { state: this.state, detail, status_text: this.statusText, next_wake_at: this.wait?.next_wake_at });
  }

  status(): OfficialStatus {
    const now = Date.now();
    const pr = this.pauseReason();
    const state: OfficialState = this.current ? this.state : pr ? "paused" : this.state;
    return {
      post_id: this.postId,
      official_id: this.officialId,
      dept: this.deps.dept,
      state,
      status_text: this.statusText ?? (pr ? pr : this.blocked?.reason ?? (this.wait ? describeWait(this.wait) : undefined)),
      current_turn_id: this.current?.turn_id,
      current_trace_id: this.current?.trace_id,
      next_wake_at: this.blocked ? this.blocked.until : this.wait?.next_wake_at,
      wait_filter: this.wait?.agent_set ? this.wait.wait_filter : undefined,
      last_progress_at: this.lastProgressAt,
      turns_last_hour: this.turnStarts.filter((t) => t > now - 3600_000).length,
      tokens_today: dayStart() === this.tokensDay ? this.tokensToday : 0,
      context_tokens: this.ctxTokens,
      updated_at: now,
    };
  }

  /** 测试/诊断：当前等待条件 */
  waitState(): WaitState {
    return { ...this.wait };
  }

  private saveWait(): void {
    this.stateStore.save({ ...this.wait, post_id: this.postId });
  }

  // ───────────────────────── ToolContext ─────────────────────────

  get dept(): DeptDef {
    const d = this.deps.registry().depts.find((x) => x.id === this.post.dept);
    if (!d) throw new Error(`名册中找不到部门 ${this.post.dept}`);
    return d;
  }

  registry(): Registry {
    return this.deps.registry();
  }

  deptClient(dept: string): DeptClient {
    return new DeptClient({ baseUrl: this.deps.deptUrl(dept), token: this.deps.deptToken, actingPost: this.postId, timeoutMs: 15_000 });
  }

  turn(): TurnInfo {
    const c = this.current;
    if (c) return { turn_id: c.turn_id, trace_id: c.trace_id, span_id: c.span_id, wake_reason: c.wake_reason };
    return { turn_id: "tn_idle", trace_id: newId("tr"), span_id: newId("sp"), wake_reason: "none" };
  }

  focusTrace(traceId: string): void {
    if (this.current && traceId) this.current.trace_id = traceId;
  }

  idemKey(toolCallId: string): string {
    return `${this.postId}:${this.current?.turn_id ?? "tn_idle"}:${toolCallId}`;
  }

  private deptOfPost(postId: string): string {
    const p = this.deps.registry().posts.find((x) => x.post_id === postId);
    return p?.dept ?? postId.split(".")[0];
  }

  private withMeta<T extends { idem_key?: string; trace_id?: string; parent_span_id?: string }>(req: T): T {
    const t = this.turn();
    return { ...req, idem_key: req.idem_key ?? `${this.postId}:${t.turn_id}:${newId("dl")}`, trace_id: req.trace_id ?? t.trace_id, parent_span_id: req.parent_span_id ?? t.span_id };
  }

  async deliver(req0: SendMessageReq): Promise<SendMessageRes> {
    const req = this.withMeta(req0);
    let addr: ReturnType<typeof parseAddress>;
    try {
      addr = parseAddress(req.to);
    } catch {
      return this.hub.sendMessage(req);
    }
    const { to: _to, ...rest } = req;
    if (addr.type === "post" || addr.type === "dept") {
      const targetDept = addr.type === "post" ? this.deptOfPost(addr.id) : addr.id;
      if (targetDept === this.deps.dept) {
        const res = await this.hub.sendMessage(req);
        this.deps.localWake(res.routed_to, `message:${this.postId}`);
        return res;
      }
      try {
        const dc = this.deptClient(targetDept);
        return addr.type === "post" ? await dc.sendToOfficial(addr.id, rest) : await dc.deptInbox(rest);
      } catch (e) {
        if (!isFallbackError(e)) throw e;
        this.log("error", { error: `对方官署不可达，改经皇城投递：${(e as Error).message}`, to: req.to });
        return this.hub.sendMessage(req);
      }
    }
    return this.hub.sendMessage(req);
  }

  async invokeService(req0: CallServiceReq): Promise<ServiceRequest> {
    const req = this.withMeta(req0);
    let addr: ReturnType<typeof parseAddress>;
    try {
      addr = parseAddress(req.target);
    } catch {
      return this.hub.callService(req);
    }
    const { target: _t, service, ...rest } = req;
    if (addr.type === "post" || addr.type === "dept") {
      const targetDept = addr.type === "post" ? this.deptOfPost(addr.id) : addr.id;
      if (targetDept === this.deps.dept) {
        const res = await this.hub.callService(req);
        if (res.routed_to) this.deps.localWake([res.routed_to], `service:${this.postId}`);
        return res;
      }
      try {
        const dc = this.deptClient(targetDept);
        return addr.type === "post" ? await dc.officialService(addr.id, service, rest) : await dc.deptService(service, rest);
      } catch (e) {
        if (!isFallbackError(e)) throw e;
        this.log("error", { error: `对方官署不可达，改经皇城调用服务：${(e as Error).message}`, target: req.target });
        return this.hub.callService(req);
      }
    }
    return this.hub.callService(req);
  }

  sleep(seconds: number, reason: string): void {
    const s = Math.max(1, Math.min(this.L.maxSleepSeconds, Math.round(seconds)));
    this.nextWait = { kind: "sleep", seconds: s, reason };
  }

  waitFor(filter: WaitFilter, timeoutSeconds: number): void {
    const s = Math.max(1, Math.min(this.L.maxSleepSeconds, Math.round(timeoutSeconds)));
    this.nextWait = { kind: "wait", seconds: s, filter, reason: "等待回音" };
  }

  endTurn(note: string): void {
    this.nextWait = { kind: "end", seconds: this.post.default_wait_seconds, reason: note };
  }

  memoryRead(): string {
    if (!existsSync(this.memoryFile)) return "";
    return readFileSync(this.memoryFile, "utf8");
  }

  memoryWrite(op: "append" | "replace" | "clear", text: string): string {
    const cur = this.memoryRead();
    let next: string;
    if (op === "clear") next = "";
    else if (op === "replace") next = text;
    else next = cur ? `${cur.replace(/\n+$/, "")}\n${text}` : text;
    const size = Buffer.byteLength(next, "utf8");
    if (size > this.L.memoryNoteMaxBytes) {
      throw new Error(`备忘超出上限（${size}/${this.L.memoryNoteMaxBytes} 字节），请先用 replace 精简后再写。`);
    }
    writeFileSync(this.memoryFile, next);
    this.log("memory", { op, bytes: size });
    return `备忘已更新（${size}/${this.L.memoryNoteMaxBytes} 字节）`;
  }

  setStatusText(text: string): void {
    this.statusText = text || undefined;
    this.publishState();
  }

  contextTokens(): number {
    return this.ctxTokens;
  }

  log(type: string, data: Record<string, unknown>): void {
    // 日志保留期清理：每日一次（JsonlLog 默认保留 30 天）
    if (Date.now() - this.lastLogPruneAt > 86_400_000) {
      this.lastLogPruneAt = Date.now();
      try {
        this.logger.prune();
      } catch {
        /* 清理失败不影响运行 */
      }
    }
    const c = this.current;
    try {
      this.logger.write({
        official_id: this.officialId,
        post_id: this.postId,
        dept: this.deps.dept,
        type,
        trace_id: c?.trace_id,
        span_id: c?.span_id,
        turn_id: c?.turn_id,
        ...data,
      });
    } catch {
      /* 日志写失败不影响运行 */
    }
    if (type === "message_out") this.deps.live.publish(this.postId, "message_out", data);
    // 稽查相关的本地日志同时上报 hub（御史台稽查规则依赖）
    if (type === "tool.injection_suspect") {
      this.deps.events.emit({
        type,
        actor: `post:${this.postId}`,
        trace_id: c?.trace_id,
        summary: `${this.post.title}读到疑似提示注入内容（${String(data.source ?? "")}）`,
        data,
      });
    }
  }
}

/**
 * 无实效工具：只读查询与结束/自理类。一轮只调用了这些即视为「空转」。
 * MCP 动态工具（mcp__*）一律算有实效：无法从外部工具名可靠判断其是否只读。
 */
const IDLE_TOOL_RE = /^(end_turn|sleep|wait_for|whats_happening|my_status|read_inbox|ack_message|memory_note|set_status|search_messages|trace_timeline|council_get|tool_inventory|style_guide_get|glossary_get|post_vacancies|budget_get|mcp_list_servers|mcp_get_server|mcp_get_access)$|^(get_|list_)|_(get|list|search|read|status|diff|history|findings|logs|ledger|trace|report_get)$/;

export function isProductiveTurn(tools: string[]): boolean {
  return tools.some((t) => t.startsWith(MCP_TOOL_PREFIX) || !IDLE_TOOL_RE.test(t));
}

/** 对方官署不可达/故障 → 回退经 hub 直投 */
function isFallbackError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status >= 500 || e.code === "unavailable" || (e.status === 404 && e.code === "not_found");
}

