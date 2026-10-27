// 追踪图：某 trace 的执行图；最近的根追踪。
import type { Hono } from "hono";
import type { HubCtx } from "../ctx.ts";
import { getTraceGraph, listTraceRoots } from "../services/traces.ts";
import { queryInt } from "./flow-http.ts";

export function register(app: Hono, ctx: HubCtx): void {
  app.get("/api/traces", (c) => c.json(listTraceRoots(ctx, { limit: queryInt(c, "limit", 50, 1, 200), kind: c.req.query("kind") || undefined })));
  app.get("/api/traces/:id", (c) => c.json(getTraceGraph(ctx, c.req.param("id"))));
}
