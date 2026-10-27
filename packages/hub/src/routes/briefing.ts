// 醒来简报（部门 runtime 每轮开始时拉取）。
import type { Hono } from "hono";
import type { HubCtx } from "../ctx.ts";
import { queryInt, requireOwnDeptPost } from "./flow-http.ts";

export function register(app: Hono, ctx: HubCtx): void {
  app.get("/api/briefing/:post", (c) => {
    const post = c.req.param("post");
    requireOwnDeptPost(c, post);
    return c.json(ctx.briefing.build(post, queryInt(c, "after", 0, 0), c.req.query("wake_reason") ?? ""));
  });

  /** 结构化职事（不含消息）：runtime 超时醒来时据此决定是否需要调 LLM */
  app.get("/api/briefing/:post/pending", (c) => {
    const post = c.req.param("post");
    requireOwnDeptPost(c, post);
    return c.json(ctx.briefing.pendingItems(post));
  });
}
