// 预算闸门：调用前向 hub 预检；决策按职位缓存 10s；hub 不可达时放行，但受本地每职位速率上限约束。
import { ApiError, type BudgetCheck, type HubClient } from "@court/shared";

export type BudgetVerdict = { allowed: true } | { allowed: false; errorMessage: string };

export interface BudgetGateOptions {
  hub?: HubClient;
  cacheMs?: number;
  /** hub 不可达时每职位窗口内 token 上限 */
  failOpenTokens?: number;
  failOpenWindowMs?: number;
  /** hub 不可达后多久再探（毫秒），默认 5000 */
  hubRetryMs?: number;
  now?: () => number;
}

export const BUDGET_PREFIX = "BUDGET_EXCEEDED";
export const HALTED_PREFIX = "HALTED";

export class BudgetGate {
  private cache = new Map<string, { at: number; verdict: BudgetVerdict }>();
  private usage = new Map<string, { at: number; tokens: number }[]>();
  private now: () => number;
  private hubDownUntil = 0;
  hubReachable = true;

  constructor(private opts: BudgetGateOptions) {
    this.now = opts.now ?? Date.now;
  }

  async check(req: { post_id: string; trace_id?: string; estimate_tokens: number }): Promise<BudgetVerdict> {
    const key = `${req.post_id}|${req.trace_id ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < (this.opts.cacheMs ?? 10_000)) return hit.verdict;
    if (!this.opts.hub || this.now() < this.hubDownUntil) return this.localCheck(req.post_id, req.estimate_tokens);
    this.sweep();
    let verdict: BudgetVerdict;
    try {
      const res: BudgetCheck = await this.opts.hub.budgetCheck(req);
      this.hubReachable = true;
      verdict = res.allowed ? { allowed: true } : { allowed: false, errorMessage: denialMessage(res) };
    } catch (e) {
      if (e instanceof ApiError && e.code === "halted") verdict = { allowed: false, errorMessage: `${HALTED_PREFIX}: ${e.message}` };
      else if (e instanceof ApiError && e.code === "budget_exceeded") verdict = { allowed: false, errorMessage: `${BUDGET_PREFIX}: ${e.message}` };
      else {
        // hub 不可达或内部错误：放行（不缓存决策），以本地速率兜底；数秒内不再探 hub，避免每次调用都等超时
        this.hubReachable = false;
        this.hubDownUntil = this.now() + (this.opts.hubRetryMs ?? 5000);
        if (e instanceof ApiError && e.status === 401) console.error("[gateway] hub 拒绝网关 token（401），预算预检暂以本地限额兜底：请检查 GATEWAY_TOKEN");
        return this.localCheck(req.post_id, req.estimate_tokens);
      }
    }
    this.cache.set(key, { at: this.now(), verdict });
    return verdict;
  }

  /** 记录实际用量（供 fail-open 本地限额） */
  record(postId: string, tokens: number): void {
    const list = this.prune(postId);
    list.push({ at: this.now(), tokens });
  }

  /** 清理过期缓存（每轮新 trace 都会产生新键） */
  private sweep(): void {
    if (this.cache.size < 2000) return;
    const cutoff = this.now() - (this.opts.cacheMs ?? 10_000);
    for (const [k, v] of this.cache) if (v.at < cutoff) this.cache.delete(k);
    for (const k of this.usage.keys()) if (!this.prune(k).length) this.usage.delete(k);
  }

  private localCheck(postId: string, estimate: number): BudgetVerdict {
    const cap = this.opts.failOpenTokens ?? 200_000;
    const used = this.prune(postId).reduce((s, x) => s + x.tokens, 0);
    if (used + estimate > cap) {
      const mins = Math.round((this.opts.failOpenWindowMs ?? 600_000) / 60_000);
      return { allowed: false, errorMessage: `${BUDGET_PREFIX}: 户部（hub）暂不可达，网关本地限额 ${cap} tokens/${mins} 分钟已用尽（已用 ${used}），请稍后再试` };
    }
    return { allowed: true };
  }

  private prune(postId: string): { at: number; tokens: number }[] {
    const cutoff = this.now() - (this.opts.failOpenWindowMs ?? 600_000);
    const list = (this.usage.get(postId) ?? []).filter((x) => x.at >= cutoff);
    this.usage.set(postId, list);
    return list;
  }
}

function denialMessage(res: BudgetCheck): string {
  const reason = res.reason ?? "预算不足";
  const halted = res.scope === "halted" || /罢朝|halt/i.test(reason);
  return halted ? `${HALTED_PREFIX}: ${reason}` : `${BUDGET_PREFIX}: ${reason}${res.scope ? `（${res.scope}）` : ""}`;
}
