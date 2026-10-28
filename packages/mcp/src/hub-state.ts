// hub 全量状态缓存：配置（含密钥）、部门 token、职位归属。定时轮询 + 按需刷新。
import type { HubClient, McpInternalState, McpServerConfig } from "@court/shared";
import { errorMessage } from "./errors.ts";
import { logEvent } from "./log.ts";

/** 未知 token / 职位触发的即时刷新最小间隔 */
const ON_DEMAND_REFRESH_GAP_MS = 5_000;

const EMPTY_STATE: McpInternalState = { version: 0, servers: [], tokens: {}, posts: {} };

export interface CallerIdentity {
  dept: string;
  post: string;
  official_id?: string;
}

export class HubStateStore {
  private state: McpInternalState = EMPTY_STATE;
  private serversById = new Map<string, McpServerConfig>();
  private deptByToken = new Map<string, string>();
  private inflight?: Promise<McpInternalState>;
  private lastRefreshAt = 0;
  private timer?: NodeJS.Timeout;
  private loaded = false;
  lastError?: string;

  constructor(
    private hub: HubClient,
    private pollMs: number,
    private onChange: (state: McpInternalState) => void,
  ) {}

  get current(): McpInternalState {
    return this.state;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  getServerConfigOrNull(id: string): McpServerConfig | null {
    return this.serversById.get(id) ?? null;
  }

  listServerConfigs(): McpServerConfig[] {
    return this.state.servers;
  }

  /** 拉取 hub 状态；并发调用合并为一次。失败抛错，保留旧状态。 */
  refresh(): Promise<McpInternalState> {
    if (this.inflight) return this.inflight;
    this.lastRefreshAt = Date.now();
    this.inflight = (async () => {
      try {
        const next = normalizeState(await this.hub.mcpInternalState());
        const changed = !this.loaded || next.version !== this.state.version || JSON.stringify(next.servers) !== JSON.stringify(this.state.servers);
        this.apply(next);
        if (this.lastError) logEvent("info", "hub.state_recovered", { version: next.version });
        this.lastError = undefined;
        if (changed) {
          logEvent("info", "hub.state_loaded", { version: next.version, servers: next.servers.length, depts: this.deptByToken.size });
          this.onChange(next);
        }
        return next;
      } catch (e) {
        const msg = errorMessage(e);
        if (msg !== this.lastError) logEvent("warn", "hub.state_failed", { error: msg });
        this.lastError = msg;
        throw e;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** 按需刷新（未知 token/职位时）：距上次刷新不足 5s 则不刷。返回是否真的刷新成功。 */
  async refreshIfStale(): Promise<boolean> {
    if (Date.now() - this.lastRefreshAt < ON_DEMAND_REFRESH_GAP_MS) {
      if (this.inflight) await this.inflight.catch(() => undefined);
      return false;
    }
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getDeptByTokenOrNull(token: string): string | null {
    return this.deptByToken.get(token) ?? null;
  }

  getPostOrNull(post: string): { dept: string; official_id?: string } | null {
    return Object.hasOwn(this.state.posts, post) ? this.state.posts[post] : null;
  }

  private apply(next: McpInternalState): void {
    this.state = next;
    this.loaded = true;
    this.serversById = new Map(next.servers.map((s) => [s.id, s]));
    this.deptByToken = new Map(Object.entries(next.tokens));
  }
}

function normalizeState(raw: McpInternalState): McpInternalState {
  if (!raw || typeof raw !== "object") throw new Error("hub 返回的 MCP 状态格式不对");
  return {
    version: Number(raw.version) || 0,
    servers: Array.isArray(raw.servers) ? raw.servers.filter((s) => s && typeof s.id === "string") : [],
    tokens: raw.tokens && typeof raw.tokens === "object" ? raw.tokens : {},
    posts: raw.posts && typeof raw.posts === "object" ? raw.posts : {},
  };
}
