// 测试用假 hub：只提供 broker 拉取的 /api/internal/mcp/state（broker token 鉴权）。
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { McpInternalState } from "@court/shared";

export interface FakeHub {
  url: string;
  state: McpInternalState;
  /** 被拉取次数 */
  fetches: number;
  /** 置 true 时返回 503 */
  down: boolean;
  close(): Promise<void>;
}

export async function startFakeHub(brokerToken: string, initial: McpInternalState): Promise<FakeHub> {
  const app = new Hono();
  const hub: FakeHub = { url: "", state: initial, fetches: 0, down: false, close: async () => undefined };
  app.get("/api/internal/mcp/state", (c) => {
    if (c.req.header("authorization") !== `Bearer ${brokerToken}`) return c.json({ error: "unauthorized", code: "unauthorized" }, 401);
    if (hub.down) return c.json({ error: "维护中", code: "unavailable" }, 503);
    hub.fetches++;
    return c.json(hub.state);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  hub.close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  return hub;
}
