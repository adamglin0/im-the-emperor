// 幂等：同一 idem_key 的写操作只生效一次，重放返回首次结果。
import type { HubCtx, IdempotencyService } from "../ctx.ts";

const MAX_KEY_LEN = 300;

export function createIdempotency(ctx: HubCtx): IdempotencyService {
  return {
    wrap<T>(key: string | undefined, fn: () => T): T {
      if (!key) return fn();
      const k = String(key).slice(0, MAX_KEY_LEN);
      return ctx.db.tx(() => {
        const hit = ctx.db.get<{ result_json: string }>("SELECT result_json FROM idempotency WHERE key = ?", k);
        if (hit) return JSON.parse(hit.result_json) as T;
        const result = fn();
        ctx.db.run(
          "INSERT OR REPLACE INTO idempotency (key, result_json, status, at) VALUES (?, ?, ?, ?)",
          k,
          JSON.stringify(result ?? null),
          200,
          ctx.now(),
        );
        return result;
      });
    },
  };
}
