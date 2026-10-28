// 测试用 MCP 服务器（低层 Server，直接给 JSON Schema）。stdio 与 streamable HTTP 两个夹具共用。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// 1x1 透明 PNG
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const TOOLS = [
  { name: "echo", description: "原样返回文本", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "总是返回 isError", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "等待 ms 毫秒后返回", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "image", description: "返回一张小图", inputSchema: { type: "object", properties: {} } },
  { name: "big_image", description: "返回一张超过 1MB 的图", inputSchema: { type: "object", properties: {} } },
  { name: "env", description: "读取环境变量", inputSchema: { type: "object", properties: { key: { type: "string" } } } },
  { name: "pid", description: "返回进程号", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "进程立即退出", inputSchema: { type: "object", properties: {} } },
];

export function buildFixtureServer(name = "fixture") {
  const server = new Server({ name, version: "9.9.9" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    const text = (t) => ({ content: [{ type: "text", text: t }] });
    switch (req.params.name) {
      case "echo":
        return { ...text(`echo:${args.text}`), structuredContent: { echoed: args.text } };
      case "fail":
        return { content: [{ type: "text", text: "boom" }], isError: true };
      case "slow":
        await new Promise((r) => setTimeout(r, Number(args.ms ?? 1000)));
        return text("slept");
      case "image":
        return { content: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }] };
      case "big_image":
        return { content: [{ type: "image", data: "A".repeat(1_500_000), mimeType: "image/png" }] };
      case "env":
        return text(process.env[String(args.key)] ?? "(unset)");
      case "pid":
        return text(String(process.pid));
      case "crash":
        setTimeout(() => process.exit(1), 5);
        return new Promise(() => {});
      default:
        throw new Error(`unknown tool ${req.params.name}`);
    }
  });
  return server;
}
