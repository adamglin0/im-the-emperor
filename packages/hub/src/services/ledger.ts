// 账本与预算：网关记账（幂等）、四级日额（global/dept/post/trace × token/成本）检查、熔断告警。
import { dayStart, newId, type Address, type Budget, type BudgetCheck, type LedgerEntry } from "@court/shared";
import { bad, forbidden, type HubCtx, type LedgerService } from "../ctx.ts";
import { controlAll } from "./doorbell.ts";
import { getMeta, setMeta } from "./registry.ts";
import type { MessageServiceExt } from "./messages.ts";

const PURPOSES: LedgerEntry["purpose"][] = ["turn", "compaction", "exam", "grading", "other"];
/** 官员上调预算超过此比例须皇帝批准 */
export const BUDGET_RAISE_APPROVAL_RATIO = 1.5;

export interface LedgerServiceExt extends LedgerService {
  budgets(): Budget[];
  budget(scope: string): Budget | undefined;
  /** 设置预算（PUT /api/budget 的核心）：皇帝直设；官员上调 >50% 走审批 */
  setBudget(
    actor: Address,
    scope: string,
    daily_tokens: number | null | undefined,
    daily_cost: number | null | undefined,
  ): Budget | { status: "pending_approval"; approval_id: string };
}

export function validateScope(ctx: HubCtx, scope: unknown): string {
  if (typeof scope !== "string" || !scope) throw bad("scope 不能为空，可选 global / dept:<部门> / post:<职位> / trace:<trace_id>");
  if (scope === "global") return scope;
  const i = scope.indexOf(":");
  const type = scope.slice(0, i);
  const id = scope.slice(i + 1);
  if (i < 0 || !id) throw bad(`scope「${scope}」格式不对`);
  if (type === "dept" && ctx.registry.dept(id)) return scope;
  if (type === "post" && ctx.registry.post(id)) return scope;
  if (type === "trace") return scope;
  throw bad(`scope「${scope}」无效：部门/职位不存在，或类型不是 dept/post/trace`);
}

