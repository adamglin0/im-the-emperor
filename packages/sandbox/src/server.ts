// 将作监沙箱 HTTP 服务（契约见 @court/shared SandboxClient）。
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { API_VERSION, SANDBOX_PORT, type ExecReq } from "@court/shared";
import { JobRunner } from "./exec.ts";
import { guardedFetch } from "./fetch.ts";
import { listWorkspaceDir, readWorkspaceFile, writeWorkspaceFile } from "./fs.ts";
import { SandboxError } from "./paths.ts";

export interface StartSandboxOptions {
  port?: number;
  hostname?: string;
  root: string;
  token: string;
}

export interface SandboxHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

function fail(c: Context, e: unknown) {
  if (e instanceof SandboxError) return c.json({ error: e.message, code: e.code }, e.status);
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP") return c.json({ error: `无权访问：${code}`, code: "forbidden" }, 403);
  if (code === "ENOENT") return c.json({ error: "路径不存在", code: "not_found" }, 404);
  return c.json({ error: `沙箱内部错误：${(e as Error).message}`, code: "internal" }, 500);
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new SandboxError(400, "bad_request", "请求体不是合法 JSON");
  }
}

export async function startSandbox(opts: StartSandboxOptions): Promise<SandboxHandle> {
  if (!opts.token) throw new Error("沙箱必须配置 token");
  const root = resolve(opts.root);
  mkdirSync(root, { recursive: true });
  const runner = new JobRunner(root);
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, role: "sandbox", version: API_VERSION }));

  app.use("*", async (c, next) => {
    const auth = Buffer.from(c.req.header("authorization") ?? "");
    const want = Buffer.from(`Bearer ${opts.token}`);
    if (auth.length !== want.length || !timingSafeEqual(auth, want)) return c.json({ error: "沙箱鉴权失败", code: "unauthorized" }, 401);
    await next();
  });

  // 2MB 文件 base64 后约 2.7MB
  app.use("*", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: "请求体超过 4MB", code: "too_large" }, 413) }));

  app.post("/exec", async (c) => {
    try {
      return c.json(await runner.exec(await readJson<ExecReq>(c), c.req.raw.signal));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get("/jobs/:id", (c) => {
    try {
      return c.json(runner.get(c.req.param("id")));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/jobs/:id/cancel", async (c) => {
    try {
      return c.json(await runner.cancel(c.req.param("id")));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get("/fs/read", (c) => {
    try {
      return c.json(readWorkspaceFile(root, c.req.query("workspace") ?? "", c.req.query("path") ?? ""));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/fs/write", async (c) => {
    try {
      return c.json(writeWorkspaceFile(root, await readJson(c)));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get("/fs/list", (c) => {
    try {
      return c.json(listWorkspaceDir(root, c.req.query("workspace") ?? "", c.req.query("path") ?? "."));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/fetch", async (c) => {
    try {
      return c.json(await guardedFetch(await readJson(c)));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.notFound((c) => c.json({ error: `沙箱没有接口 ${c.req.method} ${c.req.path}`, code: "not_found" }, 404));

  const server = serve({ fetch: app.fetch, port: opts.port ?? SANDBOX_PORT, hostname: opts.hostname ?? "0.0.0.0" });
  await new Promise<void>((res, rej) => {
    server.once("listening", () => res());
    server.once("error", rej);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      await runner.shutdown();
      const closed = new Promise<void>((r) => server.close(() => r()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closed;
    },
  };
}
