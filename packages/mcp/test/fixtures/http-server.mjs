// streamable HTTP 测试夹具。要求请求头 x-api-key 与 apiKey 一致。
// 默认无状态（每个请求一个 Server + Transport）；sessionful=true 时发会话 id，expireSessions() 模拟服务端重启（旧会话一律 404）。
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildFixtureServer } from "./tools.mjs";

export async function startHttpFixture({ apiKey, sessionful = false } = {}) {
  const sessions = new Map();
  let sessionsCreated = 0;
  const http = createServer(async (req, res) => {
    if (apiKey && req.headers["x-api-key"] !== apiKey) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad key" }));
      return;
    }
    if (sessionful) {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
          return;
        }
        await existing.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          sessionsCreated++;
        },
      });
      await buildFixtureServer("http-fixture").connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const server = buildFixtureServer("http-fixture");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    expireSessions: () => sessions.clear(),
    countSessions: () => sessionsCreated,
    close: () => new Promise((r) => { http.closeAllConnections?.(); http.close(() => r()); }),
  };
}
