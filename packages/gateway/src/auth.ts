// 调用方鉴权：部门 token → 部门；网关 token → hub（系统用途）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HubClient } from "@court/shared";

export interface SharedTokens {
  depts: Record<string, string>; // dept → token
  gateway?: string;
  control?: string;
  sandbox?: string;
}

export type Caller = { kind: "dept"; dept: string } | { kind: "gateway" };

/** 读取 DATA_DIR/shared/tokens.json（hub 写入）；不存在或损坏返回 undefined。 */
export function readSharedTokens(dataDir: string): SharedTokens | undefined {
  const file = join(dataDir, "shared", "tokens.json");
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { depts: raw.depts ?? {}, gateway: raw.gateway, control: raw.control, sandbox: raw.sandbox };
  } catch {
    return undefined;
  }
}

const DEPT_ID_RE = /^[a-z_]+$/;

/**
 * hub /api/internal/tokens 的返回值方向未定（token→dept 或 dept→token），按形状判断：
 * 键全部像部门 ID 且值不像部门 ID → dept→token。
 */
export function normalizeTokenMap(raw: Record<string, string>): Map<string, string> {
  const entries = Object.entries(raw);
  const keysAreDepts = entries.length > 0 && entries.every(([k, v]) => DEPT_ID_RE.test(k) && !DEPT_ID_RE.test(v));
  const out = new Map<string, string>();
  for (const [k, v] of entries) {
    if (keysAreDepts) out.set(v, k);
    else out.set(k, v);
  }
  return out;
}

export class TokenRegistry {
  private byToken = new Map<string, string>(); // token → dept
  private timer?: NodeJS.Timeout;
  lastRefreshError?: string;

  constructor(
    private opts: {
      gatewayToken: string;
      initialDepts?: Record<string, string>; // dept → token
      dataDir?: string;
      hub?: HubClient;
      refreshMs?: number;
    },
  ) {
    for (const [dept, token] of Object.entries(opts.initialDepts ?? {})) this.byToken.set(token, dept);
  }

  get gatewayToken(): string {
    return this.opts.gatewayToken;
  }

  get deptCount(): number {
    return this.byToken.size;
  }

  identify(authHeader: string | undefined): Caller | undefined {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
    if (!m) return undefined;
    const token = m[1].trim();
    if (token && timingSafeEq(token, this.opts.gatewayToken)) return { kind: "gateway" };
    const dept = this.byToken.get(token);
    return dept ? { kind: "dept", dept } : undefined;
  }

  private lastRefreshAt = 0;

  /** 识别调用方；未知 token 时（可能是 hub 新签发）最多每 5s 触发一次即时刷新再试。 */
  async identifyFresh(authHeader: string | undefined): Promise<Caller | undefined> {
    const caller = this.identify(authHeader);
    if (caller || !/^Bearer\s+\S/i.test(authHeader ?? "") || Date.now() - this.lastRefreshAt < 5000) return caller;
    await this.refresh();
    return this.identify(authHeader);
  }

  /** 从 tokens.json 与 hub 刷新部门 token（两者合并；hub 失败不影响已有映射）。 */
  async refresh(): Promise<void> {
    this.lastRefreshAt = Date.now();
    const next = new Map<string, string>();
    if (this.opts.dataDir) {
      const shared = readSharedTokens(this.opts.dataDir);
      for (const [dept, token] of Object.entries(shared?.depts ?? {})) next.set(token, dept);
    }
    if (this.opts.hub) {
      try {
        for (const [token, dept] of normalizeTokenMap(await this.opts.hub.internalTokens())) next.set(token, dept);
        this.lastRefreshError = undefined;
      } catch (e) {
        this.lastRefreshError = (e as Error).message;
      }
    }
    if (next.size) this.byToken = next;
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** opencode-go 密钥：env OPENCODE_API_KEY → /secrets/pi-auth.json → ~/.pi/agent/auth.json。绝不打印。 */
export function resolveOpencodeKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OPENCODE_API_KEY) return env.OPENCODE_API_KEY;
  const candidates = [env.PI_AUTH_FILE_IN_CONTAINER ?? "/secrets/pi-auth.json", join(homedir(), ".pi", "agent", "auth.json")];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8").trim();
      if (!text) continue;
      const key = JSON.parse(text)?.["opencode-go"]?.key;
      if (typeof key === "string" && key) return key;
    } catch {
      /* 文件不可读或非 JSON：试下一个 */
    }
  }
  return undefined;
}
