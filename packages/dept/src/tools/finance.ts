// 户部·账本与预算工具
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LedgerEntry } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { ToolError, defineTool, fmtTime, ok, selfAddr, writeMeta } from "./_util.ts";

const GROUPS = ["dept", "post", "model", "trace", "hour", "official", "purpose"] as const;

export const usd = (n: number) => Math.round(n * 10000) / 10000;

/** 账目汇总：总计 + 按某字段分组 */
export function ledgerTotals(entries: LedgerEntry[], by: keyof LedgerEntry) {
  const total = { calls: 0, tokens: 0, cost: 0, errors: 0 };
  const groups: Record<string, { calls: number; tokens: number; cost: number }> = {};
  for (const e of entries) {
    total.calls++;
    total.tokens += e.total_tokens;
    total.cost += e.cost;
    if (!e.ok) total.errors++;
    const k = String(e[by] ?? "—");
    const g = (groups[k] ??= { calls: 0, tokens: 0, cost: 0 });
    g.calls++;
    g.tokens += e.total_tokens;
    g.cost += e.cost;
  }
  total.cost = usd(total.cost);
  for (const g of Object.values(groups)) g.cost = usd(g.cost);
  return { total, groups };
}

export function financeTools(ctx: ToolContext): AgentTool<any>[] {
  const self = selfAddr(ctx);
  return [
    defineTool({
      name: "ledger_report",
      label: "账目汇总",
      description: "按维度汇总 LLM 用量账本（调用次数、输入/输出 token、总 token、成本 USD）：dept 部门 / post 职位 / model 模型 / trace 事务 / hour 小时 / official 官员 / purpose 用途。默认近 24 小时。",
      parameters: Type.Object({
        group: StringEnum(GROUPS, { description: "汇总维度" }),
        since_hours: Type.Optional(Type.Number({ minimum: 0.1, maximum: 24 * 90, description: "统计最近多少小时，默认 24" })),
      }),
      async run(p) {
        const h = p.since_hours ?? 24;
        const rows = await ctx.hub.ledgerSummary({ group: p.group, since: Date.now() - h * 3600_000 });
        const sorted = [...rows].sort((a, b) => b.cost - a.cost || b.total_tokens - a.total_tokens);
        const tot = sorted.reduce((a, r) => ({ tokens: a.tokens + r.total_tokens, cost: a.cost + r.cost }), { tokens: 0, cost: 0 });
        return ok(
          `近 ${h} 小时按 ${p.group} 汇总：${sorted.length} 项，合计 ${tot.tokens} tokens / $${usd(tot.cost)}`,
          sorted.slice(0, 60).map((r) => ({ key: r.key, calls: r.calls, input: r.input, output: r.output, tokens: r.total_tokens, cost: usd(r.cost) })),
          sorted.length > 60 ? { hint: "仅显示前 60 项（按成本降序）。" } : undefined,
        );
      },
    }),

    defineTool({
      name: "ledger_by_trace",
      label: "事务账目",
      description: "查看某事务（trace/诏令）的全部 LLM 花费：合计、按职位与按模型分组、失败调用数。用于核算一道诏令的成本。",
      parameters: Type.Object({ trace_id: Type.String({ description: "trace ID（诏令 ID 即其 trace）" }) }),
      async run(p) {
        const entries = [...(await ctx.hub.ledger({ trace_id: p.trace_id, limit: 1000 }))].sort((a, b) => a.ts - b.ts);
        const byPost = ledgerTotals(entries, "post_id");
        const byModel = ledgerTotals(entries, "model");
        return ok(`trace ${p.trace_id}：${byPost.total.calls} 次调用，${byPost.total.tokens} tokens，$${byPost.total.cost}`, {
          total: byPost.total,
          by_post: byPost.groups,
          by_model: byModel.groups,
          first: fmtTime(entries[0]?.ts),
          last: fmtTime(entries[entries.length - 1]?.ts),
        });
      },
    }),

    defineTool({
      name: "budget_get",
      label: "预算一览",
      description: "查看各级预算（全局 global / 部门 dept:x / 职位 post:x / 诏令 trace:x 的日额 token 与成本）及今日已用。",
      parameters: Type.Object({}),
      async run() {
        const s = await ctx.hub.budgetStatus();
        return ok(
          `预算 ${s.budgets.length} 项`,
          s.budgets.map((b) => ({
            scope: b.scope,
            daily_tokens: b.daily_tokens,
            daily_cost: b.daily_cost,
            used_tokens: s.usage_today[b.scope]?.tokens ?? 0,
            used_cost: usd(s.usage_today[b.scope]?.cost ?? 0),
            updated_by: b.updated_by,
            updated: fmtTime(b.updated_at),
          })),
        );
      },
    }),

    defineTool({
      name: "budget_set",
      label: "核定预算",
      description:
        "设定某范围的日预算（token 与/或成本 USD）。scope：global、dept:<部门ID>、post:<职位ID>、trace:<诏令ID>。" +
        "上调超过阈值须皇帝批准（返回 pending_approval）。须写明理由（依据用量与任务需要）。",
      parameters: Type.Object({
        scope: Type.String({ description: "预算范围：global / dept:x / post:x / trace:x" }),
        daily_tokens: Type.Optional(Type.Integer({ minimum: 0, description: "每日 token 上限" })),
        daily_cost: Type.Optional(Type.Number({ minimum: 0, description: "每日成本上限（USD）" })),
        reason: Type.String({ description: "理由" }),
      }),
      async run(p, call) {
        if (!/^(global|dept:.+|post:.+|trace:.+)$/.test(p.scope)) throw new ToolError(`scope 格式不对：${p.scope}`, "应为 global / dept:x / post:x / trace:x。");
        if (p.daily_tokens === undefined && p.daily_cost === undefined) throw new ToolError("daily_tokens 与 daily_cost 至少给一个");
        // reason 不在契约字段中，作为附加字段一并提交（hub 可记入审计）
        const body = { ...writeMeta(ctx, call.toolCallId), actor: self, scope: p.scope, daily_tokens: p.daily_tokens, daily_cost: p.daily_cost, reason: p.reason };
        const r = await ctx.hub.setBudget(body);
        ctx.log("budget_set", { scope: p.scope, daily_tokens: p.daily_tokens, daily_cost: p.daily_cost, reason: p.reason });
        if ("status" in r && r.status === "pending_approval") {
          return ok(`预算调整已提交皇帝审批（approval_id ${r.approval_id}）`, r, { hint: "审批结果会通知你。" });
        }
        return ok(`已核定 ${p.scope} 预算`, r);
      },
    }),
  ];
}
