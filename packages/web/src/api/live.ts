// 官员实时数据（hub 代理到部门容器）：/api/live/:post/{stream,context,log,wake,compact}
// 契约见 design §6.2 部门 API；hub 以 /api/live/:post/* 透传。
import { ApiError } from "@court/shared/api";

export interface LiveContext {
  system_prompt: string;
  messages: unknown[];
  context_tokens: number;
}
export type LogLine = Record<string, unknown> & { ts?: number; type?: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ApiError(503, "unavailable", `无法连接 ${path}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.code ?? "internal", data?.error ?? res.statusText);
  return data as T;
}

/** 部门 /officials/:post/stream 推送的具名事件（见 packages/dept official.ts live.publish） */
const LIVE_EVENT_NAMES = [
  "status",
  "state",
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
  "tool_start",
  "tool_end",
  "user_message",
  "llm_end",
  "message_out",
  "compact",
  // 兼容旧/其他实现
  "delta",
  "thinking",
  "text",
  "tool",
  "event",
  "agent",
];

/** 可被 fixtures 替换的实时客户端 */
export const live = {
  context: (post: string) => call<LiveContext>("GET", `/api/live/${post}/context`),
  log: (post: string, q?: { date?: string; tail?: number }) => {
    const p = new URLSearchParams();
    if (q?.date) p.set("date", q.date);
    if (q?.tail) p.set("tail", String(q.tail));
    const s = p.toString();
    return call<LogLine[]>("GET", `/api/live/${post}/log${s ? `?${s}` : ""}`);
  },
  wake: (post: string, reason = "皇帝唤醒") => call<{ ok: true }>("POST", `/api/live/${post}/wake`, { reason }),
  compact: (post: string) => call<{ ok: true }>("POST", `/api/live/${post}/compact`, {}),
  /**
   * 实时思考流。返回关闭函数。onData 收到解析后的 JSON（或原始字符串）。
   * 部门以具名 SSE 事件推送（event: <type>，data: {type, post, ts, data}），
   * 具名事件不会触发 onmessage，故须逐一监听；ping 为心跳，忽略。
   */
  stream: (post: string, onData: (d: unknown) => void, onState?: (open: boolean) => void): (() => void) => {
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const handle = (ev: MessageEvent) => {
      if (ev.type === "ping" || typeof ev.data !== "string") return;
      let d: unknown = ev.data;
      try {
        d = JSON.parse(ev.data);
      } catch {
        /* 原样 */
      }
      if (ev.type !== "message" && d && typeof d === "object" && !("type" in (d as object))) (d as Record<string, unknown>).type = ev.type;
      onData(d);
    };
    const open = () => {
      const cur = new EventSource(`/api/live/${encodeURIComponent(post)}/stream`);
      es = cur;
      cur.onmessage = handle;
      for (const name of LIVE_EVENT_NAMES) cur.addEventListener(name, handle as EventListener);
      cur.onopen = () => onState?.(true);
      cur.onerror = () => {
        onState?.(false);
        // hub 返回非 200（部门不可达 503、官员空缺 404）时 EventSource 不会自动重连：10s 后重开
        if (cur.readyState === EventSource.CLOSED && !closed && !retry) {
          retry = setTimeout(() => {
            retry = undefined;
            if (!closed) open();
          }, 10_000);
        }
      };
    };
    open();
    // 离开页面即关流，返回（往返缓存恢复）再开：不让旧文档的长连接占住同源连接名额
    const onHide = () => es?.close();
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && !closed) open();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      es?.close();
    };
  },
};
