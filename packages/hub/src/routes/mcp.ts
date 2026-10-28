// MCP 工具设置：服务器增删改（官员放大权限须皇帝批准）、测试/重启/状态（转 broker 管理面）、授权查询、broker 拉全量配置。
import type { Context, Hono } from "hono";
import { toMcpServerView, type McpServerConfig, type McpServerInput, type McpWriteMeta } from "@court/shared";
import { bad, forbidden, notFound, type HubCtx } from "../ctx.ts";
import { actingAddress, principal, readJson, rejectSystemForMcp, requireEmperor, requireMcpBroker, requireTool } from "../auth.ts";
import { viaMcp } from "../services/mcp.ts";

/** 测试/重启：broker 测试可达 ~120s，stdio 首次启动（拉镜像、npx/uvx 下载）可达 300s，给足时间 */
const TEST_TIMEOUT_MS = 330_000;
const RESTART_TIMEOUT_MS = 330_000;
const STATUS_TIMEOUT_MS = 10_000;

const META_KEYS = ["idem_key", "trace_id", "reason", "expected_version"] as const;

function splitBody(body: Record<string, unknown>): { input: McpServerInput; meta: McpWriteMeta } {
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!(META_KEYS as readonly string[]).includes(k)) input[k] = v;
  return { input: input as McpServerInput, meta: parseMeta(body) };
}

function parseMeta(src: Record<string, unknown>): McpWriteMeta {
  const meta: McpWriteMeta = {};
  if (src.idem_key != null && src.idem_key !== "") meta.idem_key = String(src.idem_key);
  if (src.trace_id != null && src.trace_id !== "") meta.trace_id = String(src.trace_id);
  if (src.reason != null) {
    if (typeof src.reason !== "string") throw bad("reason 必须是字符串");
    if (src.reason.length > 2000) throw bad("reason 最多 2000 字");
    meta.reason = src.reason;
  }
  if (src.expected_version != null && src.expected_version !== "") {
    const v = Number(src.expected_version);
    if (!Number.isInteger(v) || v < 0) throw bad("expected_version 必须是非负整数（取自服务器的 version 字段）");
    meta.expected_version = v;
  }
  return meta;
}

const idemKey = (actor: string, meta: McpWriteMeta) => (meta.idem_key ? `mcp:${actor}:${meta.idem_key}` : undefined);

