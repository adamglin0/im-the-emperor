// 调用管线：解析受信模型 → 预算 → 熔断/并发 → 调提供商（重试）→ 转成 proxy 事件 → 记账。
// /api/stream 与 /api/complete 共用。
import type { ProxyAssistantMessageEvent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { redact, sleepMs, type GatewayMeta } from "@court/shared";
import type { Caller } from "./auth.ts";
import type { BudgetGate } from "./budget.ts";
import type { GatewayRecorder } from "./ledger.ts";
import { runMockBrain } from "./mock-brain.ts";
import type { ModelCatalog } from "./models.ts";
import { CircuitBreaker, classifyError, parseRetryAfterMs, retryDelayMs, Semaphore } from "./resilience.ts";

export type ProxyEvent = ProxyAssistantMessageEvent;
export type Emit = (e: ProxyEvent) => void;

/** 调用方可传的提供商无关选项（其余一律丢弃，尤其 headers/metadata/apiKey） */
export interface ClientCallOptions {
  temperature?: number;
  maxTokens?: number;
  reasoning?: SimpleStreamOptions["reasoning"];
  cacheRetention?: SimpleStreamOptions["cacheRetention"];
  thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"];
  samplingParams?: SimpleStreamOptions["samplingParams"];
  sessionId?: string;
}

export interface CallInput {
  caller: Caller;
  model: { provider: string; id: string; api?: string };
  context: Context;
  options: ClientCallOptions;
  meta: GatewayMeta;
  skipBudget: boolean;
}

export interface PipelineOptions {
  mode: "real" | "mock";
  catalog?: ModelCatalog;
  budget: BudgetGate;
  recorder: GatewayRecorder;
  maxConcurrency?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  breakerThreshold?: number;
  breakerOpenMs?: number;
  /** 上游请求超时（毫秒，传给 SDK），默认 300000 */
  upstreamTimeoutMs?: number;
  /** 上游流空闲超时（毫秒，无任何事件则中止并按临时错误处理），默认 120000 */
  upstreamIdleMs?: number;
  /** mock 模式下每个事件之间的延迟（毫秒），默认 0 */
  mockEventDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const ERROR_PREFIX = {
  budget: "BUDGET_EXCEEDED",
  halted: "HALTED",
  circuit: "CIRCUIT_OPEN",
  auth: "AUTH_ERROR",
  context: "CONTEXT_TOO_LONG",
  model: "MODEL_NOT_FOUND",
  rateLimited: "RATE_LIMITED",
  upstream: "UPSTREAM_ERROR",
} as const;

const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const CACHE_RETENTION = new Set(["none", "short", "long"]);
/** samplingParams 会被原样并入请求体（可覆盖 model/stream 等字段），只放行这些数值型采样参数 */
const SAMPLING_KEYS = ["top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "seed"];

const num = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined);

export function pickClientOptions(raw: unknown): ClientCallOptions {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ClientCallOptions = {};
  const temperature = num(src.temperature, 0, 2);
  if (temperature !== undefined) out.temperature = temperature;
  const maxTokens = num(src.maxTokens, 1, 1_000_000);
  if (maxTokens !== undefined) out.maxTokens = Math.floor(maxTokens);
  if (typeof src.reasoning === "string" && REASONING_LEVELS.has(src.reasoning)) out.reasoning = src.reasoning as ClientCallOptions["reasoning"];
  if (typeof src.cacheRetention === "string" && CACHE_RETENTION.has(src.cacheRetention)) out.cacheRetention = src.cacheRetention as ClientCallOptions["cacheRetention"];
  if (src.thinkingBudgets && typeof src.thinkingBudgets === "object") {
    const tb: Record<string, number> = {};
    for (const [k, v] of Object.entries(src.thinkingBudgets as Record<string, unknown>)) {
      const n = num(v, 0, 1_000_000);
      if (REASONING_LEVELS.has(k) && n !== undefined) tb[k] = Math.floor(n);
    }
    if (Object.keys(tb).length) out.thinkingBudgets = tb as ClientCallOptions["thinkingBudgets"];
  }
  if (src.samplingParams && typeof src.samplingParams === "object") {
    const sp: Record<string, number> = {};
    for (const k of SAMPLING_KEYS) {
      const n = num((src.samplingParams as Record<string, unknown>)[k], -1e9, 1e9);
      if (n !== undefined) sp[k] = n;
    }
    if (Object.keys(sp).length) out.samplingParams = sp as ClientCallOptions["samplingParams"];
  }
  if (typeof src.sessionId === "string" && src.sessionId && src.sessionId.length <= 200) out.sessionId = src.sessionId;
  return out;
}

export function zeroUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function estimateContextTokens(context: Context): number {
  return Math.ceil(JSON.stringify(context.messages ?? []).length / 4 + (context.systemPrompt ?? "").length / 4);
}

/**
 * 把 pi 事件转为 proxy 事件。start 先扣住，直到出现第一个内容事件才发出：
 * 这样「尚未向客户端写出任何字节」的失败可以安全重试。终止事件由管线决定如何发出。
 */
class Forwarder {
  private pendingStart = false;
  private startSent = false;
  private acc = new Map<number, string>();

  constructor(private emit: Emit) {}

  get streamed(): boolean {
    return this.startSent;
  }

  push(ev: AssistantMessageEvent): void {
    switch (ev.type) {
      case "start":
        this.pendingStart = true;
        return;
      case "done":
      case "error":
        return;
      default:
        this.flushStart();
        for (const out of this.convert(ev)) this.emit(out);
    }
  }

  private flushStart(): void {
    if (this.startSent) return;
    this.startSent = true;
    this.pendingStart = false;
    this.emit({ type: "start" });
  }

  private convert(ev: Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>): ProxyEvent[] {
    const i = ev.contentIndex;
    switch (ev.type) {
      case "text_start":
      case "thinking_start":
        this.acc.set(i, "");
        return [{ type: ev.type, contentIndex: i }];
      case "text_delta":
      case "thinking_delta":
        this.acc.set(i, (this.acc.get(i) ?? "") + ev.delta);
        return [{ type: ev.type, contentIndex: i, delta: ev.delta }];
      case "text_end":
      case "thinking_end": {
        const out: ProxyEvent[] = [];
        // 某些提供商（如脱敏思考）在 start 时已给全文而无 delta：补一个 delta 让客户端拼出完整内容
        const got = this.acc.get(i) ?? "";
        if (ev.content !== got && ev.content.startsWith(got)) {
          out.push({ type: ev.type === "text_end" ? "text_delta" : "thinking_delta", contentIndex: i, delta: ev.content.slice(got.length) });
        }
        const block = ev.partial.content[i] as { textSignature?: string; thinkingSignature?: string } | undefined;
        const contentSignature = ev.type === "text_end" ? block?.textSignature : block?.thinkingSignature;
        out.push(contentSignature !== undefined ? { type: ev.type, contentIndex: i, contentSignature } : { type: ev.type, contentIndex: i });
        return out;
      }
      case "toolcall_start": {
        const block = ev.partial.content[i] as { id?: string; name?: string } | undefined;
        return [{ type: "toolcall_start", contentIndex: i, id: block?.id ?? "", toolName: block?.name ?? "" }];
      }
      case "toolcall_delta":
        return [{ type: "toolcall_delta", contentIndex: i, delta: ev.delta }];
      case "toolcall_end":
        return [{ type: "toolcall_end", contentIndex: i, toolCall: ev.toolCall }];
    }
  }

  finishDone(msg: AssistantMessage): void {
    this.flushStart();
    const reason = msg.stopReason === "length" || msg.stopReason === "toolUse" ? msg.stopReason : "stop";
    this.emit({ type: "done", reason, usage: msg.usage, ...(msg.providerThinkingLevel ? { providerThinkingLevel: msg.providerThinkingLevel } : {}) });
  }

  finishError(reason: "aborted" | "error", errorMessage: string, usage = zeroUsage()): void {
    this.emit({ type: "error", reason, errorMessage, usage });
  }
}

export class CallPipeline {
  private semaphores = new Map<string, Semaphore>();
  private breakers = new Map<string, CircuitBreaker>();
  private authNotified = new Set<string>();
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private opts: PipelineOptions) {
    this.sleep = opts.sleep ?? sleepMs;
  }

  breaker(provider: string): CircuitBreaker {
    let b = this.breakers.get(provider);
    if (!b) {
      b = new CircuitBreaker(this.opts.breakerThreshold ?? 5, this.opts.breakerOpenMs ?? 60_000);
      this.breakers.set(provider, b);
    }
    return b;
  }

  private semaphore(provider: string): Semaphore {
    let s = this.semaphores.get(provider);
    if (!s) {
      s = new Semaphore(this.opts.maxConcurrency ?? 6);
      this.semaphores.set(provider, s);
    }
    return s;
  }

  /** 凭据变更后：清熔断与鉴权告警去重，让新凭据立即生效 */
  resetProvider(provider: string): void {
    this.breakers.delete(provider);
    this.authNotified.delete(provider);
  }

  stats(): Record<string, unknown> {
    const providers: Record<string, unknown> = {};
    for (const [p, b] of this.breakers) providers[p] = { circuit: b.snapshot() };
    for (const [p, s] of this.semaphores) providers[p] = { ...(providers[p] as object), in_flight: s.inFlight, queued: s.queued };
    return providers;
  }

  /** 执行一次调用；事件经 emit 发出（恰好一个终止事件），返回最终 AssistantMessage。 */
  async run(input: CallInput, emit: Emit, signal: AbortSignal): Promise<AssistantMessage> {
    const startedAt = Date.now();
    const fwd = new Forwarder(emit);
    const { meta } = input;
    const dept = input.caller.kind === "dept" ? input.caller.dept : (meta.dept ?? "system");
    const errorMsg = (provider: string, modelId: string, text: string, reason: "error" | "aborted" = "error"): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: input.model.api ?? "unknown",
      provider,
      model: modelId,
      usage: zeroUsage(),
      stopReason: reason,
      errorMessage: text,
      timestamp: startedAt,
    });

    // 1. 受信模型
    let model: Model<Api> | undefined = this.opts.catalog?.resolve(input.model.provider, input.model.id);
    if (!model && this.opts.mode === "mock") model = mockModel(input.model);
    if (!model) {
      const text = `${ERROR_PREFIX.model}: 网关模型表中没有 ${input.model.provider}/${input.model.id}`;
      fwd.finishError("error", text);
      return errorMsg(input.model.provider, input.model.id, text);
    }

    // 2. 预算（被拒不记账：并未调用模型）
    if (!input.skipBudget) {
      const verdict = await this.opts.budget.check({ post_id: meta.post_id, trace_id: meta.trace_id, estimate_tokens: estimateContextTokens(input.context) });
      if (!verdict.allowed) {
        fwd.finishError("error", verdict.errorMessage);
        return errorMsg(model.provider, model.id, verdict.errorMessage);
      }
    }

    const finalize = (msg: AssistantMessage, ok: boolean, error?: string): AssistantMessage => {
      // 终止事件已发出；记账失败（如磁盘满）只能记日志，绝不能再向客户端发第二个终止事件
      try {
        this.opts.budget.record(meta.post_id, msg.usage?.totalTokens ?? 0);
        this.opts.recorder.record({ meta, dept, provider: model.provider, model: model.id, startedAt, message: msg, ok, error: error ? redact(error) : undefined });
      } catch (e) {
        console.error(`[gateway] 记账失败（${meta.post_id} ${meta.turn_id ?? ""}）：${(e as Error).message}`);
      }
      return msg;
    };

    // 3. mock 大脑
    if (this.opts.mode === "mock") {
      const msg = runMockBrain(input.context, meta, model);
      const aborted = await streamMessage(msg, fwd, signal, this.opts.mockEventDelayMs ?? 0, this.sleep);
      if (aborted) {
        fwd.finishError("aborted", "Request aborted by client");
        return finalize({ ...msg, stopReason: "aborted", errorMessage: "aborted" }, false, "aborted");
      }
      fwd.finishDone(msg);
      return finalize(msg, true);
    }

    // 4. 真实提供商
    const catalog = this.opts.catalog!;
    const breaker = this.breaker(model.provider);
    const circuitOpen = (): AssistantMessage => {
      const text = `${ERROR_PREFIX.circuit}: 提供商 ${model.provider} 熔断中（连续失败），约 ${Math.ceil(breaker.retryInMs() / 1000)} 秒后探活`;
      fwd.finishError("error", text);
      return finalize(errorMsg(model.provider, model.id, text), false, text);
    };
    // ticket = "probe" 表示本请求是半开探测；只有探测者才能归还探测名额
    const ticket = breaker.tryPass();
    if (!ticket) return circuitOpen();
    const releaseProbe = () => {
      if (ticket === "probe") breaker.release();
    };

    let release: () => void;
    try {
      release = await this.semaphore(model.provider).acquire(signal);
    } catch {
      releaseProbe();
      fwd.finishError("aborted", "Request aborted by client");
      return finalize(errorMsg(model.provider, model.id, "aborted", "aborted"), false, "aborted");
    }

    try {
      const auth = await catalog.authFor(model);
      if (!auth.ok) {
        releaseProbe();
        const text = redact(`${ERROR_PREFIX.auth}: 网关未配置 ${model.provider} 的凭据（请在「设置 · 模型提供商」中配置）${auth.error ? `：${auth.error}` : ""}`);
        this.notifyAuthError(model.provider, text);
        fwd.finishError("error", text);
        return finalize(errorMsg(model.provider, model.id, text), false, text);
      }
      const callOptions: SimpleStreamOptions = {
        ...input.options,
        // 只有旧式 custom / pi auth.json / 测试注入需要显式传密钥；其余由 pi 按凭据库与环境变量解析
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        sessionId: input.options.sessionId || `ses_${meta.post_id}`,
        maxRetries: 0, // 重试由网关统一负责（计入熔断）
        timeoutMs: this.opts.upstreamTimeoutMs ?? 300_000,
      };
      const maxRetries = this.opts.maxRetries ?? 4;
      for (let attempt = 0; ; attempt++) {
        const msg = await this.attempt(catalog, model, input.context, callOptions, fwd, signal);
        if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
          breaker.onSuccess();
          this.authNotified.delete(model.provider);
          fwd.finishDone(msg);
          return finalize(msg, true);
        }
        if (signal.aborted) {
          releaseProbe();
          fwd.finishError("aborted", "Request aborted by client", msg.usage);
          return finalize({ ...msg, stopReason: "aborted" }, false, "aborted");
        }
        const raw = msg.errorMessage ?? "未知错误";
        const cls = classifyError(msg, model.contextWindow);
        if (cls === "rate_limit" || cls === "transient") {
          // 熔断按「请求」计数：重试期间不计，最终失败才记一次
          if (!fwd.streamed && attempt < maxRetries && breaker.state !== "open") {
            const delay = retryDelayMs(attempt, {
              baseMs: this.opts.retryBaseMs ?? 1000,
              maxMs: this.opts.retryMaxMs ?? 30_000,
              retryAfterMs: parseRetryAfterMs(raw),
            });
            await this.sleep(delay, signal);
            continue; // 若期间客户端断开，下一轮 attempt 立即以 aborted 结束
          }
          breaker.onFailure();
          if (breaker.state === "open" && !fwd.streamed && attempt < maxRetries) return circuitOpen();
          const prefix = cls === "rate_limit" ? ERROR_PREFIX.rateLimited : ERROR_PREFIX.upstream;
          return this.failWith(fwd, finalize, msg, `${prefix}: ${raw}`);
        }
        releaseProbe();
        if (cls === "auth") {
          const text = `${ERROR_PREFIX.auth}: ${raw}`;
          this.notifyAuthError(model.provider, text);
          return this.failWith(fwd, finalize, msg, text);
        }
        if (cls === "context") return this.failWith(fwd, finalize, msg, `${ERROR_PREFIX.context}: ${raw}`);
        return this.failWith(fwd, finalize, msg, raw);
      }
    } finally {
      release();
    }
  }

  private failWith(fwd: Forwarder, finalize: (m: AssistantMessage, ok: boolean, e?: string) => AssistantMessage, msg: AssistantMessage, text: string): AssistantMessage {
    const safe = redact(text);
    fwd.finishError("error", safe, msg.usage);
    return finalize({ ...msg, errorMessage: safe }, false, safe);
  }

  /**
   * 单次上游尝试。client 信号中止 → aborted；上游 idleMs 内无任何事件 → 主动中止并当作临时错误（可重试）。
   */
  private async attempt(
    catalog: ModelCatalog,
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    fwd: Forwarder,
    clientSignal: AbortSignal,
  ): Promise<AssistantMessage> {
    const ac = new AbortController();
    const onClientAbort = () => ac.abort();
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
    if (clientSignal.aborted) ac.abort();
    const idleMs = this.opts.upstreamIdleMs ?? 120_000;
    let idleTimedOut = false;
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        idleTimedOut = true;
        ac.abort();
      }, idleMs);
    };
    const fail = (text: string): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: clientSignal.aborted ? "aborted" : "error",
      errorMessage: text,
      timestamp: Date.now(),
    });
    try {
      arm();
      const stream = catalog.models.streamSimple(model, context, { ...options, signal: ac.signal });
      for await (const ev of stream) {
        arm();
        fwd.push(ev);
      }
      const msg = await stream.result();
      if (idleTimedOut && !clientSignal.aborted) return { ...msg, stopReason: "error", errorMessage: `upstream idle timeout：${idleMs / 1000}s 内无任何数据` };
      return msg;
    } catch (e) {
      return fail(idleTimedOut ? `upstream idle timeout：${idleMs / 1000}s 内无任何数据` : (e as Error).message);
    } finally {
      if (idle) clearTimeout(idle);
      clientSignal.removeEventListener("abort", onClientAbort);
    }
  }

  private notifyAuthError(provider: string, text: string): void {
    if (this.authNotified.has(provider)) return;
    this.authNotified.add(provider);
    this.opts.recorder.event({
      type: "gateway.auth_error",
      actor: "system:gateway",
      dept: "libu",
      summary: `LLM 网关鉴权失败（${provider}）：请检查 API 密钥`,
      data: { provider, error: redact(text).slice(0, 500) },
    });
  }
}

