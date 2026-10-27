// 服务调用：发起、回报结果、查询。
import type { Hono } from "hono";
import type { HubCtx } from "../ctx.ts";
import { workflowOf } from "../services/workflow.ts";
import { notFound } from "../ctx.ts";
import { optStr, reqBool, reqStr } from "../services/flow-util.ts";
import { actingAddress } from "../auth.ts";
import { flowActor, readJson, requireTool, withIdem } from "./flow-http.ts";

export function register(app: Hono, ctx: HubCtx): void {
  const wf = () => workflowOf(ctx);

  app.post("/api/services/call", async (c) => {
    requireTool(c, "call_service");
    const b = await readJson(c);
    const caller = actingAddress(c, typeof b.caller === "string" ? b.caller : undefined);
    const input = {
      caller,
      target: reqStr(b.target, "target（post:<职位> 或 dept:<部门>）", 200),
      service: reqStr(b.service, "service（服务名）", 100),
      input: b.input ?? null,
      trace_id: optStr(b.trace_id, "trace_id", 100),
      parent_span_id: optStr(b.parent_span_id, "parent_span_id", 100),
    };
    return c.json(withIdem(ctx, "service_call", b.idem_key, () => wf().services.call(input)));
  });

  app.post("/api/services/:id/result", async (c) => {
    requireTool(c, "service_respond");
    const b = await readJson(c);
    const actor = flowActor(c, b.post);
    const ok = reqBool(b.ok, "ok（是否办成）");
    const output = reqStr(b.output, "output（结果）", 50_000);
    return c.json(withIdem(ctx, "service_result", b.idem_key, () => wf().services.respond(c.req.param("id"), actor.post, ok, output)));
  });

  app.get("/api/services/:id", (c) => {
    const r = wf().services.getServiceRequestOrNull(c.req.param("id"));
    if (!r) throw notFound(`服务请求 ${c.req.param("id")}`);
    return c.json(r);
  });
}
