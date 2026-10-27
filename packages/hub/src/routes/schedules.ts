// 定时任务：列表、新建、修改（含启停）、删除、立即触发、运行历史。
import type { Hono } from "hono";
import type { CreateScheduleReq, UpdateScheduleReq } from "@court/shared";
import { forbidden, notFound, type HubCtx } from "../ctx.ts";
import { actingAddress, principal, queryInt, readJson, requireTool } from "../auth.ts";
import type { ScheduleServiceExt } from "../services/schedules.ts";

export function register(app: Hono, ctx: HubCtx): void {
  const svc = () => ctx.schedules as ScheduleServiceExt;
  const guard = (c: Parameters<typeof principal>[0]) => {
    if (principal(c).kind === "gateway") throw forbidden("网关无权管理定时任务");
    requireTool(c, "schedule");
  };

  app.get("/api/schedules", (c) => c.json(svc().list(c.req.query("owner") || undefined, queryInt(c, "limit", 500, 1, 1000))));

  app.get("/api/schedules/:id", (c) => {
    const s = svc().get(c.req.param("id"));
    if (!s) throw notFound(`定时任务 ${c.req.param("id")}`);
    return c.json(s);
  });

  app.post("/api/schedules", async (c) => {
    guard(c);
    const req = await readJson<CreateScheduleReq>(c);
    req.actor = actingAddress(c, req.actor);
    return c.json(svc().create(req));
  });

  app.patch("/api/schedules/:id", async (c) => {
    guard(c);
    const req = await readJson<UpdateScheduleReq>(c);
    req.actor = actingAddress(c, req.actor);
    return c.json(svc().update(c.req.param("id"), req));
  });

  app.delete("/api/schedules/:id", (c) => {
    guard(c);
    const actor = actingAddress(c, c.req.query("actor") || undefined);
    svc().remove(c.req.param("id"), actor);
    return c.json({ ok: true as const });
  });

  app.post("/api/schedules/:id/trigger", async (c) => {
    guard(c);
    const body = await readJson<{ actor?: string }>(c);
    const actor = actingAddress(c, body.actor);
    return c.json(svc().trigger(c.req.param("id"), actor));
  });

  app.get("/api/schedules/:id/runs", (c) => {
    if (!svc().get(c.req.param("id"))) throw notFound(`定时任务 ${c.req.param("id")}`);
    return c.json(svc().runs(c.req.param("id"), queryInt(c, "limit", 100, 1, 500)));
  });
}
