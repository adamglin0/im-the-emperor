// 测试用假 hub：只实现网关会调用的接口（预算预检、记账、事件、内部 token）。
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { BudgetCheck, BudgetCheckReq, EventIn, LedgerEntry } from "@court/shared";

export interface FakeHub {
  url: string;
  ledger: LedgerEntry[];
  events: EventIn[];
  budgetCalls: BudgetCheckReq[];
  setBudget(fn: (r: BudgetCheckReq) => BudgetCheck | { status: number; code: string; error: string }): void;
  close(): Promise<void>;
}

export async function startFakeHub(opts: { gatewayToken: string; deptTokens?: Record<string, string> }): Promise<FakeHub> {
  const ledger: LedgerEntry[] = [];
  const events: EventIn[] = [];
  const budgetCalls: BudgetCheckReq[] = [];
  let budget: (r: BudgetCheckReq) => BudgetCheck | { status: number; code: string; error: string } = () => ({ allowed: true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${opts.gatewayToken}`) return c.json({ error: "unauthorized", code: "unauthorized" }, 401);
    await next();
  });
  app.post("/api/budget/check", async (c) => {
    const req = (await c.req.json()) as BudgetCheckReq;
    budgetCalls.push(req);
    const out = budget(req);
    if ("status" in out) return c.json({ error: out.error, code: out.code }, out.status as 403);
    return c.json(out);
  });
  app.post("/api/ledger", async (c) => {
    const { entries } = (await c.req.json()) as { entries: LedgerEntry[] };
    ledger.push(...entries);
    return c.json({ ok: true, inserted: entries.length });
  });
  app.post("/api/events", async (c) => {
    const body = (await c.req.json()) as { events: EventIn[] };
    events.push(...body.events);
    return c.json({ ok: true, inserted: body.events.length });
  });
  app.get("/api/internal/tokens", (c) => {
    const out: Record<string, string> = {};
    for (const [dept, token] of Object.entries(opts.deptTokens ?? {})) out[token] = dept;
    return c.json(out);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    ledger,
    events,
    budgetCalls,
    setBudget: (fn) => {
      budget = fn;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}
