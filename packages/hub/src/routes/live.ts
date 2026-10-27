// 部门实时数据代理（仅陛下）：Web 只与 hub 通信，hub 转发到部门 API（上下文、日志、实时流、唤醒、压缩、部门信息）。
import type { Context, Hono } from "hono";
import { HubError, notFound, type HubCtx } from "../ctx.ts";
import { readJson, requireEmperor } from "../auth.ts";
import { deptUrl } from "../services/doorbell.ts";

const PROXY_TIMEOUT_MS = 10_000;

function deptOfPost(ctx: HubCtx, postId: string) {
  const p = ctx.registry.post(postId);
  if (!p) throw notFound(`职位 ${postId}`);
  const d = ctx.registry.dept(p.dept);
  if (!d) throw notFound(`部门 ${p.dept}`);
  return d;
}

/** 转发并原样返回（JSON 或文本）；不可达 → 503 */
async function forward(ctx: HubCtx, c: Context, url: string, init: RequestInit = {}, deptName = ""): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.controlToken}`, ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new HubError(503, "unavailable", `部门${deptName ? ` ${deptName}` : ""}不可达：${(e as Error).message}`);
  }
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}

export function register(app: Hono, ctx: HubCtx): void {
  app.get("/api/live/depts/:dept", (c) => {
    requireEmperor(c);
    const d = ctx.registry.dept(c.req.param("dept"));
    if (!d) throw notFound(`部门 ${c.req.param("dept")}`);
    return forward(ctx, c, `${deptUrl(d)}/dept`, {}, d.name);
  });

  app.get("/api/live/:post/context", (c) => {
    requireEmperor(c);
    const post = c.req.param("post");
    const d = deptOfPost(ctx, post);
    return forward(ctx, c, `${deptUrl(d)}/officials/${encodeURIComponent(post)}/context`, {}, d.name);
  });

  app.get("/api/live/:post/log", (c) => {
    requireEmperor(c);
    const post = c.req.param("post");
    const d = deptOfPost(ctx, post);
    const q = new URLSearchParams();
    for (const k of ["date", "tail"]) {
      const v = c.req.query(k);
      if (v) q.set(k, v);
    }
    const qs = q.toString();
    return forward(ctx, c, `${deptUrl(d)}/officials/${encodeURIComponent(post)}/log${qs ? `?${qs}` : ""}`, {}, d.name);
  });

  app.get("/api/live/:post/stream", async (c) => {
    requireEmperor(c);
    const post = c.req.param("post");
    const d = deptOfPost(ctx, post);
    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
    let upstream: Response;
    try {
      upstream = await fetch(`${deptUrl(d)}/officials/${encodeURIComponent(post)}/stream`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${ctx.controlToken}` },
        signal: ac.signal,
      });
    } catch (e) {
      throw new HubError(503, "unavailable", `部门 ${d.name} 不可达：${(e as Error).message}`);
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return new Response(text || JSON.stringify({ error: `部门 ${d.name} 实时流不可用`, code: "unavailable" }), {
        status: upstream.ok ? 502 : upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }
    // 客户端离开（abort）时上游读流会抛 AbortError：包一层，读错即静默收尾，取消时连带中止上游
    const reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read();
          if (done) ctrl.close();
          else ctrl.enqueue(value);
        } catch {
          try {
            ctrl.close();
          } catch {
            /* 已关闭 */
          }
        }
      },
      cancel() {
        ac.abort();
        reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  });

  app.post("/api/live/:post/wake", async (c) => {
    requireEmperor(c);
    const post = c.req.param("post");
    const d = deptOfPost(ctx, post);
    const body = await readJson<{ reason?: string }>(c);
    return forward(
      ctx,
      c,
      `${deptUrl(d)}/officials/${encodeURIComponent(post)}/wake`,
      { method: "POST", body: JSON.stringify({ reason: body.reason || "陛下召见" }) },
      d.name,
    );
  });

  app.post("/api/live/:post/compact", (c) => {
    requireEmperor(c);
    const post = c.req.param("post");
    const d = deptOfPost(ctx, post);
    return forward(ctx, c, `${deptUrl(d)}/control/compact/${encodeURIComponent(post)}`, { method: "POST", body: "{}" }, d.name);
  });
}
