// 驿报：全站共享的 SSE 连接（/api/stream，Last-Event-ID 由浏览器自动带上）。
// 页面通过 useCourtEvent 订阅；useQuery 通过 watch 前缀自动重取。
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CourtEvent } from "@court/shared/types";

type Listener = (e: CourtEvent) => void;

/** 进程内事件总线：SSE 与 fixtures 模拟流都往这里发 */
class EventBus {
  private listeners = new Set<Listener>();
  private seen = new Set<number>();
  /** 最近事件环形缓冲（驿报页首屏用） */
  recent: CourtEvent[] = [];
  emit(e: CourtEvent) {
    // 不入库的轻量事件（status.changed 等）id<0，hub 重启后会重复：不参与去重
    if (typeof e.id === "number" && e.id > 0) {
      if (this.seen.has(e.id)) return;
      this.seen.add(e.id);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    }
    this.recent.push(e);
    if (this.recent.length > 800) this.recent.splice(0, this.recent.length - 800);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error("事件处理出错", err);
      }
    }
  }
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
export const courtBus = new EventBus();

/** fixtures 可替换：返回关闭函数 */
let lastEventId = 0;
export const streamSource = {
  open(onEvent: (e: CourtEvent) => void, onState: (s: ConnState) => void): () => void {
    // hub：每帧 id=<事件 id>、data=单个 CourtEvent（默认 message 事件）。
    // 浏览器自动重连会带 Last-Event-ID；我们手动重开时以 ?last_event_id= 补齐断档。
    const es = new EventSource(lastEventId ? `/api/stream?last_event_id=${lastEventId}` : "/api/stream");
    const handle = (ev: MessageEvent) => {
      if (!ev.data) return;
      if (ev.lastEventId && /^\d+$/.test(ev.lastEventId)) lastEventId = Math.max(lastEventId, Number(ev.lastEventId));
      let d: unknown;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      // hub 1s 合帧：可能是单个事件、数组或 {events: []}
      const list = Array.isArray(d) ? d : d && typeof d === "object" && Array.isArray((d as { events?: unknown }).events) ? (d as { events: unknown[] }).events : [d];
      for (const x of list) if (x && typeof x === "object" && "type" in x) onEvent(x as CourtEvent);
    };
    es.onmessage = handle;
    for (const name of ["event", "events", "court"]) es.addEventListener(name, handle as EventListener);
    es.onopen = () => onState("open");
    es.onerror = () => onState(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
    return () => es.close();
  },
};

export type ConnState = "connecting" | "open" | "closed";

interface SseCtx {
  state: ConnState;
  /** 最近一次收到事件的时间 */
  lastAt: number;
}
const Ctx = createContext<SseCtx>({ state: "connecting", lastAt: 0 });

export function SseProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnState>("connecting");
  const [lastAt, setLastAt] = useState(0);
  const lastRef = useRef(0);
  useEffect(() => {
    let disposed = false;
    let current: ConnState = "connecting";
    const onEvent = (e: CourtEvent) => {
      courtBus.emit(e);
      const now = Date.now();
      // 降低重渲染频率
      if (now - lastRef.current > 1000) {
        lastRef.current = now;
        setLastAt(now);
      }
    };
    const onState = (s: ConnState) => {
      if (disposed) return;
      current = s;
      setState(s);
    };
    let close = streamSource.open(onEvent, onState);
    // EventSource 彻底关闭（如 hub 返回非 200）时每 15s 重开
    const timer = setInterval(() => {
      if (current !== "closed" || disposed) return;
      close();
      onState("connecting");
      close = streamSource.open(onEvent, onState);
    }, 15_000);
    // 离开页面即关流：否则旧文档（往返缓存/卸载中）的长连接还占着同源 6 个连接名额，新页面请求排队数秒
    const onHide = () => close();
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted || disposed) return;
      onState("connecting");
      close = streamSource.open(onEvent, onState);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      close();
    };
  }, []);
  const v = useMemo(() => ({ state, lastAt }), [state, lastAt]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useSse(): SseCtx {
  return useContext(Ctx);
}

/** 订阅事件（回调保持最新，不需进 deps） */
export function useCourtEvent(fn: (e: CourtEvent) => void, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return courtBus.on((e) => ref.current(e));
  }, [enabled]);
}

export type EventWatch = string[] | ((e: CourtEvent) => boolean);

export function matchWatch(w: EventWatch | undefined, e: CourtEvent): boolean {
  if (!w) return false;
  if (typeof w === "function") return w(e);
  return w.some((p) => p === "*" || e.type.startsWith(p));
}
