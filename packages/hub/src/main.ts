// 皇城 hub 启动：配置 → 档案库 → 服务装配（HubCtx）→ 播种 → HTTP → 后台循环。
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { LIMITS, loadCourtConfig, loadModelsConfig, HUB_PORT, MCP_PORT } from "@court/shared";
import { Db } from "./db.ts";
import type { HubCtx } from "./ctx.ts";
import { buildApp } from "./app.ts";
import { ensureTokens, seed, type HubTokens } from "./seed.ts";
import { createEvents } from "./services/events.ts";
import { createIdempotency } from "./services/idempotency.ts";
import { createRegistry } from "./services/registry.ts";
import { createDoorbell } from "./services/doorbell.ts";
import { createMessages } from "./services/messages.ts";
import { createNotifications } from "./services/notifications.ts";
import { createApprovals } from "./services/approvals.ts";
import { createLedger } from "./services/ledger.ts";
import { createAssets } from "./services/assets.ts";
import { createSchedules } from "./services/schedules.ts";
import { createStatuses, createTransition } from "./services/misc.ts";
import { createWorkflow } from "./services/workflow.ts";
import { createBriefing } from "./services/briefing.ts";
import { createExams } from "./services/exams.ts";
import { createAudit } from "./services/audit.ts";
import { createMcp } from "./services/mcp.ts";

export interface CreateHubOptions {
  dataDir: string;
  configDir: string;
  /** 内部 API 端口（必须带 token）；0 = 随机端口 */
  port?: number;
  /** 皇帝/Web 端口（无 token 即皇帝，仅应发布到本机）；0 = 随机端口 */
  emperorPort?: number;
  hostname?: string;
  gatewayUrl?: string;
  /** 网关管理接口 token（缺省读环境变量 GATEWAY_ADMIN_TOKEN，再缺省退回网关 token） */
  gatewayAdminToken?: string;
  /** MCP 中转站地址（缺省读环境变量 MCP_URL，再缺省 http://mcp:8300）；启动后可改 ctx.mcpUrl */
  mcpUrl?: string;
  webDir?: string;
  now?: () => number;
  /** 是否启动后台循环（调度器、看门狗、稽查、考场、备份、清理）；测试传 false */
  startLoops?: boolean;
}

export interface HubHandle {
  ctx: HubCtx;
  app: Hono;
  server: ServerType;
  emperorServer: ServerType;
  /** 内部 API 地址（部门/网关/控制面，必须带 token） */
  url: string;
  /** 皇帝/Web 地址 */
  emperorUrl: string;
  tokens: HubTokens;
  close(): Promise<void>;
}

const AUDIT_EVERY_MS = 5 * 60_000;
const HOUSEKEEPING_EVERY_MS = 3600_000;
const EVENT_RETENTION_MS = 14 * 86_400_000;
const IDEM_RETENTION_MS = 7 * 86_400_000;
const BACKUP_KEEP = 7;
const BUDGET_ALERT_RETENTION_MS = 2 * 86_400_000;
/** 皇帝/Web 端口默认值 */
export const EMPEROR_PORT = 8001;
const DEFAULT_MCP_URL = `http://mcp:${MCP_PORT}`;

/** 装配 HubCtx：先建空对象，再逐个挂服务（服务之间经 ctx 惰性互引；注册类依赖须按序） */
export function assembleCtx(
  base: Pick<HubCtx, "db" | "court" | "modelsCfg" | "dataDir" | "gatewayUrl" | "gatewayToken" | "controlToken" | "now"> & { gatewayAdminToken?: string; mcpUrl?: string; mcpToken?: string },
): HubCtx {
  const ctx = { ...base, mcpUrl: base.mcpUrl ?? DEFAULT_MCP_URL, mcpToken: base.mcpToken ?? "" } as HubCtx;
  ctx.transition = createTransition(ctx);
  ctx.statuses = createStatuses(ctx);
  ctx.events = createEvents(ctx);
  ctx.idem = createIdempotency(ctx);
  ctx.registry = createRegistry(ctx);
  ctx.doorbell = createDoorbell(ctx);
  ctx.messages = createMessages(ctx);
  ctx.notifications = createNotifications(ctx);
  ctx.approvals = createApprovals(ctx); // 依赖 notifications.onResolve
  ctx.ledger = createLedger(ctx); // 依赖 approvals.onApprove
  ctx.assets = createAssets(ctx);
  ctx.schedules = createSchedules(ctx); // 依赖 approvals.onApprove
  ctx.workflow = createWorkflow(ctx);
  ctx.briefing = createBriefing(ctx);
  ctx.exams = createExams(ctx);
  ctx.audit = createAudit(ctx);
  ctx.mcp = createMcp(ctx); // 依赖 approvals.onApprove/onReject
  return ctx;
}

