// 消息、收件箱、线程、搜索。
import type { Context, Hono } from "hono";
import type { Message, SendMessageReq } from "@court/shared";
import { bad, forbidden, notFound, type HubCtx } from "../ctx.ts";
import { principal, queryInt, readJson, requireActingPost, requireOwnDeptPost, requireTool } from "../auth.ts";
import { MESSAGE_KINDS } from "../services/messages.ts";

/** 部门调用者能否看到这封信：收发/抄送涉及本部门，或投递到了本部门职位 */
export function messageVisibleToDept(ctx: HubCtx, m: Message, dept: string): boolean {
  const inDept = (a: string) =>
    a === `dept:${dept}` || (a.startsWith("post:") && ctx.registry.post(a.slice(5))?.dept === dept);
  if (inDept(m.from) || inDept(m.to) || m.cc.some(inDept)) return true;
  const posts = ctx.registry.posts(dept).map((p) => p.post_id);
  if (!posts.length) return false;
  return !!ctx.db.get(`SELECT 1 FROM deliveries WHERE message_id = ? AND post_id IN (${posts.map(() => "?").join(",")}) LIMIT 1`, m.id, ...posts);
}

function readFilter(c: Context, ctx: HubCtx): (m: Message) => boolean {
  const p = principal(c);
  if (p.kind === "gateway") throw forbidden("网关无权读取消息");
  if (p.kind === "dept") return (m) => messageVisibleToDept(ctx, m, p.dept!);
  return () => true;
}

export function register(app: Hono, ctx: HubCtx): void {
  app.post("/api/messages", async (c) => {
    const req = await readJson<SendMessageReq>(c);
    const p = principal(c);
    if (p.kind === "gateway") throw forbidden("网关不能发信");
    if (p.kind === "dept") {
      requireTool(c, "send_message");
      const post = requireActingPost(c, typeof req.from === "string" ? req.from : undefined);
      req.from = `post:${post}`;
    } else if (req.from === undefined) {
      req.from = "emperor";
    } else if (typeof req.from === "string" && req.from !== "emperor") {
      // 皇帝/系统代行：校验声称的地址
      const acting = requireActingPost(c, req.from);
      req.from = acting === "emperor" || acting.startsWith("system:") ? acting : `post:${acting}`;
    }
    return c.json(ctx.messages.send(req, p));
  });

  app.get("/api/inbox/:post", (c) => {
    const post = c.req.param("post");
    requireOwnDeptPost(c, post);
    const after = queryInt(c, "after", 0, 0);
    const limit = queryInt(c, "limit", 100, 1, 500);
    return c.json(ctx.messages.inbox(post, after, limit));
  });

  app.get("/api/inbox/:post/cursor", (c) => {
    const post = c.req.param("post");
    requireOwnDeptPost(c, post);
    return c.json({ acked_seq: ctx.messages.ackedSeq(post), latest_seq: ctx.messages.latestSeq(post) });
  });

  app.post("/api/inbox/:post/ack", async (c) => {
    const post = c.req.param("post");
    requireOwnDeptPost(c, post);
    const body = await readJson<{ seq?: number }>(c);
    if (body.seq === undefined) throw bad("seq 必填");
    ctx.messages.ack(post, Number(body.seq));
    return c.json({ ok: true as const });
  });

  app.get("/api/messages/:id", (c) => {
    const visible = readFilter(c, ctx);
    const m = ctx.messages.get(c.req.param("id"));
    if (!m) throw notFound(`消息 ${c.req.param("id")}`);
    if (!visible(m)) throw forbidden("这封信与你部门无关，无权查看");
    return c.json(m);
  });

  app.get("/api/threads/:id", (c) => {
    const visible = readFilter(c, ctx);
    return c.json(ctx.messages.thread(c.req.param("id")).filter(visible));
  });

  app.get("/api/messages", (c) => {
    const visible = readFilter(c, ctx);
    const where: string[] = [];
    const params: (string | number)[] = [];
    const post = c.req.query("post");
    if (post) {
      const id = post.startsWith("post:") ? post.slice(5) : post;
      const addr = `post:${id}`;
      where.push("(from_addr = ? OR to_addr = ? OR id IN (SELECT message_id FROM deliveries WHERE post_id = ? ORDER BY seq DESC LIMIT 2000))");
      params.push(addr, addr, id);
    }
    const q = c.req.query("q");
    if (q) {
      where.push("(instr(subject, ?) > 0 OR instr(json_extract(data_json, '$.body'), ?) > 0)");
      params.push(q, q);
    }
    const kind = c.req.query("kind");
    if (kind) {
      if (!MESSAGE_KINDS.includes(kind as Message["kind"])) throw bad(`未知消息类型 ${kind}`);
      where.push("kind = ?");
      params.push(kind);
    }
    const trace = c.req.query("trace_id");
    if (trace) {
      where.push("trace_id = ?");
      params.push(trace);
    }
    const limit = queryInt(c, "limit", 50, 1, 200);
    const sql = `SELECT data_json FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    // 部门调用者按可见性过滤：多取一些再截断
    const scan = principal(c).kind === "dept" ? Math.min(1000, limit * 5) : limit;
    return c.json(ctx.db.allJson<Message>(sql, ...params, scan).filter(visible).slice(0, limit));
  });
}
