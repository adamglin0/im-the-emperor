// MCP 中转站进程入口。环境变量：PORT、HUB_URL、MCP_TOKEN（缺省读 DATA_DIR/hub/tokens.json 的 mcp）、
// MCP_STDIO_RUNNER（docker|local，默认 docker）、MCP_BLOCKED_HOSTS（逗号分隔）、DOCKER_BIN、MCP_CONTAINER_OWNER、MCP_POLL_MS、MCP_IDLE_MS。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_PORT, sleepMs } from "@court/shared";
import { logEvent } from "./log.ts";
import { startMcp } from "./server.ts";
import type { StdioRunner } from "./transports.ts";

const env = process.env;

function readTokenFile(): string | undefined {
  const file = join(env.DATA_DIR ?? "./data", "hub", "tokens.json");
  if (!existsSync(file)) return undefined;
  try {
    const token = JSON.parse(readFileSync(file, "utf8")).mcp;
    return typeof token === "string" && token ? token : undefined;
  } catch {
    return undefined;
  }
}

async function waitForToken(): Promise<string> {
  for (let i = 0; ; i++) {
    const token = env.MCP_TOKEN || readTokenFile();
    if (token) return token;
    if (i % 10 === 0) logEvent("info", "waiting_token", { message: "等待 MCP_TOKEN 或 DATA_DIR/hub/tokens.json 的 mcp 字段 …" });
    await sleepMs(2000);
  }
}

function parseRunner(raw: string | undefined): StdioRunner {
  const v = (raw ?? "docker").trim();
  if (v === "docker" || v === "local") return v;
  throw new Error(`MCP_STDIO_RUNNER 只能是 docker 或 local，收到 ${v}`);
}

const positive = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const broker = await startMcp({
  port: Number(env.PORT) || MCP_PORT,
  hubUrl: env.HUB_URL ?? "http://hub:8000",
  token: await waitForToken(),
  runner: parseRunner(env.MCP_STDIO_RUNNER),
  blockedHosts: (env.MCP_BLOCKED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  dockerBin: env.DOCKER_BIN || undefined,
  containerOwner: env.MCP_CONTAINER_OWNER || undefined,
  pollMs: positive(env.MCP_POLL_MS),
  idleMs: positive(env.MCP_IDLE_MS),
});

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    // 关闭会逐个停掉 stdio 容器，给足时间但不无限等
    const force = setTimeout(() => process.exit(0), 30_000);
    force.unref();
    broker.close().finally(() => process.exit(0));
  });
}