function mockModel(ref: { provider: string; id: string; api?: string }): Model<Api> {
  return {
    id: ref.id,
    name: ref.id,
    api: ref.api ?? "openai-completions",
    provider: ref.provider,
    baseUrl: "mock://",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as Model<Api>;
}

/** 把完整 AssistantMessage 拆成逼真的流式事件（不含终止事件）。返回是否被中止。 */
async function streamMessage(
  msg: AssistantMessage,
  fwd: Forwarder,
  signal: AbortSignal,
  delayMs: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<boolean> {
  const partial: AssistantMessage = { ...msg, content: [] };
  const tick = async () => {
    if (delayMs > 0) await sleep(delayMs, signal);
    else await new Promise((r) => setImmediate(r));
    return signal.aborted;
  };
  fwd.push({ type: "start", partial });
  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i];
    partial.content.push(block);
    if (await tick()) return true;
    if (block.type === "text" || block.type === "thinking") {
      const body = block.type === "text" ? block.text : block.thinking;
      const kind = block.type;
      fwd.push({ type: `${kind}_start`, contentIndex: i, partial } as AssistantMessageEvent);
      for (const piece of chunk(body, 3)) {
        fwd.push({ type: `${kind}_delta`, contentIndex: i, delta: piece, partial } as AssistantMessageEvent);
        if (await tick()) return true;
      }
      fwd.push({ type: `${kind}_end`, contentIndex: i, content: body, partial } as AssistantMessageEvent);
    } else {
      fwd.push({ type: "toolcall_start", contentIndex: i, partial });
      for (const piece of chunk(JSON.stringify(block.arguments), 2)) {
        fwd.push({ type: "toolcall_delta", contentIndex: i, delta: piece, partial });
        if (await tick()) return true;
      }
      fwd.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial });
    }
  }
  return false;
}

function chunk(s: string, parts: number): string[] {
  const chars = [...s];
  if (chars.length === 0) return [];
  const size = Math.max(1, Math.ceil(chars.length / parts));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}