function numOrNull(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${field} 必须是非负数（或 null 表示不限）`);
  return n;
}

export function createLedger(ctx: HubCtx): LedgerServiceExt {
  function getBudget(scope: string): Budget | undefined {
    return ctx.db.getJson<Budget>("SELECT data_json FROM budgets WHERE scope = ?", scope);
  }
  function writeBudget(b: Budget): void {
    ctx.db.run("INSERT INTO budgets (scope, data_json) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET data_json = excluded.data_json", b.scope, JSON.stringify(b));
  }

  function usage(scope: string, since: number): { tokens: number; cost: number } {
    let where = "ts >= ?";
    const params: (string | number)[] = [since];
    if (scope !== "global") {
      const i = scope.indexOf(":");
      const type = scope.slice(0, i);
      const id = scope.slice(i + 1);
      const col = type === "post" ? "post_id" : type === "dept" ? "dept" : type === "trace" ? "trace_id" : undefined;
      if (!col) return { tokens: 0, cost: 0 };
      where += ` AND ${col} = ?`;
      params.push(id);
    }
    const r = ctx.db.get<{ t: number | null; c: number | null }>(`SELECT SUM(total_tokens) AS t, SUM(cost) AS c FROM ledger WHERE ${where}`, ...params)!;
    return { tokens: r.t ?? 0, cost: r.c ?? 0 };
  }

  /** 首次熔断：皇帝待办 + 户部来信（每 scope 每日一次） */
  function alertOnce(scope: string, postId: string, reason: string): void {
    const day = dayStart(ctx.now());
    const key = `budget_alert:${scope}:${day}`;
    if (getMeta(ctx, key)) return;
    setMeta(ctx, key, String(ctx.now()));
    const b = getBudget(scope);
    const body =
      `${scope} 今日预算已用尽（${reason}），${postId} 的调用被拦截。\n` +
      `日额：${b?.daily_tokens ?? "不限"} tokens / ${b?.daily_cost ?? "不限"} 美元。\n` +
      `可选：增拨（今日额度翻倍）或维持（受影响官员停俸至明日）。`;
    ctx.notifications.create({
      kind: "action_required",
      category: "budget",
      title: `预算熔断：${scope}`,
      body,
      from: "system:hub",
      related: { type: "budget_scope", id: scope },
      options: [
        { id: "raise", label: "增拨（日额翻倍）" },
        { id: "keep", label: "维持" },
      ],
      dedupe_key: `budget:${scope}:${day}`,
    });
    try {
      (ctx.messages as MessageServiceExt).sendWith(
        { from: "system:hub", to: "dept:hubu", kind: "system", subject: `预算熔断：${scope}`, body, meta: { budget_scope: scope } },
        undefined,
        { allowVacant: true },
      );
    } catch {
      /* 户部无人在任时只留皇帝待办 */
    }
  }

  const self: LedgerServiceExt = {
    append(entries: LedgerEntry[]): number {
      if (!Array.isArray(entries)) throw bad("entries 必须是数组");
      if (entries.length > 1000) throw bad("单次最多 1000 条");
      let inserted = 0;
      ctx.db.tx(() => {
        for (const raw of entries) {
          if (!raw || typeof raw.idem_key !== "string" || !raw.idem_key) throw bad("每条账目必须有 idem_key");
          if (typeof raw.post_id !== "string") throw bad(`账目 ${raw.idem_key} 缺 post_id`);
          const e: LedgerEntry = {
            ...raw,
            id: raw.id || newId("lg"),
            ts: Number(raw.ts) || ctx.now(),
            official_id: raw.official_id ?? "",
            dept: raw.dept ?? ctx.registry.post(raw.post_id)?.dept ?? "",
            purpose: PURPOSES.includes(raw.purpose) ? raw.purpose : "other",
            provider: raw.provider ?? "",
            model: raw.model ?? "",
            input: Number(raw.input) || 0,
            output: Number(raw.output) || 0,
            cache_read: Number(raw.cache_read) || 0,
            cache_write: Number(raw.cache_write) || 0,
            total_tokens: Number(raw.total_tokens) || 0,
            cost: Number(raw.cost) || 0,
            duration_ms: Number(raw.duration_ms) || 0,
            ok: raw.ok !== false,
          };
          const r = ctx.db.run(
            `INSERT OR IGNORE INTO ledger (id, idem_key, ts, post_id, official_id, dept, trace_id, purpose, provider, model, total_tokens, cost, data_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            e.id,
            e.idem_key,
            e.ts,
            e.post_id,
            e.official_id,
            e.dept,
            e.trace_id ?? null,
            e.purpose,
            e.provider,
            e.model,
            e.total_tokens,
            e.cost,
            JSON.stringify(e),
          );
          inserted += r.changes;
        }
      });
      return inserted;
    },

    check(postId: string, traceId: string | undefined, estimateTokens: number): BudgetCheck {
      if (ctx.registry.isHalted()) return { allowed: false, reason: "HALTED" };
      const est = Math.max(0, Number(estimateTokens) || 0);
      const since = dayStart(ctx.now());
      const scopes: string[] = [];
      const post = ctx.registry.post(postId);
      if (post) scopes.push(`post:${postId}`, `dept:${post.dept}`);
      scopes.push("global");
      if (traceId) scopes.push(`trace:${traceId}`);
      let remaining: number | undefined;
      for (const scope of scopes) {
        const b = getBudget(scope);
        if (!b || (b.daily_tokens == null && b.daily_cost == null)) continue;
        const u = usage(scope, since);
        if (b.daily_tokens != null) {
          const left = b.daily_tokens - u.tokens;
          remaining = remaining === undefined ? left : Math.min(remaining, left);
          if (u.tokens + est > b.daily_tokens) {
            const reason = `BUDGET_EXCEEDED: ${scope}`;
            ctx.db.tx(() => alertOnce(scope, postId, `token ${u.tokens}+${est} > ${b.daily_tokens}`));
            return { allowed: false, reason, scope, remaining_tokens: Math.max(0, left) };
          }
        }
        if (b.daily_cost != null && u.cost >= b.daily_cost) {
          ctx.db.tx(() => alertOnce(scope, postId, `成本 ${u.cost.toFixed(4)} ≥ ${b.daily_cost}`));
          return { allowed: false, reason: `BUDGET_EXCEEDED: ${scope}`, scope, remaining_tokens: remaining === undefined ? undefined : Math.max(0, remaining) };
        }
      }
      const res: BudgetCheck = { allowed: true };
      if (remaining !== undefined) res.remaining_tokens = Math.max(0, remaining);
      return res;
    },

    usageToday(scope: string): { tokens: number; cost: number } {
      return usage(scope, dayStart(ctx.now()));
    },

    budgets(): Budget[] {
      return ctx.db.allJson<Budget>("SELECT data_json FROM budgets ORDER BY scope LIMIT 2000");
    },
    budget: getBudget,

    setBudget(actor, scopeIn, tokensIn, costIn) {
      const scope = validateScope(ctx, scopeIn);
      const daily_tokens = numOrNull(tokensIn, "daily_tokens");
      const daily_cost = numOrNull(costIn, "daily_cost");
      if (daily_tokens === undefined && daily_cost === undefined) throw bad("daily_tokens 与 daily_cost 至少给一个");
      const prev = getBudget(scope);
      const next: Budget = {
        scope,
        updated_by: actor,
        updated_at: ctx.now(),
      };
      const t = daily_tokens === undefined ? prev?.daily_tokens : daily_tokens ?? undefined;
      const c = daily_cost === undefined ? prev?.daily_cost : daily_cost ?? undefined;
      if (t != null) next.daily_tokens = t;
      if (c != null) next.daily_cost = c;
      if (actor !== "emperor" && !actor.startsWith("system:")) {
        // 上调超过 50%（或取消限额）须皇帝批准
        const raised = (old: number | undefined, nw: number | undefined) =>
          old != null && (nw == null || nw > old * BUDGET_RAISE_APPROVAL_RATIO);
        if (raised(prev?.daily_tokens, next.daily_tokens) || raised(prev?.daily_cost, next.daily_cost)) {
          const a = ctx.approvals.request(
            "budget",
            { scope, daily_tokens: next.daily_tokens ?? null, daily_cost: next.daily_cost ?? null, actor },
            actor,
            `上调预算 ${scope}`,
            `${actor} 申请把 ${scope} 日额由 ${prev?.daily_tokens ?? "不限"} tokens / ${prev?.daily_cost ?? "不限"} 美元` +
              ` 调整为 ${next.daily_tokens ?? "不限"} tokens / ${next.daily_cost ?? "不限"} 美元（超过 50%，须陛下批准）。`,
          );
          return { status: "pending_approval", approval_id: a.id };
        }
      }
      return ctx.db.tx(() => {
        writeBudget(next);
        ctx.events.emit({ type: "budget.set", actor, subject_type: "budget", subject_id: scope, summary: `预算 ${scope}：${next.daily_tokens ?? "不限"} tokens / ${next.daily_cost ?? "不限"} 美元` });
        return next;
      });
    },
  };

  ctx.approvals.onApprove("budget", (a) => {
    const p = a.payload as { scope: string; daily_tokens: number | null; daily_cost: number | null };
    // 以皇帝身份落实（不再触发审批）
    // payload 存的是合并后的完整值（null = 不限）
    const next: Budget = { scope: p.scope, updated_by: a.requested_by, updated_at: ctx.now() };
    if (p.daily_tokens != null) next.daily_tokens = p.daily_tokens;
    if (p.daily_cost != null) next.daily_cost = p.daily_cost;
    writeBudget(next);
    ctx.events.emit({ type: "budget.set", actor: "emperor", subject_type: "budget", subject_id: p.scope, summary: `准奏调整预算 ${p.scope}` });
  });

  // 预算一变（官员核定 / 准奏 / 增拨）即通知各部：停俸者立即复查，不必等 10 分钟
  ctx.events.subscribe((e) => {
    if (e.type === "budget.set") controlAll(ctx, "/control/budget", {});
  });

  // 熔断待办「增拨」：当日额度翻倍
  ctx.notifications.onResolve("budget", (n, option) => {
    if (n.related?.type !== "budget_scope" || option !== "raise") return;
    const b = getBudget(n.related.id);
    if (!b) return;
    const next: Budget = { ...b, updated_by: "emperor", updated_at: ctx.now() };
    if (b.daily_tokens != null) next.daily_tokens = b.daily_tokens * 2;
    if (b.daily_cost != null) next.daily_cost = b.daily_cost * 2;
    writeBudget(next);
    ctx.events.emit({ type: "budget.set", actor: "emperor", subject_type: "budget", subject_id: b.scope, summary: `增拨预算 ${b.scope}（日额翻倍）` });
  });

  return self;
}

/** 预算设置权限：皇帝任意；官员需 budget_set 工具（路由层校验） */
export function assertBudgetActor(actor: Address): void {
  if (actor !== "emperor" && !actor.startsWith("post:") && !actor.startsWith("system:")) throw forbidden(`actor ${actor} 无权设置预算`);
}
