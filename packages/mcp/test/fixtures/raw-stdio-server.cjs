// 无依赖的极简 stdio MCP 服务器（换行分隔 JSON-RPC），用于真实 docker 测试（容器内无 SDK）。
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "raw", version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "whoami", description: "容器信息", inputSchema: { type: "object", properties: {} } }] } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `secret=${process.env.FIXTURE_SECRET ?? ""};home=${process.env.HOME}` }] } });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
