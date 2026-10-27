// 账本与预算。
import type { Hono } from "hono";
import { dayStart, type BudgetCheckReq, type BudgetStatus, type LedgerEntry, type LedgerSummaryRow, type LedgerTraceUsage } from "@court/shared";
import { bad, forbidden, type HubCtx } from "../ctx.ts";
import { actingAddress, principal, queryInt, readJson, requireGateway, requireTool } from "../auth.ts";
import type { LedgerServiceExt } from "../services/ledger.ts";

const GROUP_COL: Record<string, string> = {
  dept: "dept",
  post: "post_id",
  model: "model",
  trace: "COALESCE(trace_id, '')",
  official: "official_id",
  purpose: "purpose",
  // 北京时间整点
  hour: "((ts + 28800000) / 3600000) * 3600000 - 28800000",
};
const FILTER_COL: Record<string, string> = { dept: "dept", post: "post_id", trace: "trace_id", model: "model", official: "official_id", purpose: "purpose" };

function fmtHour(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.toISOString().slice(0, 13).replace("T", " ")}:00`;
}

export function register(app: Hono, ctx: HubCtx): void {
  const ledger = () => ctx.ledger as LedgerServiceExt;

  app.post("/api/ledger", async (c) => {
    requireGateway(c);
    const body = await readJson<{ entries?: LedgerEntry[] }>(c);
    if (!Array.isArray(body.entries)) throw bad("entries 必须是数组");
    return c.json({ ok: true as const, inserted: ctx.ledger.append(body.entries) });
  });

  app.get("/api/ledger", (c) => {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const post = c.req.query("post");
    if (post) {
      where.push("post_id = ?");
      params.push(post.startsWith("post:") ? post.slice(5) : post);
    }
    const trace = c.req.query("trace_id");
    if (trace) {
      where.push("trace_id = ?");
      params.push(trace);
    }
    const since = c.req.query("since");
    if (since) {
      where.push("ts >= ?");
      params.push(queryInt(c, "since", 0, 0));
    }
    const limit = queryInt(c, "limit", 200, 1, 1000);
    const sql = `SELECT data_json FROM ledger ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`;
    return c.json(ctx.db.allJson<LedgerEntry>(sql, ...params, limit));
  });

  // 某 trace 的用量合计：SQL 聚合，无条数上限（诏令调查页用）
  app.get("/api/ledger/trace/:id", (c) => {
    const traceId = c.req.param("id");
    const tot = ctx.db.get<{ calls: number; input: number | null; output: number | null; t: number | null; c: number | null }>(
      `SELECT COUNT(*) AS calls, SUM(json_extract(data_json, '$.input')) AS input, SUM(json_extract(data_json, '$.output')) AS output,
              SUM(total_tokens) AS t, SUM(cost) AS c FROM ledger WHERE trace_id = ?`,
      traceId,
    )!;
    const byPost = ctx.db.all<{ post_id: string; dept: string; calls: number; t: number | null; c: number | null }>(
      `SELECT post_id, MAX(dept) AS dept, COUNT(*) AS calls, SUM(total_tokens) AS t, SUM(cost) AS c
       FROM ledger WHERE trace_id = ? GROUP BY post_id ORDER BY t DESC`,
      traceId,
    );
    const byTurn = ctx.db.all<{ turn_id: string; post_id: string; first_ts: number; last_ts: number; calls: number; t: number | null; c: number | null }>(
      `SELECT COALESCE(json_extract(data_json, '$.turn_id'), '') AS turn_id, post_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
              COUNT(*) AS calls, SUM(total_tokens) AS t, SUM(cost) AS c
       FROM ledger WHERE trace_id = ? GROUP BY turn_id, post_id ORDER BY first_ts ASC LIMIT 5000`,
      traceId,
    );
    const out: LedgerTraceUsage = {
      trace_id: traceId,
      total_tokens: tot.t ?? 0,
      input: tot.input ?? 0,
      output: tot.output ?? 0,
      cost: tot.c ?? 0,
      calls: tot.calls,
      by_post: byPost.map((r) => ({ post_id: r.post_id, dept: r.dept ?? "", calls: r.calls, total_tokens: r.t ?? 0, cost: r.c ?? 0 })),
      by_turn: byTurn.map((r) => ({ turn_id: r.turn_id, post_id: r.post_id, first_ts: r.first_ts, last_ts: r.last_ts, calls: r.calls, total_tokens: r.t ?? 0, cost: r.c ?? 0 })),
    };
    return c.json(out);
  });

  app.get("/api/ledger/summary", (c) => {
    const group = c.req.query("group") || "dept";
    const col = GROUP_COL[group];
    if (!col) throw bad(`group 只能是 ${Object.keys(GROUP_COL).join("/")}`);
    const since = queryInt(c, "since", dayStart(ctx.now()), 0);
    const until = queryInt(c, "until", ctx.now() + 1, 0);
    const where = ["ts >= ?", "ts < ?"];
    const params: (string | number)[] = [since, until];
    const fs = c.req.query("filter_scope");
    if (fs && fs !== "global") {
      const i = fs.indexOf(":");
      const fcol = FILTER_COL[fs.slice(0, i)];
      if (i < 0 || !fcol) throw bad(`filter_scope 应为 ${Object.keys(FILTER_COL).join("/")}:<id>`);
      where.push(`${fcol} = ?`);
      params.push(fs.slice(i + 1));
    }
    const rows = ctx.db.all<{ k: string | number; calls: number; input: number | null; output: number | null; total_tokens: number | null; cost: number | null }>(
      `SELECT ${col} AS k, COUNT(*) AS calls, SUM(json_extract(data_json, '$.input')) AS input, SUM(json_extract(data_json, '$.output')) AS output,
              SUM(total_tokens) AS total_tokens, SUM(cost) AS cost
       FROM ledger WHERE ${where.join(" AND ")} GROUP BY k ORDER BY ${group === "hour" ? "k ASC" : "total_tokens DESC"} LIMIT 500`,
      ...params,
    );
    const out: LedgerSummaryRow[] = rows.map((r) => ({
      key: group === "hour" ? fmtHour(Number(r.k)) : String(r.k ?? ""),
      calls: r.calls,
      input: r.input ?? 0,
      output: r.output ?? 0,
      total_tokens: r.total_tokens ?? 0,
      cost: r.cost ?? 0,
    }));
    return c.json(out);
  });

  app.get("/api/budget", (c) => {
    const budgets = ledger().budgets();
    const usage_today: BudgetStatus["usage_today"] = { global: ctx.ledger.usageToday("global") };
    for (const b of budgets) usage_today[b.scope] = ctx.ledger.usageToday(b.scope);
    // 各部门用量（即使没设预算，也方便仪表盘展示）
    for (const d of ctx.registry.depts()) usage_today[`dept:${d.id}`] ??= ctx.ledger.usageToday(`dept:${d.id}`);
    return c.json({ budgets, usage_today } satisfies BudgetStatus);
  });

  app.put("/api/budget", async (c) => {
    const p = principal(c);
    if (p.kind === "gateway") throw forbidden("网关无权设置预算");
    requireTool(c, "budget_set");
    const req = await readJson<{ actor?: string; scope?: string; daily_tokens?: number | null; daily_cost?: number | null; idem_key?: string }>(c);
    const actor = actingAddress(c, req.actor);
    const key = req.idem_key ? `budget:${actor}:${req.idem_key}` : undefined;
    return c.json(ctx.idem.wrap(key, () => ledger().setBudget(actor, req.scope as string, req.daily_tokens, req.daily_cost)));
  });

  app.post("/api/budget/check", async (c) => {
    if (principal(c).kind === "dept") throw forbidden("预算检查由 LLM 网关发起；官员请用 budget_get 查询");
    const r = await readJson<BudgetCheckReq>(c);
    if (typeof r.post_id !== "string" || !r.post_id) throw bad("post_id 必填");
    return c.json(ctx.ledger.check(r.post_id, r.trace_id, Number(r.estimate_tokens) || 0));
  });
}
