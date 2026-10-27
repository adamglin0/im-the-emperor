// 极简数据获取：首取 + 事件驱动重取（watch 前缀，800ms 去抖）+ 轮询兜底
// （SSE 断开时每 10s；连接正常时按 interval，默认 60s）。不引入 react-query。
import { useCallback, useEffect, useRef, useState } from "react";
import { isUnavailable } from "../api/client.ts";
import { courtBus, matchWatch, useSse, type EventWatch } from "../api/events.tsx";
import { markBackend } from "./backend.ts";

export interface QueryOpts {
  /** 事件类型前缀（如 ["edict.", "task."]）或判定函数；命中则重取 */
  watch?: EventWatch;
  /** SSE 正常时的轮询间隔（ms），0 关闭；默认 60s */
  interval?: number;
  /** false 时不发请求 */
  enabled?: boolean;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** 首次加载中（尚无数据） */
  initial: boolean;
  reload: () => void;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[], opts: QueryOpts = {}): QueryResult<T> {
  const { watch, interval = 60_000, enabled = true } = opts;
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState<boolean>(enabled);
  const reqId = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const { state } = useSse();

  const run = useCallback(() => {
    if (!enabled) return;
    const id = ++reqId.current;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (id !== reqId.current) return;
        setDataState(d);
        setError(undefined);
        markBackend(true);
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setError(e);
        if (isUnavailable(e)) markBackend(false);
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  // 依赖变化：清空旧数据并重取
  useEffect(() => {
    setDataState(undefined);
    setError(undefined);
    run();
  }, [run]);

  // 事件驱动
  useEffect(() => {
    if (!enabled) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = courtBus.on((e) => {
      if (!matchWatch(watchRef.current, e)) return;
      if (t) return;
      t = setTimeout(() => {
        t = undefined;
        run();
      }, 800);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [run, enabled]);

  // 轮询兜底
  useEffect(() => {
    if (!enabled) return;
    const ms = state === "open" ? interval : 10_000;
    if (!ms) return;
    const h = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, ms);
    return () => clearInterval(h);
  }, [run, state, interval, enabled]);

  const setData = useCallback((f: (d: T | undefined) => T | undefined) => setDataState((d) => f(d)), []);
  return { data, error, loading, initial: loading && data === undefined && !error, reload: run, setData };
}
