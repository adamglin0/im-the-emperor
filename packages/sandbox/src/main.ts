// 沙箱进程入口：SANDBOX_TOKEN 或 tokens.json 的 sandbox 字段；SANDBOX_ROOT 默认 /workspaces。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_PORT, sleepMs } from "@court/shared";
import { startSandbox } from "./server.ts";

const env = process.env;

function readTokenFile(): string | undefined {
  const file = join(env.DATA_DIR ?? "./data", "shared", "tokens.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")).sandbox;
  } catch {
    return undefined;
  }
}

async function waitForToken(): Promise<string> {
  for (let i = 0; ; i++) {
    const token = env.SANDBOX_TOKEN || readTokenFile();
    if (token) return token;
    if (i % 10 === 0) console.log("[sandbox] 等待 SANDBOX_TOKEN 或 tokens.json …");
    await sleepMs(2000);
  }
}

const sb = await startSandbox({ port: Number(env.PORT) || SANDBOX_PORT, root: env.SANDBOX_ROOT ?? "/workspaces", token: await waitForToken() });
console.log(`[sandbox] 已启动 ${sb.url}（root=${env.SANDBOX_ROOT ?? "/workspaces"}）`);

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    sb.close().finally(() => process.exit(0));
  });
}