export function register(app: Hono, ctx: HubCtx): void {
  const svc = () => ctx.mcp;
  app.use("/api/mcp/*", async (c, next) => {
    rejectSystemForMcp(c);
    await next();
  });

  app.get("/api/mcp/servers", (c) => {
    requireTool(c, "mcp_list_servers");
    return c.json(svc().listServers().map(toMcpServerView));
  });

  app.get("/api/mcp/servers/:id", (c) => {
    requireTool(c, "mcp_get_server");
    return c.json(toMcpServerView(svc().getServer(c.req.param("id"))));
  });

  app.post("/api/mcp/servers", async (c) => {
    requireTool(c, "mcp_create_server");
    const actor = actingAddress(c);
    const { input, meta } = splitBody(await readJson(c));
    return c.json(ctx.idem.wrap(idemKey(actor, meta), () => ctx.db.tx(() => svc().createServer(input, actor, meta))));
  });

  app.patch("/api/mcp/servers/:id", async (c) => {
    requireTool(c, "mcp_update_server");
    const actor = actingAddress(c);
    const id = c.req.param("id");
    const { input, meta } = splitBody(await readJson(c));
    return c.json(ctx.idem.wrap(idemKey(actor, meta), () => ctx.db.tx(() => svc().updateServer(id, input, actor, meta))));
  });

  app.delete("/api/mcp/servers/:id", async (c) => {
    requireTool(c, "mcp_delete_server");
    const actor = actingAddress(c);
    const id = c.req.param("id");
    // HubClient 把写元数据放在查询串；也接受 JSON 请求体
    const text = await c.req.text().catch(() => "");
    let body: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        throw bad("请求体不是合法 JSON");
      }
    }
    const meta = parseMeta({ ...body, ...c.req.query() });
    return c.json(ctx.idem.wrap(idemKey(actor, meta), () => ctx.db.tx(() => svc().deleteServer(id, actor, meta))));
  });

  app.post("/api/mcp/servers/:id/test", async (c) => {
    requireTool(c, "mcp_test_server");
    const s = svc().getServer(c.req.param("id"));
    const res = await viaMcp(ctx, () => svc().admin(TEST_TIMEOUT_MS).test(s));
    noteTest(c, s, res.ok, res.error, res.tools.length);
    return c.json(res);
  });

  app.post("/api/mcp/servers/:id/restart", async (c) => {
    requireTool(c, "mcp_test_server");
    const s = svc().getServer(c.req.param("id"));
    const res = await viaMcp(ctx, () => svc().admin(RESTART_TIMEOUT_MS).restart(s.id));
    ctx.events.emit({ type: "mcp.restarted", actor: actorOf(c), subject_type: "mcp_server", subject_id: s.id, summary: `重启 MCP 服务器 ${s.name}（${s.id}）：${res.state}` });
    return c.json(res);
  });

  // 草稿测试：草稿可能是任意命令，仅限皇帝（不保存）
  app.post("/api/mcp/test", async (c) => {
    requireEmperor(c);
    const body = await readJson<{ base_id?: unknown; server?: unknown }>(c);
    if (!body.server || typeof body.server !== "object" || Array.isArray(body.server)) throw bad("server 必填：草稿配置对象（同新建入参）");
    const input = body.server as McpServerInput;
    let base: McpServerConfig | undefined;
    if (body.base_id != null && body.base_id !== "") {
      base = svc().getServerOrNull(String(body.base_id));
      if (!base) throw notFound(`MCP 服务器 ${String(body.base_id)}（base_id 用于沿用其已存密钥）`);
    }
    const id = base?.id ?? (typeof input.id === "string" && input.id.trim() ? input.id.trim() : "draft");
    const draft = svc().normalize(input, base, { id });
    const config: McpServerConfig = { ...draft, version: base?.version ?? 0, updated_at: ctx.now(), updated_by: "emperor" };
    const res = await viaMcp(ctx, () => svc().admin(TEST_TIMEOUT_MS).test(config));
    return c.json(res);
  });

  app.get("/api/mcp/status", async (c) => {
    requireTool(c, "mcp_list_servers");
    return c.json(await viaMcp(ctx, () => svc().admin(STATUS_TIMEOUT_MS).status()));
  });

  app.get("/api/mcp/access", (c) => {
    const post = String(c.req.query("post") ?? "").replace(/^post:/, "").trim();
    if (!post) throw bad("查询参数 post 必填（职位 id，如 bingbu.shangshu）");
    const p = principal(c);
    // 官员可查自己；查他人须 mcp_get_access
    if (!(p.kind === "dept" && p.post === post)) requireTool(c, "mcp_get_access");
    return c.json(svc().accessOf(post));
  });

  app.get("/api/internal/mcp/state", (c) => {
    requireMcpBroker(c);
    return c.json(svc().internalState());
  });

  function actorOf(c: Context): string {
    const p = principal(c);
    if (p.kind === "dept") return p.post ? `post:${p.post}` : `dept:${p.dept}`;
    if (p.kind === "system") return "system:hub";
    if (p.kind === "emperor") return "emperor";
    throw forbidden("无权操作");
  }

  function noteTest(c: Context, s: McpServerConfig, ok: boolean, error: string | undefined, tools: number): void {
    ctx.events.emit({
      type: "mcp.tested",
      actor: actorOf(c),
      subject_type: "mcp_server",
      subject_id: s.id,
      summary: `测试 MCP 服务器 ${s.name}（${s.id}）：${ok ? `通，${tools} 个工具` : `不通 —— ${(error ?? "").slice(0, 160)}`}`.slice(0, 300),
    });
  }
}
