// 部门/官员 HTTP API（路径与 @court/shared DeptClient 一一对应）。
// 门面写接口把调用方 Authorization / X-Acting-Post 原样转发给 hub（hub 校验 ACL 与幂等），成功后本地按铃唤醒目标官员。
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { API_VERSION, type SendMessageRes, type ServiceRequest } from "@court/shared";
import type { DeptRuntime } from "./runtime.ts";

/** SSE 每连接最多积压的未写出事件数（客户端读得慢时丢弃实时增量，不在内存里无限堆积） */
const SSE_MAX_PENDING = 500;

export interface DeptAppOptions {
  hubUrl: string;
  /** 控制面 token（/control/*）；未配置则不校验（仅测试） */
  controlToken?: string;
  fetchImpl?: typeof fetch;
}

function err(c: Context, status: number, code: string, error: string) {
  return c.json({ error, code }, status as 400);
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createDeptApp(rt: DeptRuntime, opts: DeptAppOptions): Hono {
  const app = new Hono();
  const f = opts.fetchImpl ?? fetch;

  /** 转发给 hub；返回 hub 的状态与正文，成功时解析 JSON 交给 onOk */
  async function forward<T>(c: Context, path: string, body: unknown, onOk: (data: T) => void): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const auth = c.req.header("authorization");
    const acting = c.req.header("x-acting-post");
    if (auth) headers.authorization = auth;
    if (acting) headers["x-acting-post"] = acting;
    let res: Response;
    try {
      res = await f(opts.hubUrl + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return err(c, 503, "unavailable", `皇城不可达，请稍后重试或直接投递皇城：${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.ok) {
      try {
        onOk(JSON.parse(text) as T);
      } catch {
        /* 唤醒失败无害：兜底巡检会拉到 */
      }
    }
    return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  }

  function requirePost(c: Context): string | Response {
    const post = c.req.param("post") ?? "";
    if (!rt.hasPost(post)) return err(c, 404, "not_found", `本部门（${rt.dept}）没有职位 ${post}`);
    return post;
  }

  // ── 健康与部门信息 ──
  app.get("/health", (c) => {
    const stalled = rt.isStarted ? rt.stalledPosts() : [];
    const ok = stalled.length === 0;
    const body = {
      ok,
      role: "dept",
      version: API_VERSION,
      details: {
        dept: rt.dept,
        started: rt.isStarted,
        hub_reachable: rt.hubReachable,
        halted: rt.isHalted,
        outbox: rt.outbox.size,
        outbox_error: rt.outbox.lastError,
        stalled,
      },
      officials: rt.isStarted ? rt.statuses() : [],
    };
    return c.json(body, ok ? 200 : 503);
  });

  app.get("/dept", (c) => {
    if (!rt.isStarted) return err(c, 503, "unavailable", "官署尚未就绪");
    return c.json({ dept: rt.deptDef(), officials: rt.statuses() });
  });

  app.get("/dept/officials", (c) => {
    if (!rt.isStarted) return err(c, 503, "unavailable", "官署尚未就绪");
    return c.json(rt.statuses());
  });

  app.get("/dept/services", (c) => {
    if (!rt.isStarted) return err(c, 503, "unavailable", "官署尚未就绪");
    return c.json(rt.deptDef().services);
  });

  // ── 门面写接口（转发 hub） ──
  app.post("/dept/inbox", async (c) => {
    const body = await readJson(c);
    return forward<SendMessageRes>(c, "/api/messages", { ...body, to: `dept:${rt.dept}` }, (d) => rt.localWake(d.routed_to ?? [], "message"));
  });

  app.post("/dept/services/:name", async (c) => {
    const body = await readJson(c);
    return forward<ServiceRequest>(c, "/api/services/call", { ...body, target: `dept:${rt.dept}`, service: c.req.param("name") }, (d) => {
      if (d.routed_to) rt.localWake([d.routed_to], "service");
    });
  });

  app.post("/officials/:post/messages", async (c) => {
    const post = requirePost(c);
    if (post instanceof Response) return post;
    const body = await readJson(c);
    return forward<SendMessageRes>(c, "/api/messages", { ...body, to: `post:${post}` }, (d) => rt.localWake(d.routed_to ?? [post], "message"));
  });

  app.post("/officials/:post/services/:name", async (c) => {
    const post = requirePost(c);
    if (post instanceof Response) return post;
    const body = await readJson(c);
    return forward<ServiceRequest>(c, "/api/services/call", { ...body, target: `post:${post}`, service: c.req.param("name") }, (d) =>
      rt.localWake([d.routed_to ?? post], "service"),
    );
  });

  // ── 官员只读与操作 ──
  app.get("/officials/:post/status", (c) => {
    const post = requirePost(c);
    if (post instanceof Response) return post;
    const o = rt.officials.get(post);
    return c.json(o ? o.status() : rt.vacantStatus(post));
  });

  app.post("/officials/:post/wake", async (c) => {
    const post = requirePost(c);
    if (post instanceof Response) return post;
    const body = await readJson(c);
    if (!rt.wake(post, String(body.reason ?? "人工唤醒"))) return err(c, 409, "invalid_state", `职位 ${post} 当前无人在任`);
    return c.json({ ok: true });
  });

  app.get("/officials/:post/context", (c) => {
    const post = requirePost(c);
    if (post instanceof Response) return post;
    const o = rt.officials.get(post);
    if (!o) return err(c, 404, "not_found", `职位 ${post} 当前无人在任`);
    return c.json(o.contextView());
  });

  app.get("/officials/:post/log", (c) => {
    const post = requirePost(c);
    if (post instanceof Response) return post;
    const o = rt.officials.get(post);
    if (!o) return err(c, 404, "not_found", `职位 ${post} 当前无人在任`);
    const tail = Number(c.req.query("tail") ?? 200);
    const date = c.req.query("date") || undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(c, 400, "bad_request", "date 须为 YYYY-MM-DD");
    return c.json(o.readLog(date, Number.isFinite(tail) && tail > 0 ? Math.min(tail, 5000) : 200));
  });

  app.get("/officials/:post/stream", (c) => {
    const post = requirePost(c);
    if (post instanceof Response) return post;
    return streamSSE(c, async (stream) => {
      let closed = false;
      let pending = 0;
      const unsub = rt.live.subscribe(post, (e) => {
        if (closed || pending >= SSE_MAX_PENDING) return;
        pending++;
        void stream
          .writeSSE({ event: e.type, data: JSON.stringify(e) })
          .catch(() => undefined)
          .finally(() => pending--);
      });
      stream.onAbort(() => {
        closed = true;
        unsub();
      });
      const o = rt.officials.get(post);
      await stream.writeSSE({ event: "status", data: JSON.stringify(o ? o.status() : rt.vacantStatus(post)) });
      while (!closed) {
        await stream.sleep(15_000);
        if (!closed) await stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => undefined);
      }
      unsub();
    });
  });

  // ── 控制面（仅 hub） ──
  app.use("/control/*", async (c, next) => {
    if (opts.controlToken && c.req.header("authorization") !== `Bearer ${opts.controlToken}`) {
      return err(c, 401, "unauthorized", "控制面需要 control token");
    }
    await next();
  });

  app.post("/control/doorbell", async (c) => {
    const body = await readJson(c);
    const posts = Array.isArray(body.posts) ? (body.posts as unknown[]).map(String) : [];
    rt.doorbell(posts);
    return c.json({ ok: true });
  });

  app.post("/control/reload", async (c) => {
    try {
      await rt.reload();
    } catch (e) {
      return err(c, 503, "unavailable", `名册刷新失败：${(e as Error).message}`);
    }
    return c.json({ ok: true });
  });

  app.post("/control/pause", async (c) => {
    const body = await readJson(c);
    rt.pause(Array.isArray(body.posts) ? (body.posts as unknown[]).map(String) : undefined);
    return c.json({ ok: true });
  });

  app.post("/control/resume", async (c) => {
    const body = await readJson(c);
    rt.resume(Array.isArray(body.posts) ? (body.posts as unknown[]).map(String) : undefined);
    return c.json({ ok: true });
  });

  app.post("/control/mcp", (c) => {
    rt.markMcpDirty();
    return c.json({ ok: true });
  });

  app.post("/control/budget", (c) => {
    rt.recheckBudget();
    return c.json({ ok: true });
  });

  app.post("/control/compact/:post", (c) => {
    if (!rt.compact(c.req.param("post"))) return err(c, 404, "not_found", `职位 ${c.req.param("post")} 当前无人在任`);
    return c.json({ ok: true });
  });

  app.notFound((c) => err(c, 404, "not_found", `无此接口：${c.req.method} ${c.req.path}`));
  app.onError((e, c) => err(c, 500, "internal", e.message));
  return app;
}
