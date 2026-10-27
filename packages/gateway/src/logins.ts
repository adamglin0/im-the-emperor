// 提供商登录会话：驱动 pi provider 自带的登录流程（api-key 提示、OAuth 授权链接/设备码/回填授权码）。
// 前端轮询会话状态，遇到 awaiting_input 时作答。会话只在内存，网关重启即失效。
import type { AuthEvent, AuthPrompt, LoginOptions, MutableModels } from "@earendil-works/pi-ai";
import { newId, redact, type ProviderAuthType, type ProviderLoginEvent, type ProviderLoginSession } from "@court/shared";

const SESSION_TTL_MS = 15 * 60_000; // 单次登录最长时长
const KEEP_FINISHED_MS = 10 * 60_000; // 结束后保留供前端读取
const MAX_SESSIONS = 20;
const MAX_EVENTS = 50;

interface Live {
  s: ProviderLoginSession;
  ac: AbortController;
  pending?: { seq: number; resolve: (v: string) => void; reject: (e: unknown) => void };
  timer: NodeJS.Timeout;
}

export class LoginError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export class LoginManager {
  private sessions = new Map<string, Live>();
  private seq = 0;

  constructor(
    private models: MutableModels,
    private hooks: { onDone?: (provider: string, type: ProviderAuthType) => void | Promise<void>; loginOptions?: LoginOptions } = {},
  ) {}

  start(providerId: string, type: ProviderAuthType): ProviderLoginSession {
    this.gc();
    const p = this.models.getProvider(providerId);
    if (!p) throw new LoginError(404, `没有提供商 ${providerId}`);
    const method = type === "oauth" ? p.auth.oauth : p.auth.apiKey;
    if (!method?.login) throw new LoginError(400, `${p.name} 不支持${type === "oauth" ? " OAuth 登录" : "填写 API 密钥"}`);
    const running = [...this.sessions.values()].find((l) => l.s.provider === providerId && (l.s.state === "running" || l.s.state === "awaiting_input"));
    if (running) this.cancel(running.s.id);
    if ([...this.sessions.values()].filter((l) => l.s.state === "running" || l.s.state === "awaiting_input").length >= MAX_SESSIONS)
      throw new LoginError(429, "进行中的登录会话过多，请稍后");

    const s: ProviderLoginSession = { id: newId("lg"), provider: providerId, type, state: "running", events: [], started_at: Date.now() };
    const ac = new AbortController();
    const live: Live = { s, ac, timer: setTimeout(() => ac.abort(new Error("登录超时")), SESSION_TTL_MS) };
    live.timer.unref();
    this.sessions.set(s.id, live);
    // 会话中止（取消/超时）时撤销待答提示，免得 provider 的登录流程永远挂在 prompt 上
    ac.signal.addEventListener(
      "abort",
      () => {
        const pending = live.pending;
        live.pending = undefined;
        pending?.reject(ac.signal.reason);
      },
      { once: true },
    );

    const pushEvent = (e: ProviderLoginEvent) => {
      s.events.push(e);
      if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    };
    const interaction = {
      signal: ac.signal,
      prompt: (p: AuthPrompt): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          if (ac.signal.aborted) return reject(ac.signal.reason);
          if (p.signal?.aborted) return reject(p.signal.reason);
          const seq = ++this.seq;
          live.pending = { seq, resolve, reject };
          s.state = "awaiting_input";
          s.prompt = {
            seq,
            type: p.type,
            message: p.message,
            ...("placeholder" in p && p.placeholder ? { placeholder: p.placeholder } : {}),
            ...(p.type === "select" ? { options: p.options.map((o) => ({ id: o.id, label: o.label, description: o.description })) } : {}),
          };
          // 带外事件（如 OAuth 回调先到）撤销此提示
          p.signal?.addEventListener(
            "abort",
            () => {
              if (live.pending?.seq !== seq) return;
              live.pending = undefined;
              s.prompt = undefined;
              if (s.state === "awaiting_input") s.state = "running";
              reject(p.signal?.reason ?? new Error("提示已撤销"));
            },
            { once: true },
          );
        }),
      notify: (e: AuthEvent) => {
        const at = Date.now();
        if (e.type === "info") pushEvent({ at, type: "info", message: e.message, links: e.links?.map((l) => ({ url: l.url, label: l.label })) });
        else if (e.type === "auth_url") pushEvent({ at, type: "auth_url", url: e.url, instructions: e.instructions });
        else if (e.type === "device_code") pushEvent({ at, type: "device_code", user_code: e.userCode, verification_uri: e.verificationUri });
        else if (e.type === "progress") pushEvent({ at, type: "progress", message: e.message });
      },
    };

    void this.models
      .login(providerId, type, interaction, this.hooks.loginOptions)
      .then(async () => {
        s.state = "done";
        try {
          await this.hooks.onDone?.(providerId, type);
        } catch {
          /* 登录已成功；后续刷新失败不影响 */
        }
      })
      .catch((err: unknown) => {
        if (s.state === "cancelled") return;
        s.state = ac.signal.aborted && !(ac.signal.reason instanceof Error && ac.signal.reason.message === "登录超时") ? "cancelled" : "error";
        s.error = describe(err);
      })
      .finally(() => {
        clearTimeout(live.timer);
        live.pending = undefined;
        s.prompt = undefined;
        s.finished_at = Date.now();
      });
    return snapshot(s);
  }

  get(id: string): ProviderLoginSession {
    const live = this.sessions.get(id);
    if (!live) throw new LoginError(404, `没有登录会话 ${id}（或已过期）`);
    return snapshot(live.s);
  }

  answer(id: string, seq: number, value: string): ProviderLoginSession {
    const live = this.sessions.get(id);
    if (!live) throw new LoginError(404, `没有登录会话 ${id}（或已过期）`);
    if (live.s.state !== "awaiting_input" || !live.pending) throw new LoginError(409, "该会话当前不需要输入");
    if (live.pending.seq !== seq) throw new LoginError(409, "提示已更新，请按最新提示作答");
    if (typeof value !== "string" || value.length > 16_384) throw new LoginError(400, "输入须为字符串且不超过 16KB");
    const { resolve } = live.pending;
    live.pending = undefined;
    live.s.prompt = undefined;
    live.s.state = "running";
    resolve(value);
    return snapshot(live.s);
  }

  cancel(id: string): ProviderLoginSession {
    const live = this.sessions.get(id);
    if (!live) throw new LoginError(404, `没有登录会话 ${id}（或已过期）`);
    if (live.s.state === "running" || live.s.state === "awaiting_input") {
      live.s.state = "cancelled";
      live.pending?.reject(new Error("已取消"));
      live.pending = undefined;
      live.s.prompt = undefined;
      live.ac.abort(new Error("已取消"));
      live.s.finished_at = Date.now();
    }
    return snapshot(live.s);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.cancel(id);
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, l] of this.sessions) if (l.s.finished_at && now - l.s.finished_at > KEEP_FINISHED_MS) this.sessions.delete(id);
  }
}

function snapshot(s: ProviderLoginSession): ProviderLoginSession {
  return structuredClone(s);
}

function describe(err: unknown): string {
  const e = err as Error & { cause?: unknown };
  const msg = e?.message ?? String(err);
  const cause = e?.cause instanceof Error ? `：${e.cause.message}` : "";
  return redact(`${msg}${cause}`).slice(0, 500);
}
