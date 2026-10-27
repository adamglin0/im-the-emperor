// 网关进程入口：读环境变量与共享 token，启动服务，优雅退出。
import { GATEWAY_PORT, sleepMs } from "@court/shared";
import { readSharedTokens } from "./auth.ts";
import { startGateway } from "./server.ts";

const env = process.env;
const dataDir = env.DATA_DIR ?? "./data";
const configDir = env.CONFIG_DIR ?? "./config";
const mode = env.LLM_MODE === "mock" ? "mock" : "real";

async function waitForGatewayToken(): Promise<{ gateway: string; depts: Record<string, string> }> {
  for (let i = 0; ; i++) {
    const shared = readSharedTokens(dataDir);
    const gateway = env.GATEWAY_TOKEN || shared?.gateway;
    if (gateway) return { gateway, depts: shared?.depts ?? {} };
    if (i % 10 === 0) console.log(`[gateway] 等待 GATEWAY_TOKEN 或 ${dataDir}/shared/tokens.json …`);
    await sleepMs(2000);
  }
}

const tokens = await waitForGatewayToken();
const gw = await startGateway({
  port: Number(env.PORT) || GATEWAY_PORT,
  hubUrl: env.HUB_URL,
  dataDir,
  configDir,
  mode,
  tokens: { ...tokens, admin: env.GATEWAY_ADMIN_TOKEN || undefined },
});
console.log(`[gateway] 已启动 ${gw.url}（mode=${mode}，hub=${env.HUB_URL ?? "未配置"}）`);

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[gateway] 收到 ${sig}，正在退出…`);
    const force = setTimeout(() => process.exit(0), 30_000);
    force.unref();
    gw.close().finally(() => process.exit(0));
  });
}