const ymd = (ts: number) => new Date(ts + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");

/** 每日备份（今日已备则跳过），保留最近 7 份 */
export function dailyBackup(ctx: HubCtx): void {
  const dir = join(ctx.dataDir, "hub", "backups");
  const file = join(dir, `court-${ymd(ctx.now())}.db`);
  if (existsSync(file)) return;
  ctx.db.backup(file);
  const all = readdirSync(dir)
    .filter((f) => /^court-\d{8}\.db$/.test(f))
    .sort();
  for (const f of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* 忽略 */
    }
  }
}

/** 清理：14 天前的事件、7 天前的幂等记录、2 天前的预算告警标记（分批，避免长事务） */
export function housekeeping(ctx: HubCtx): void {
  const now = ctx.now();
  for (let i = 0; i < 50; i++) {
    const r = ctx.db.run("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? LIMIT 5000)", now - EVENT_RETENTION_MS);
    if (r.changes < 5000) break;
  }
  // 预算熔断「每日一次」标记：保留 2 天（v 为写入时间戳）
  ctx.db.run("DELETE FROM meta WHERE k IN (SELECT k FROM meta WHERE substr(k, 1, 13) = 'budget_alert:' AND CAST(v AS INTEGER) < ? LIMIT 5000)", now - BUDGET_ALERT_RETENTION_MS);
  for (let i = 0; i < 50; i++) {
    const r = ctx.db.run("DELETE FROM idempotency WHERE key IN (SELECT key FROM idempotency WHERE at < ? LIMIT 5000)", now - IDEM_RETENTION_MS);
    if (r.changes < 5000) break;
  }
}

/** 首次改用 HUB_DB_PATH 时，把旧位置的档案库（含 WAL）整理拷贝过去；旧文件保留不动 */
function migrateLegacyDb(legacy: string, target: string): void {
  if (resolve(legacy) === resolve(target) || existsSync(target) || !existsSync(legacy)) return;
  const old = new Db(legacy);
  try {
    old.backup(target);
    console.log(`[hub] 档案库已迁移：${legacy} → ${target}（旧文件保留）`);
  } finally {
    old.close();
  }
}

