// 部门容器入口。环境变量：DEPT（必填）、HUB_URL、GATEWAY_URL、SANDBOX_URL、MCP_URL、DATA_DIR、PORT、
// DEPT_TOKEN / CONTROL_TOKEN / SANDBOX_TOKEN（缺省读 DATA_DIR/shared/tokens.json，未就绪则重试）、DEPT_URL_OVERRIDES（JSON）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { DEPT_PORT, sleepMs } from "@court/shared";
import { DeptRuntime, type DeptTokens } from "./runtime.ts";
import { createDeptApp } from "./server.ts";
import type { Limits, ToolsFactory } from "./official.ts";
import { buildTools } from "./tools/index.ts";

export interface StartDeptOptions {
  dept: string;
  hubUrl: string;
  gatewayUrl: string;
  sandboxUrl?: string;
  /** MCP 中转站地址（runDeptFromEnv 缺省取 env MCP_URL 或 http://mcp:8300）；不填 = 不装 MCP 工具 */
  mcpUrl?: string;
  dataDir: string;
  port?: number;
  hostname?: string;
  tokens?: DeptTokens;
  /** 测试用：替代 streamProxy */
  streamFn?: StreamFn;
  deptUrlResolver?: (dept: string) => string;
  deptUrlOverrides?: Record<string, string>;
  /** 测试用：替代 tools/index.ts 的 buildTools */
  buildTools?: ToolsFactory;
  limits?: Partial<Limits>;
}

export interface DeptHandle {
  url: string;
  runtime: DeptRuntime;
  /** drainMs：当前轮收尾时限（默认 30s） */
  close(drainMs?: number): Promise<void>;
}

interface TokensFile {
  depts?: Record<string, string>;
  gateway?: string;
  control?: string;
  sandbox?: string;
}

/** 读 token：环境变量优先，否则等待 hub 写出 shared/tokens.json */
export async function resolveTokens(dataDir: string, dept: string, env: NodeJS.ProcessEnv = process.env): Promise<DeptTokens> {
  if (env.DEPT_TOKEN) return { dept: env.DEPT_TOKEN, control: env.CONTROL_TOKEN, sandbox: env.SANDBOX_TOKEN };
  const file = join(dataDir, "shared", "tokens.json");
  for (let i = 0; ; i++) {
    if (existsSync(file)) {
      try {
        const t = JSON.parse(readFileSync(file, "utf8")) as TokensFile;
        const deptToken = t.depts?.[dept];
        if (deptToken) return { dept: deptToken, control: env.CONTROL_TOKEN ?? t.control, sandbox: env.SANDBOX_TOKEN ?? t.sandbox };
      } catch {
        /* 写入中，重试 */
      }
    }
    if (i % 15 === 0) console.log(`[dept:${dept}] 等待 ${file} 中的部门 token…`);
    await sleepMs(2_000);
  }
}

export function parseDeptUrlOverrides(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, string>) : undefined;
  } catch {
    console.warn("DEPT_URL_OVERRIDES 不是合法 JSON，已忽略");
    return undefined;
  }
}

export async function startDept(opts: StartDeptOptions): Promise<DeptHandle> {
  const tokens = opts.tokens ?? (await resolveTokens(opts.dataDir, opts.dept));
  const runtime = new DeptRuntime({
    dept: opts.dept,
    hubUrl: opts.hubUrl,
    gatewayUrl: opts.gatewayUrl,
    sandboxUrl: opts.sandboxUrl,
    mcpUrl: opts.mcpUrl,
    dataDir: opts.dataDir,
    tokens,
    buildTools: opts.buildTools ?? buildTools,
    streamFn: opts.streamFn,
    deptUrlResolver: opts.deptUrlResolver,
    deptUrlOverrides: opts.deptUrlOverrides,
    limits: opts.limits,
  });
  const app = createDeptApp(runtime, { hubUrl: opts.hubUrl, controlToken: tokens.control });
  let server!: ReturnType<typeof serve>;
  const info = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: app.fetch, port: opts.port ?? DEPT_PORT, hostname: opts.hostname }, (i) => resolve(i));
  });
  const host = info.address === "::" || info.address === "0.0.0.0" ? "127.0.0.1" : info.address;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${info.port}`;
  await runtime.start();
  let closed = false;
  return {
    url,
    runtime,
    async close(drainMs?: number) {
      if (closed) return;
      closed = true;
      await runtime.stop(drainMs);
      await new Promise<void>((resolve) => {
        const s = server as unknown as { close(cb: () => void): void; closeAllConnections?: () => void };
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
    },
  };
}

/** 从环境变量启动，并处理 SIGTERM/SIGINT 优雅停机 */
export async function runDeptFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<DeptHandle> {
  const dept = env.DEPT;
  if (!dept) throw new Error("缺少环境变量 DEPT");
  const handle = await startDept({
    dept,
    hubUrl: env.HUB_URL ?? "http://hub:8000",
    gatewayUrl: env.GATEWAY_URL ?? "http://gateway:8100",
    sandboxUrl: env.SANDBOX_URL ?? "http://sandbox:8200",
    mcpUrl: env.MCP_URL ?? "http://mcp:8300",
    dataDir: env.DATA_DIR ?? "./data",
    port: env.PORT ? Number(env.PORT) : DEPT_PORT,
    deptUrlOverrides: parseDeptUrlOverrides(env.DEPT_URL_OVERRIDES),
  });
  console.log(`[dept:${dept}] 官署开门：${handle.url}`);
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[dept:${dept}] 收到 ${sig}，停止新轮次并收尾…`);
    const hard = setTimeout(() => process.exit(1), 38_000);
    hard.unref();
    try {
      // 预算（stop_grace_period 40s）：收尾 22s + 中止后 5s + 循环 5s + 末次心跳 ≤3s + 刷 outbox ≤5s < 38s 硬退出
      await handle.close(22_000);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return handle;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  runDeptFromEnv().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
