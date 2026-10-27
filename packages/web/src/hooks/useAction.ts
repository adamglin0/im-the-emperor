// 写操作：带 pending 状态与成败提示
import { useCallback, useState } from "react";
import { errorText } from "../api/client.ts";
import { useToast } from "../components/Toast.tsx";

export function useAction() {
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      setPending(true);
      try {
        const r = await fn();
        if (okText) toast(okText, "ok");
        return r;
      } catch (e) {
        toast(errorText(e), "bad");
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [toast],
  );
  return { run, pending };
}
