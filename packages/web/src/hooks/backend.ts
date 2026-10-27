// 后端可达性：任一查询因连接失败报错 → 标记失联；任一成功 → 恢复。顶栏横幅订阅它。
import { useSyncExternalStore } from "react";

let down = false;
let since = 0;
const subs = new Set<() => void>();

export function markBackend(ok: boolean) {
  const next = !ok;
  if (next === down) return;
  down = next;
  since = Date.now();
  for (const s of subs) s();
}

export function useBackendDown(): { down: boolean; since: number } {
  const d = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => down,
  );
  return { down: d, since };
}
