// 网关真实冒烟测试（会产生极少量费用）：npx tsx scripts/smoke-gateway.ts [provider/model]
// 进程内启动假 hub + 真实模式网关，经 /api/complete 与 streamProxy 各调一次，核对账本送达。
// 密钥由网关自行从 OPENCODE_API_KEY 或 ~/.pi/agent/auth.json 读取，本脚本不读取也不打印密钥。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamProxy } from "@earendil-works/pi-agent-core";
import { Type, type Model } from "@earendil-works/pi-ai";
import { GatewayClient } from "@court/shared";
import { startGateway } from "../packages/gateway/src/server.ts";
import { startFakeHub, waitFor } from "../packages/gateway/test/fake-hub.ts";

const modelKey = process.argv[2] ?? "opencode-go/deepseek-v4.1-flash";
const [provider, modelId] = [modelKey.slice(0, modelKey.indexOf("/")), modelKey.slice(modelKey.indexOf("/") + 1)];
const GATEWAY_TOKEN = `gw_smoke_${Date.now()}`;
const DEPT_TOKENS = { bingbu: `tok_bingbu_${Date.now()}` };
const dataDir = mkdtempSync(join(tmpdir(), "gw-smoke-"));

const hub = await startFakeHub({ gatewayToken: GATEWAY_TOKEN, deptTokens: DEPT_TOKENS });
const gw = await startGateway({ port: 0, hostname: "127.0.0.1", hubUrl: hub.url, dataDir, configDir: join(import.meta.dirname, "../config"), mode: "real", tokens: { gateway: GATEWAY_TOKEN, depts: DEPT_TOKENS } });

try {
  const info = (await new GatewayClient({ baseUrl: gw.url, token: GATEWAY_TOKEN }).models()).find((m) => m.key === modelKey);
  console.log(`模型 ${modelKey}: available=${info?.available}`);

  // 1. /api/complete（网关 token，system.* 职位）
  let t0 = Date.now();
  const r1 = await new GatewayClient({ baseUrl: gw.url, token: GATEWAY_TOKEN, timeoutMs: 60_000 }).complete({
    model_key: modelKey,
    context: { systemPrompt: "You are terse.", messages: [{ role: "user", content: "Reply with exactly: pong", timestamp: Date.now() }] },
    options: { reasoning: "low", maxTokens: 200 },
    metadata: { post_id: "system.smoke", turn_id: "smoke_complete", call_idx: 0, purpose: "other" },
  });
  const text1 = r1.message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  console.log(`[complete] ${Date.now() - t0}ms stop=${r1.message.stopReason} text=${JSON.stringify(text1)} usage in/out/total=${r1.message.usage.input}/${r1.message.usage.output}/${r1.message.usage.totalTokens} cost=$${r1.message.usage.cost.total.toFixed(8)}${r1.message.errorMessage ? ` error=${r1.message.errorMessage}` : ""}`);

  // 2. streamProxy（部门 token，工具调用）
  const clientModel = { id: modelId, provider, api: info?.api ?? "openai-completions", name: modelId, baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<"openai-completions">;
  t0 = Date.now();
  const s = streamProxy(
    clientModel,
    {
      systemPrompt: "Always use the add tool for arithmetic.",
      messages: [{ role: "user", content: "What is 17 + 25? Use the tool.", timestamp: Date.now() }],
      tools: [{ name: "add", description: "Add two integers and return the sum.", parameters: Type.Object({ a: Type.Integer(), b: Type.Integer() }) }],
    } as never,
    { proxyUrl: gw.url, authToken: DEPT_TOKENS.bingbu, sessionId: `ses_smoke_${Date.now()}`, reasoning: "low", metadata: { post_id: "bingbu.shangshu", official_id: "of_smoke", trace_id: "tr_smoke", turn_id: "smoke_stream", call_idx: 0, purpose: "turn" } as never },
  );
  const counts: Record<string, number> = {};
  for await (const ev of s) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  const r2 = await s.result();
  const call = r2.content.find((b) => b.type === "toolCall");
  console.log(`[stream] ${Date.now() - t0}ms stop=${r2.stopReason} events=${JSON.stringify(counts)} toolCall=${JSON.stringify(call && { name: call.name, arguments: call.arguments })} usage in/out/total=${r2.usage.input}/${r2.usage.output}/${r2.usage.totalTokens} cost=$${r2.usage.cost.total.toFixed(8)}${r2.errorMessage ? ` error=${r2.errorMessage}` : ""}`);

  // 3. 账本送达假 hub
  await waitFor(() => hub.ledger.length >= 2, 10_000);
  for (const e of hub.ledger) console.log(`[ledger] ${e.idem_key} post=${e.post_id} dept=${e.dept} ${e.provider}/${e.model} ok=${e.ok} tokens=${e.total_tokens} cost=$${e.cost.toFixed(8)} ${e.duration_ms}ms`);
  console.log(`[budget] hub 预检次数=${hub.budgetCalls.length}（system.* 网关调用也预检，除非 skip_budget）`);
} finally {
  await gw.close();
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
}
