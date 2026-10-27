// 限流与容错：并发信号量、熔断器、错误分类与退避。
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

/** 先进先出的并发信号量；acquire 可被 signal 取消。 */
export class Semaphore {
  private active = 0;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(readonly max: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("请求已取消");
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("请求已取消"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
    // 名额由 release 直接转交，active 不变
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.resolve();
      else this.active--;
    };
  }
}

export type CircuitState = "closed" | "open" | "half_open";

/** 连续失败 threshold 次 → 打开 openMs → 半开放行一个探测请求 → 成功关闭 / 失败重新打开。 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private stateValue: CircuitState = "closed";

  constructor(
    readonly threshold = 5,
    readonly openMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  get state(): CircuitState {
    if (this.stateValue === "open" && this.now() - this.openedAt >= this.openMs) {
      this.stateValue = "half_open";
      this.probing = false;
    }
    return this.stateValue;
  }

  /** 是否放行：closed → "pass"；半开且无人探测 → "probe"（只放一个）；否则 false。 */
  tryPass(): "pass" | "probe" | false {
    const s = this.state;
    if (s === "closed") return "pass";
    if (s === "open") return false;
    if (this.probing) return false;
    this.probing = true;
    return "probe";
  }

  /** 探测请求没有产生结论（如被调用方取消、鉴权错误）时归还探测名额；仅持有 "probe" 者调用 */
  release(): void {
    this.probing = false;
  }

  retryInMs(): number {
    return Math.max(0, this.openMs - (this.now() - this.openedAt));
  }

  onSuccess(): void {
    this.failures = 0;
    this.probing = false;
    this.stateValue = "closed";
  }

  onFailure(): void {
    this.probing = false;
    this.failures++;
    if (this.stateValue === "half_open" || this.failures >= this.threshold) {
      this.stateValue = "open";
      this.openedAt = this.now();
    }
  }

  snapshot(): { state: CircuitState; failures: number; retry_in_ms: number } {
    const state = this.state;
    return { state, failures: this.failures, retry_in_ms: state === "open" ? this.retryInMs() : 0 };
  }
}

export type ErrorClass = "aborted" | "auth" | "context" | "rate_limit" | "transient" | "fatal";

const AUTH_RE = /(?<![0-9])(401|403)(?![0-9])|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|authentication|forbidden|permission denied|no api key|missing api key|api key/i;
const RATE_RE = /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests|overloaded|server_busy|at capacity/i;
const NON_RETRYABLE_LIMIT_RE = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit|insufficient_quota|quota exceeded|billing/i;

export function classifyError(msg: AssistantMessage, contextWindow?: number): ErrorClass {
  if (msg.stopReason === "aborted") return "aborted";
  const text = msg.errorMessage ?? "";
  if (isContextOverflow(msg, contextWindow)) return "context";
  if (NON_RETRYABLE_LIMIT_RE.test(text)) return "fatal";
  if (RATE_RE.test(text)) return "rate_limit";
  if (isRetryableAssistantError(msg)) return "transient";
  if (AUTH_RE.test(text)) return "auth";
  return "fatal";
}

/** 从错误文本中提取服务端建议的等待时间（retry-after / "try again in Ns" 等） */
export function parseRetryAfterMs(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m =
    /retry[- ]after["':\s]*([0-9.]+)\s*(ms|s|sec|seconds)?/i.exec(text) ??
    /try again in\s*([0-9.]+)\s*(ms|s|sec|seconds)?/i.exec(text) ??
    /retry in\s*([0-9.]+)\s*(ms|s|sec|seconds)?/i.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return undefined;
  return m[2] === "ms" ? v : v * 1000;
}

/** 指数退避 + 全抖动；若服务端给了 retry-after 则以其为下限（上限 maxMs）。 */
export function retryDelayMs(attempt: number, opts: { baseMs: number; maxMs: number; retryAfterMs?: number }): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  const jittered = exp / 2 + Math.random() * (exp / 2);
  const floor = opts.retryAfterMs !== undefined ? Math.min(opts.maxMs, opts.retryAfterMs) : 0;
  return Math.floor(Math.max(jittered, floor));
}
