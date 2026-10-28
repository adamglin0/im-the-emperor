// 部门运行时：一个部门容器一个实例。启动拉名册 → 为本部门每个在任职位起一个官员运行时；
// 心跳（含名册版本/罢朝）→ 名册变化时增减官员、标记配置待刷新；hub 持续不可达 → 暂停新轮；收件兜底巡检；事件 outbox。
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  GatewayClient,
  HubClient,
  LIMITS,
  McpClient,
  Outbox,
  SandboxClient,
  backoffMs,
  sleepMs,
  type DeptDef,
  type EventIn,
  type OfficialStatus,
  type PostDef,
  type Registry,
} from "@court/shared";
import { DeptEvents, LiveBus } from "./events.ts";
import { OfficialRuntime, type Limits, type ToolsFactory } from "./official.ts";
import { Semaphore } from "./semaphore.ts";

const SANDBOX_DEPTS = new Set(["bingbu", "gongbu", "xingbu"]);

export interface DeptTokens {
  dept: string;
  control?: string;
  sandbox?: string;
}

export interface DeptRuntimeOptions {
  dept: string;
  hubUrl: string;
  gatewayUrl: string;
  sandboxUrl?: string;
  /** MCP 中转站地址；缺省 = 本部门官员不装 MCP 工具 */
  mcpUrl?: string;
  /** 轮次边界等 MCP 工具清单的上限（毫秒）；缺省 5 秒，测试可调小 */
  mcpBoundaryWaitMs?: number;
  dataDir: string;
  tokens: DeptTokens;
  buildTools: ToolsFactory;
  streamFn?: StreamFn;
  deptUrlResolver?: (dept: string) => string;
  /** 部门地址覆盖（集成测试多部门同机），优先于名册 host/port */
  deptUrlOverrides?: Record<string, string>;
  limits?: Partial<Limits>;
  fetchImpl?: typeof fetch;
  /** 运行时自身日志（默认 console） */
  logger?: (msg: string) => void;
}

/** 状态变化后提前心跳的合并窗口 */
const STATE_HEARTBEAT_DEBOUNCE_MS = 250;

export class DeptRuntime {
  readonly dept: string;
  readonly hub: HubClient;
  readonly gateway: GatewayClient;
  readonly sandbox?: SandboxClient;
  readonly mcp?: McpClient;
  readonly live = new LiveBus();
  readonly events: DeptEvents;
  readonly outbox: Outbox<EventIn>;
  readonly officials = new Map<string, OfficialRuntime>();
  private readonly L: Limits;
  private readonly llmSemaphore: Semaphore;
  private reg?: Registry;
  private halted = false;
  private hubDown = false;
  private hubOkAt = Date.now();
  private stopping = false;
  private started = false;
  private needSync = false;
  private syncing?: Promise<void>;
  private timers: NodeJS.Timeout[] = [];
  private heartbeatBusy = false;
  private nudgeTimer?: NodeJS.Timeout;
  private readonly logFn: (msg: string) => void;

