import { useEffect, useState } from "react";

/** 每 interval 毫秒刷新一次的「当前时间」，用于相对时间显示 */
export function useNow(interval = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(h);
  }, [interval]);
  return now;
}