export async function createHub(opts: CreateHubOptions): Promise<HubHandle> {
  const dataDir = resolve(opts.dataDir);
  const configDir = resolve(opts.configDir);
  const court = loadCourtConfig(join(configDir, "court.yaml"));
  const modelsCfg = loadModelsConfig(join(configDir, "models.yaml"));
  // 档案库位置：默认 DATA_DIR/hub/court.db；HUB_DB_PATH 可指向独立卷（macOS 上 SQLite WAL 不宜放在宿主绑定卷上）
  const dbPath = process.env.HUB_DB_PATH ? resolve(process.env.HUB_DB_PATH) : join(dataDir, "hub", "court.db");
  migrateLegacyDb(join(dataDir, "hub", "court.db"), dbPath);
  const db = new Db(dbPath);
  db.migrate();
  const tokens = ensureTokens(db);
  const ctx = assembleCtx({
    db,
    court,
    modelsCfg,
    dataDir,
    gatewayUrl: opts.gatewayUrl ?? "http://gateway:8100",
    gatewayToken: tokens.gateway,
    gatewayAdminToken: opts.gatewayAdminToken ?? (process.env.GATEWAY_ADMIN_TOKEN || undefined),
    controlToken: tokens.control,
    mcpUrl: opts.mcpUrl ?? (process.env.MCP_URL || DEFAULT_MCP_URL),
    mcpToken: tokens.mcp,
    now: opts.now ?? Date.now,
  });
  seed(ctx, tokens);
  // 两个监听共用同一 ctx：内部 API 必须带 token；皇帝/Web 端口无 token 即皇帝
  const app = buildApp(ctx, { mode: "internal" });
  const emperorApp = buildApp(ctx, { mode: "emperor", webDir: opts.webDir });
  const listen = (a: Hono, port: number) =>
    new Promise<ServerType>((res, rej) => {
      const s = serve({ fetch: a.fetch, port, hostname: opts.hostname }, () => res(s));
      s.once("error", rej);
    });
  const host = !opts.hostname || opts.hostname === "0.0.0.0" || opts.hostname === "::" ? "127.0.0.1" : opts.hostname;
  const server = await listen(app, opts.port ?? HUB_PORT);
  let emperorServer: ServerType;
  try {
    emperorServer = await listen(emperorApp, opts.emperorPort ?? EMPEROR_PORT);
  } catch (e) {
    server.close();
    db.close();
    throw e;
  }
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  const emperorUrl = `http://${host}:${(emperorServer.address() as AddressInfo).port}`;

  const timers: NodeJS.Timeout[] = [];
  const guard = (name: string, fn: () => void) => () => {
    try {
      fn();
    } catch (e) {
      console.error(`[hub] ${name} 出错：`, e);
    }
  };
  if (opts.startLoops !== false) {
    timers.push(setInterval(guard("调度器", () => ctx.schedules.tick(ctx.now())), LIMITS.schedulerTickMs));
    timers.push(setInterval(guard("看门狗", () => ctx.workflow?.watchdogTick?.(ctx.now())), LIMITS.watchdogMs));
    timers.push(setInterval(guard("稽查", () => ctx.audit?.runRules?.(ctx.now())), AUDIT_EVERY_MS));
    timers.push(
      setInterval(
        guard("清理与备份", () => {
          housekeeping(ctx);
          dailyBackup(ctx);
        }),
        HOUSEKEEPING_EVERY_MS,
      ),
    );
    guard("启动备份", () => dailyBackup(ctx))();
    guard("考场", () => ctx.exams?.startRunner?.())();
  }

  let closed = false;
  return {
    ctx,
    app,
    server,
    emperorServer,
    url,
    emperorUrl,
    tokens,
    async close() {
      if (closed) return;
      closed = true;
      for (const t of timers) clearInterval(t);
      const shut = (s: ServerType) =>
        new Promise<void>((res) => {
          s.close(() => res());
          // SSE 等长连接：强制断开
          (s as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
      await Promise.all([shut(server), shut(emperorServer)]);
      db.close();
    },
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const hub = await createHub({
    dataDir: env.DATA_DIR ?? "./data",
    configDir: env.CONFIG_DIR ?? "./config",
    port: Number(env.PORT ?? HUB_PORT),
    emperorPort: Number(env.EMPEROR_PORT ?? EMPEROR_PORT),
    hostname: env.HOST ?? "0.0.0.0",
    gatewayUrl: env.GATEWAY_URL ?? "http://gateway:8100",
    webDir: env.WEB_DIR ?? "packages/web/dist",
    startLoops: true,
  });
  console.log(`[hub] 皇城已开：内部 API ${hub.url}，皇帝/Web ${hub.emperorUrl}（名册 v${hub.ctx.registry.version()}${hub.ctx.registry.isHalted() ? "，罢朝中" : ""}）`);
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[hub] 收到 ${sig}，关闭中…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    hub
      .close()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  main().catch((e) => {
    console.error("[hub] 启动失败：", e);
    process.exit(1);
  });
}
