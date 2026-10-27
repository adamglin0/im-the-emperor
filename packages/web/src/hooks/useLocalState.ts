import { useEffect, useState } from "react";

/** 存 localStorage 的偏好（读写失败时退化为内存） */
export function useLocalState<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? init : (JSON.parse(s) as T);
    } catch {
      return init;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* 忽略 */
    }
  }, [key, v]);
  return [v, setV];
}
