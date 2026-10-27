// 御史台：稽查发现、复核、弹劾、奏报。
import type { Hono } from "hono";
import type { AuditFinding } from "@court/shared";
import type { HubCtx } from "../ctx.ts";
import { auditOf } from "../services/audit.ts";
import { optStr, optStrArr, reqEnum, reqStr } from "../services/flow-util.ts";
import { actingAddress } from "../auth.ts";
import { flowActor, queryInt, readJson, requireTool, withIdem } from "./flow-http.ts";

const STATUSES: AuditFinding["status"][] = ["open", "reviewed", "impeached", "dismissed"];

export function register(app: Hono, ctx: HubCtx): void {
  const au = () => auditOf(ctx);

  app.get("/api/audit/findings", (c) =>
    c.json(au().listFindings({ status: c.req.query("status") || undefined, subject: c.req.query("subject") || undefined, limit: queryInt(c, "limit", 100, 1, 500) })),
  );

  app.post("/api/audit/findings/:id", async (c) => {
    requireTool(c, "audit_update_finding");
    const b = await readJson(c);
    const actor = actingAddress(c, typeof b.actor === "string" ? b.actor : undefined);
    const status = reqEnum(b.status, STATUSES, "status");
    return c.json(au().updateFinding(c.req.param("id"), actor, status, optStr(b.note, "note", 4000)));
  });

  app.post("/api/audit/impeach", async (c) => {
    requireTool(c, "impeach");
    const b = await readJson(c);
    const actor = flowActor(c, b.post);
    const input = {
      post: actor.post ?? "emperor",
      target: reqStr(b.target, "target（被弹劾者 post:<职位>）", 200),
      charges: reqStr(b.charges, "charges（罪状）", 4000),
      evidence: reqStr(b.evidence, "evidence（证据：trace/span/事件/日志摘录）", 20_000),
      finding_ids: optStrArr(b.finding_ids, "finding_ids", 50),
    };
    return c.json(withIdem(ctx, "impeach", b.idem_key, () => au().impeach(input)));
  });

  app.post("/api/audit/report", async (c) => {
    requireTool(c, "audit_report");
    const b = await readJson(c);
    const actor = flowActor(c, b.post);
    const input = { post: actor.post ?? "emperor", title: reqStr(b.title, "title（奏报标题）", 200), body: reqStr(b.body, "body（奏报正文）", 20_000) };
    return c.json(withIdem(ctx, "audit_report", b.idem_key, () => au().report(input)));
  });

  app.get("/api/audit/impeachments", (c) => c.json(au().listImpeachments()));
}
