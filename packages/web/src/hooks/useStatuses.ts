// 百官状态：首取 + 轮询兜底；hub 心跳推来的 status.changed（不入库的轻量事件）就地改写对应官员状态。
import type { OfficialState, OfficialStatus } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { useCourtEvent } from "../api/events.tsx";
import { useQuery } from "./useQuery.ts";

export function useStatuses(interval = 15_000) {
  const q = useQuery(() => hub.statuses(), [], { watch: ["turn.", "court.halt", "personnel.", "config.changed"], interval });
  useCourtEvent((e) => {
    if (e.type !== "status.changed" || !e.actor.startsWith("post:")) return;
    const post = e.actor.slice(5);
    const to = e.data?.to as OfficialState | undefined;
    if (!to) return;
    const text = (e.data?.status_text as string | null | undefined) ?? undefined;
    if (!q.data) return;
    if (!q.data.some((s) => s.post_id === post)) {
      q.reload(); // 新上线的官员：整表重取
      return;
    }
    q.setData((list) => list?.map((s): OfficialStatus => (s.post_id === post ? { ...s, state: to, status_text: text, updated_at: e.ts } : s)));
  });
  return q;
}
