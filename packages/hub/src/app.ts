// HTTP 应用：鉴权、错误映射、全部路由、静态 Web（SPA 回退）。
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { HubError, type HubCtx } from "./ctx.ts";
import { authMiddleware, type ListenerMode } from "./auth.ts";
// A 组路由
import * as registryRoutes from "./routes/registry.ts";
import * as messagesRoutes from "./routes/messages.ts";
import * as notificationsRoutes from "./routes/notifications.ts";
import * as schedulesRoutes from "./routes/schedules.ts";
import * as assetsRoutes from "./routes/assets.ts";
import * as ledgerRoutes from "./routes/ledger.ts";
import * as configRoutes from "./routes/config.ts";
import * as personnelRoutes from "./routes/personnel.ts";
import * as eventsRoutes from "./routes/events.ts";
import * as emperorCoreRoutes from "./routes/emperor_core.ts";
import * as liveRoutes from "./routes/live.ts";
// B 组路由
import * as deliberationsRoutes from "./routes/deliberations.ts";
import * as edictsRoutes from "./routes/edicts.ts";
import * as tasksRoutes from "./routes/tasks.ts";
import * as servicesRoutes from "./routes/services.ts";
import * as briefingRoutes from "./routes/briefing.ts";
import * as examsRoutes from "./routes/exams.ts";
import * as auditRoutes from "./routes/audit.ts";
import * as tracesRoutes from "./routes/traces.ts";
import * as emperorFlowRoutes from "./routes/emperor_flow.ts";
import * as providersRoutes from "./routes/providers.ts";

type RouteModule = { register: (app: Hono, ctx: HubCtx) => void };

const ROUTES: RouteModule[] = [
  registryRoutes,
  messagesRoutes,
  notificationsRoutes,
  schedulesRoutes,
  assetsRoutes,
  ledgerRoutes,
  configRoutes,
  personnelRoutes,
  eventsRoutes,
  emperorCoreRoutes,
  liveRoutes,
  deliberationsRoutes,
  edictsRoutes,
  tasksRoutes,
  servicesRoutes,
  briefingRoutes,
  examsRoutes,
  auditRoutes,
  tracesRoutes,
  emperorFlowRoutes,
  providersRoutes,
];

export interface AppOptions {
  /** internal = 内部 API（必须带 token，不托管 Web）；emperor = 皇帝/Web 端口（默认） */
  mode?: ListenerMode;
  /** 前端构建产物目录（默认 packages/web/dist），仅 emperor 模式托管 */
  webDir?: string;
}

export function buildApp(ctx: HubCtx, opts: AppOptions = {}): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HubError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    // node:sqlite 唯一约束冲突等：给出可读信息
    const msg = (err as Error)?.message ?? String(err);
    if (/UNIQUE constraint failed/.test(msg)) return c.json({ error: `数据冲突：${msg}`, code: "invalid_state" }, 409);
    console.error(`[hub] ${c.req.method} ${c.req.path} 内部错误：`, err);
    return c.json({ error: `皇城内部错误：${msg}`, code: "internal" }, 500);
  });

  const mode = opts.mode ?? "emperor";
  app.use("/api/*", authMiddleware(ctx, mode));
  for (const m of ROUTES) m.register(app, ctx);

  app.all("/api/*", (c) => c.json({ error: `接口不存在：${c.req.method} ${c.req.path}`, code: "not_found" }, 404));

  if (mode === "internal") {
    app.all("/*", (c) => c.json({ error: "内部 API 端口不提供 Web 页面", code: "not_found" }, 404));
    return app;
  }

  // 静态 Web：存在的文件直接返回，其余非 /api 路径回退 index.html（SPA）
  const webDir = resolve(opts.webDir ?? "packages/web/dist");
  const indexFile = join(webDir, "index.html");
  // 带哈希的 assets 永久缓存；index.html 每次校验，重新部署后浏览器即拿到新版
  const cacheHeader = (path: string) => (/\/assets\//.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
  if (existsSync(webDir)) app.use("/*", serveStatic({ root: webDir, onFound: (path, c) => c.header("Cache-Control", cacheHeader(path)) }));
  app.get("/*", (c) => {
    c.header("Cache-Control", "no-cache");
    if (existsSync(indexFile)) return c.html(readFileSync(indexFile, "utf8"));
    return c.text("皇城 hub 运行中。Web 尚未构建（npm run build:web）。", 200);
  });

  return app;
}