  constructor(readonly opts: DeptRuntimeOptions) {
    this.dept = opts.dept;
    this.L = { ...LIMITS, ...opts.limits };
    this.logFn = opts.logger ?? ((m) => console.log(`[dept:${opts.dept}] ${m}`));
    this.hub = new HubClient({ baseUrl: opts.hubUrl, token: opts.tokens.dept, fetchImpl: opts.fetchImpl });
    this.gateway = new GatewayClient({ baseUrl: opts.gatewayUrl, token: opts.tokens.dept, timeoutMs: 180_000, fetchImpl: opts.fetchImpl });
    if (opts.sandboxUrl && SANDBOX_DEPTS.has(opts.dept)) {
      this.sandbox = new SandboxClient({ baseUrl: opts.sandboxUrl, token: opts.tokens.sandbox, timeoutMs: 15 * 60_000, fetchImpl: opts.fetchImpl });
    }
    if (opts.mcpUrl) {
      // 部门 token；官员各自 withPost。调用超时放宽到 15 分钟（单次调用上限由服务器配置 timeout_seconds 决定，≤600s）
      this.mcp = new McpClient({ baseUrl: opts.mcpUrl, token: opts.tokens.dept, timeoutMs: 15 * 60_000, fetchImpl: opts.fetchImpl });
    }
    this.outbox = new Outbox<EventIn>(
      join(opts.dataDir, "depts", opts.dept, "outbox-events.jsonl"),
      async (batch) => {
        await this.hub.postEvents(batch);
      },
      { maxItems: this.L.outboxMaxItems },
    );
    this.events = new DeptEvents(this.outbox, opts.dept);
    this.llmSemaphore = new Semaphore(this.L.deptLlmConcurrency);
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /** 启动：拉名册（hub 未起则退避重试），起官员，开心跳/巡检/outbox */
  async start(): Promise<void> {
    let attempt = 0;
    while (!this.stopping) {
      try {
        this.reg = await this.hub.registry();
        break;
      } catch (e) {
        if (attempt === 0 || attempt % 10 === 0) this.logFn(`等待皇城（${(e as Error).message}）`);
        await sleepMs(backoffMs(attempt++, 500, 10_000));
      }
    }
    if (this.stopping || !this.reg) return;
    this.halted = this.reg.halted;
    this.hubOkAt = Date.now();
    this.outbox.start();
    await this.syncOfficials();
    if (this.stopping) return; // 启动途中被叫停：不再挂心跳/巡检计时器
    this.started = true;
    this.timers.push(setInterval(() => void this.heartbeat(), this.L.heartbeatMs));
    this.live.onState = () => this.nudgeHeartbeat();
    this.timers.push(setInterval(() => this.pollInboxes(), this.L.inboxPollMs));
    this.logFn(`已启动，官员 ${this.officials.size} 人`);
  }

  /** 停机：不开新轮 → 当前轮 drainMs 内结束或中止 → 刷 outbox → 存会话（会话为逐条追加，已持久） */
  async stop(drainMs = 30_000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.live.onState = undefined;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await Promise.all([...this.officials.values()].map((o) => o.stop(drainMs).catch(() => undefined)));
    // 尽力上报最后状态（hub 不可达时不等满 15s 超时，留时间刷 outbox）
    let t: NodeJS.Timeout | undefined;
    await Promise.race([this.heartbeatOnce().catch(() => undefined), new Promise<void>((r) => (t = setTimeout(r, 3_000)))]);
    clearTimeout(t);
    await this.outbox.stop(5_000);
  }

  get isStarted(): boolean {
    return this.started;
  }

  // ───────────────────────── 名册 ─────────────────────────

  registry(): Registry {
    if (!this.reg) throw new Error("名册尚未载入");
    return this.reg;
  }

  deptDef(): DeptDef {
    const d = this.reg?.depts.find((x) => x.id === this.dept);
    if (!d) throw new Error(`名册中没有部门 ${this.dept}`);
    return d;
  }

  /** 本部门全部职位（含空缺） */
  posts(): PostDef[] {
    return (this.reg?.posts ?? []).filter((p) => p.dept === this.dept);
  }

  hasPost(post: string): boolean {
    return this.posts().some((p) => p.post_id === post);
  }

  deptUrl(dept: string): string {
    const o = this.opts.deptUrlOverrides?.[dept];
    if (o) return o;
    if (this.opts.deptUrlResolver) return this.opts.deptUrlResolver(dept);
    const d = this.reg?.depts.find((x) => x.id === dept);
    const host = d?.host ?? `dept-${dept.replace(/_/g, "-")}`;
    return `http://${host}:${d?.port ?? 8080}`;
  }

  /** 名册变化：重新拉取并增减官员（调岗：原处 drain → 停 → 新处拉起） */
  async reload(): Promise<void> {
    this.reg = await this.hub.registry();
    this.halted = this.reg.halted;
    for (const o of this.officials.values()) o.markConfigDirty();
    await this.syncOfficials();
  }

  private syncOfficials(): Promise<void> {
    if (this.syncing) {
      this.needSync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.needSync = false;
          await this.syncOnce();
        } while (this.needSync && !this.stopping);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const reg = this.registry();
    const wanted = new Map<string, string>(); // post → official_id
    for (const p of this.posts()) {
      const appt = reg.appointments.find((a) => a.post_id === p.post_id);
      const off = appt && reg.officials.find((o) => o.official_id === appt.official_id);
      if (off && off.status === "active") wanted.set(p.post_id, off.official_id);
    }
    // 先停：离任/调走/换人
    for (const [post, o] of [...this.officials]) {
      if (wanted.get(post) !== o.officialId) {
        this.logFn(`${post}（${o.officialId}）离任，停止`);
        await o.stop(30_000).catch(() => undefined);
        this.officials.delete(post);
      }
    }
    // 后起：新任/调入
    for (const [post, officialId] of wanted) {
      if (this.officials.has(post) || this.stopping) continue;
      const postDef = this.posts().find((p) => p.post_id === post)!;
      const official = reg.officials.find((o) => o.official_id === officialId)!;
      const o = new OfficialRuntime(postDef, official, {
        dept: this.dept,
        dataDir: this.opts.dataDir,
        hub: this.hub,
        gateway: this.gateway,
        gatewayUrl: this.opts.gatewayUrl,
        deptToken: this.opts.tokens.dept,
        sandbox: this.sandbox,
        mcp: this.mcp,
        mcpBoundaryWaitMs: this.opts.mcpBoundaryWaitMs,
        streamFn: this.opts.streamFn,
        buildTools: this.opts.buildTools,
        events: this.events,
        live: this.live,
        llmSemaphore: this.llmSemaphore,
        registry: () => this.registry(),
        deptUrl: (d) => this.deptUrl(d),
        localWake: (posts, reason) => this.localWake(posts, reason),
        globalPauseReason: () => this.globalPauseReason(),
        onHalted: () => {
          this.halted = true;
        },
        limits: this.opts.limits,
      });
      try {
        await o.start();
        if (this.stopping) {
          // 启动期间部门开始停机：stop() 已遍历过官员表，这里自行收掉，免得留下无人管的循环
          await o.stop(0).catch(() => undefined);
          continue;
        }
        this.officials.set(post, o);
      } catch (e) {
        this.logFn(`${post} 启动失败，稍后重试：${(e as Error).message}`);
        this.retrySyncLater();
      }
    }
  }

  private retryTimer?: NodeJS.Timeout;
  private retrySyncLater(): void {
    if (this.retryTimer || this.stopping) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.syncOfficials().catch(() => undefined);
    }, 5_000);
    this.retryTimer.unref?.();
  }

  // ───────────────────────── 心跳与暂停 ─────────────────────────

  globalPauseReason(): string | undefined {
    if (this.stopping) return "停机中";
    if (this.halted) return "罢朝";
    if (this.hubDown) return "皇城不可达";
    return undefined;
  }

  statuses(): OfficialStatus[] {
    const now = Date.now();
    const out: OfficialStatus[] = [];
    for (const p of this.posts()) {
      const o = this.officials.get(p.post_id);
      out.push(o ? o.status() : this.vacantStatus(p.post_id, now));
    }
    return out;
  }

  vacantStatus(post: string, now = Date.now()): OfficialStatus {
    return { post_id: post, dept: this.dept, state: "vacant", last_progress_at: 0, turns_last_hour: 0, tokens_today: 0, updated_at: now };
  }

  /** 官员状态变化：短暂合并后提前发一次心跳（hub 据此推 status.changed），不必等满心跳周期 */
  private nudgeHeartbeat(): void {
    if (!this.started || this.stopping || this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      void this.heartbeat();
    }, STATE_HEARTBEAT_DEBOUNCE_MS);
  }

  private async heartbeat(): Promise<void> {
    if (this.heartbeatBusy || this.stopping) return;
    this.heartbeatBusy = true;
    try {
      await this.heartbeatOnce();
    } catch (e) {
      if (!this.hubDown && Date.now() - this.hubOkAt > this.L.hubUnreachablePauseMs) {
        this.hubDown = true;
        this.logFn(`皇城持续不可达（${(e as Error).message}），暂停所有官员新轮次`);
      }
    } finally {
      this.heartbeatBusy = false;
    }
  }

  private async heartbeatOnce(): Promise<void> {
    const res = await this.hub.heartbeat(this.statuses());
    this.hubOkAt = Date.now();
    const wasPaused = !!this.globalPauseReason();
    if (this.hubDown) {
      this.hubDown = false;
      this.logFn("皇城恢复联络，重新同步");
    }
    this.halted = res.halted;
    if (this.reg && !this.stopping && res.registry_version !== this.reg.version) this.reloadInBackground();
    if (wasPaused && !this.globalPauseReason()) {
      for (const o of this.officials.values()) o.notifyGlobalResume();
    }
  }

  private reloading?: Promise<void>;
  /** 心跳发现名册变了：后台刷新（离任官员 drain 最长 30s，不能拖住心跳——否则 hub 视本部门失联） */
  private reloadInBackground(): void {
    if (this.reloading) return;
    this.reloading = this.reload()
      .catch((e) => this.logFn(`名册刷新失败：${(e as Error).message}`))
      .finally(() => {
        this.reloading = undefined;
      });
  }

  private pollInboxes(): void {
    if (this.globalPauseReason()) return;
    for (const o of this.officials.values()) if (!o.inTurn) o.kick("poll");
  }

  // ───────────────────────── 控制面 ─────────────────────────

  doorbell(posts: string[]): void {
    for (const p of posts) this.officials.get(p)?.kick("doorbell");
  }

  localWake(posts: string[], reason: string): void {
    for (const p of posts) this.officials.get(p)?.kick(reason);
  }

  wake(post: string, reason: string): boolean {
    const o = this.officials.get(post);
    if (!o) return false;
    o.wakeManual(reason);
    return true;
  }

  pause(posts?: string[]): void {
    for (const [p, o] of this.officials) if (!posts?.length || posts.includes(p)) o.pause("控制面暂停");
  }

  resume(posts?: string[]): void {
    for (const [p, o] of this.officials) if (!posts?.length || posts.includes(p)) o.resume();
  }

  /** MCP 配置/授权有变：各官员在下个轮次边界重新拉取 MCP 工具清单 */
  markMcpDirty(): void {
    for (const o of this.officials.values()) o.markMcpDirty();
  }

  /** 预算有变：停俸者立即复查 */
  recheckBudget(): void {
    for (const o of this.officials.values()) o.recheckBudget();
  }

  compact(post: string): boolean {
    const o = this.officials.get(post);
    if (!o) return false;
    o.requestCompaction();
    return true;
  }

  /** 卡死的职位（健康检查用） */
  stalledPosts(): string[] {
    const now = Date.now();
    return [...this.officials.values()].filter((o) => o.isStalled(now)).map((o) => o.postId);
  }

  get hubReachable(): boolean {
    return !this.hubDown;
  }

  get isHalted(): boolean {
    return this.halted;
  }
}
