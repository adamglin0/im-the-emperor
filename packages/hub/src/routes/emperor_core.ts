// 皇帝核心接口：口谕/私聊、来信、私聊记录、批复待办、罢朝、总览。
import type { Hono } from "hono";
import type { EmperorOralReq, Message, Overview, ResolveNotificationReq } from "@court/shared";
import { bad, type HubCtx } from "../ctx.ts";
import { queryInt, readJson, requireEmperor } from "../auth.ts";
import { controlAll } from "../services/doorbell.ts";

const OPEN_EDICT_EXCLUDE = ["completed", "withdrawn", "failed"];
const OPEN_TASK_EXCLUDE = ["done", "cancelled", "failed"];

export function register(app: Hono, ctx: HubCtx): void {
  app.post("/api/emperor/oral", async (c) => {
    requireEmperor(c);
    const r = await readJson<EmperorOralReq & { subject?: string; idem_key?: string }>(c);
    const content = String(r.content ?? "").trim();
    if (!content) throw bad("口谕内容不能为空");
    if (typeof r.to !== "string" || !r.to) throw bad("to 必填：post:<职位> 或 dept:<部门>");
    if (r.to === "emperor" || r.to.startsWith("system:")) throw bad("口谕只能发给职位（post:x）或部门（dept:y）");
    const requiresReply = !!r.requires_reply;
    const subject = (r.subject?.trim() || content.replace(/\s+/g, " ").slice(0, 30)) + (content.length > 30 && !r.subject ? "…" : "");
    // 续聊：同一职位的私聊沿用最近线程
    let thread_id: string | undefined;
    if (requiresReply && r.to.startsWith("post:")) {
      thread_id = ctx.db.get<{ thread_id: string }>(
        "SELECT thread_id FROM messages WHERE kind = 'chat' AND ((from_addr = 'emperor' AND to_addr = ?) OR (from_addr = ? AND to_addr = 'emperor')) ORDER BY created_at DESC, rowid DESC LIMIT 1",
        r.to,
        r.to,
      )?.thread_id;
    }
    return c.json(
      ctx.messages.send(
        {
          from: "emperor",
          to: r.to,
          kind: requiresReply ? "chat" : "oral_order",
          subject,
          body: content,
          requires_reply: requiresReply,
          priority: "high",
          thread_id,
          idem_key: r.idem_key,
        },
        { kind: "emperor" },
      ),
    );
  });

  app.get("/api/emperor/inbox", (c) => {
    requireEmperor(c);
    const from = c.req.query("from");
    const limit = queryInt(c, "limit", 100, 1, 500);
    const rows = from
      ? ctx.db.allJson<Message>("SELECT data_json FROM messages WHERE to_addr = 'emperor' AND from_addr = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", from, limit)
      : ctx.db.allJson<Message>("SELECT data_json FROM messages WHERE to_addr = 'emperor' ORDER BY created_at DESC, rowid DESC LIMIT ?", limit);
    return c.json(rows);
  });

  app.get("/api/emperor/chat/:post", (c) => {
    requireEmperor(c);
    const id = c.req.param("post").replace(/^post:/, "");
    const addr = `post:${id}`;
    const limit = queryInt(c, "limit", 100, 1, 500);
    const rows = ctx.db.allJson<Message>(
      `SELECT data_json FROM (
         SELECT data_json, created_at, rowid AS rid FROM messages
         WHERE (from_addr = 'emperor' AND to_addr = ?) OR (from_addr = ? AND to_addr = 'emperor')
         ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at ASC, rid ASC`,
      addr,
      addr,
      limit,
    );
    return c.json(rows);
  });

  app.post("/api/emperor/notifications/:id/resolve", async (c) => {
    requireEmperor(c);
    const r = await readJson<ResolveNotificationReq>(c);
    return c.json(ctx.notifications.resolve(c.req.param("id"), String(r.option ?? ""), String(r.comment ?? "")));
  });

  app.post("/api/emperor/halt", async (c) => {
    requireEmperor(c);
    const r = await readJson<{ halted?: boolean }>(c);
    if (typeof r.halted !== "boolean") throw bad("halted 必须是 true/false");
    ctx.registry.setHalted(r.halted);
    controlAll(ctx, r.halted ? "/control/pause" : "/control/resume", {});
    return c.json({ halted: ctx.registry.isHalted() });
  });

  app.get("/api/emperor/overview", (c) => {
    const ph = (xs: string[]) => xs.map(() => "?").join(",");
    const today = ctx.ledger.usageToday("global");
    const out: Overview = {
      halted: ctx.registry.isHalted(),
      pending_notifications: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE status = 'pending'")!.n,
      edicts_active: ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM edicts WHERE state NOT IN (${ph(OPEN_EDICT_EXCLUDE)})`, ...OPEN_EDICT_EXCLUDE)!.n,
      tasks_open: ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE state NOT IN (${ph(OPEN_TASK_EXCLUDE)})`, ...OPEN_TASK_EXCLUDE)!.n,
      tokens_today: today.tokens,
      cost_today: today.cost,
      statuses: ctx.statuses(),
      depts_health: ctx.doorbell.deptHealth(),
    };
    return c.json(out);
  });
}
