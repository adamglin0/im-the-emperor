// 模型提供商设置：皇帝专用，原样转网关管理接口（凭据只存网关，hub 不落盘、不记请求体）。
import type { Context, Hono } from "hono";
import { ApiError, GatewayClient, type CustomProviderSpec, type ProviderAuthType, type ProviderLoginSession } from "@court/shared";
import { HubError, type HubCtx } from "../ctx.ts";
import { readJson, requireEmperor } from "../auth.ts";

export function gatewayAdmin(ctx: HubCtx, timeoutMs = 30_000): GatewayClient {
  return new GatewayClient({ baseUrl: ctx.gatewayUrl, token: ctx.gatewayAdminToken || ctx.gatewayToken, timeoutMs });
}

/** 网关错误 → hub 错误（状态码与信息原样透出；连不上 → 503） */
async function viaGateway<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) throw new HubError(e.status, e.code, e.message);
    throw new HubError(503, "unavailable", `LLM 网关不可达：${(e as Error).message}`);
  }
}

export function register(app: Hono, ctx: HubCtx): void {
  const gw = gatewayAdmin(ctx);
  // 登录成功只记一次事件
  const seenDone = new Set<string>();
  const noteLogin = (s: ProviderLoginSession) => {
    if (s.state !== "done" || seenDone.has(s.id)) return s;
    seenDone.add(s.id);
    if (seenDone.size > 500) seenDone.clear();
    ctx.events.emit({
      type: "provider.configured",
      actor: "emperor",
      subject_type: "provider",
      subject_id: s.provider,
      summary: `陛下为提供商 ${s.provider} 配置了${s.type === "oauth" ? "订阅登录" : " API 密钥"}`,
    });
    return s;
  };
  const guard = (c: Context) => requireEmperor(c);

  app.get("/api/providers", async (c) => {
    guard(c);
    return c.json(await viaGateway(() => gw.adminProviders()));
  });

  app.get("/api/providers/:id/models", async (c) => {
    guard(c);
    return c.json(await viaGateway(() => gw.adminProviderModels(c.req.param("id"))));
  });

  app.get("/api/providers/:id/check", async (c) => {
    guard(c);
    return c.json(await viaGateway(() => gw.adminCheckModel(c.req.param("id"), c.req.query("model_id") ?? "")));
  });

  app.post("/api/providers", async (c) => {
    guard(c);
    const spec = await readJson<CustomProviderSpec>(c);
    const info = await viaGateway(() => gw.adminSaveProvider(spec));
    ctx.events.emit({
      type: "provider.saved",
      actor: "emperor",
      subject_type: "provider",
      subject_id: info.id,
      summary: `陛下保存自定义提供商 ${info.name}（${info.id}，${info.apis.join("/")}）${spec.api_key ? "，并更新密钥" : ""}`,
    });
    return c.json(info);
  });

  app.delete("/api/providers/:id", async (c) => {
    guard(c);
    const id = c.req.param("id");
    const res = await viaGateway(() => gw.adminDeleteProvider(id));
    ctx.events.emit({ type: "provider.deleted", actor: "emperor", subject_type: "provider", subject_id: id, summary: `陛下删除自定义提供商 ${id}` });
    return c.json(res);
  });

  app.delete("/api/providers/:id/credential", async (c) => {
    guard(c);
    const id = c.req.param("id");
    const info = await viaGateway(() => gw.adminLogout(id));
    ctx.events.emit({ type: "provider.logout", actor: "emperor", subject_type: "provider", subject_id: id, summary: `陛下清除提供商 ${id} 的已存凭据` });
    return c.json(info);
  });

  app.post("/api/providers/:id/login", async (c) => {
    guard(c);
    const body = await readJson<{ type?: ProviderAuthType }>(c);
    return c.json(await viaGateway(() => gw.adminStartLogin(c.req.param("id"), body?.type === "oauth" ? "oauth" : "api_key")));
  });

  app.get("/api/provider-logins/:sid", async (c) => {
    guard(c);
    return c.json(noteLogin(await viaGateway(() => gw.adminLogin(c.req.param("sid")))));
  });

  app.post("/api/provider-logins/:sid/answer", async (c) => {
    guard(c);
    const body = await readJson<{ seq?: number; value?: string }>(c);
    return c.json(noteLogin(await viaGateway(() => gw.adminAnswerLogin(c.req.param("sid"), Number(body?.seq), String(body?.value ?? "")))));
  });

  app.delete("/api/provider-logins/:sid", async (c) => {
    guard(c);
    return c.json(await viaGateway(() => gw.adminCancelLogin(c.req.param("sid"))));
  });

  app.post("/api/providers/:id/test", async (c) => {
    guard(c);
    const body = await readJson<{ model_id?: string }>(c).catch(() => ({}) as { model_id?: string });
    const slow = gatewayAdmin(ctx, 150_000);
    const res = await viaGateway(() => slow.adminTestProvider(c.req.param("id"), body?.model_id || undefined));
    ctx.events.emit({
      type: "provider.tested",
      actor: "emperor",
      subject_type: "provider",
      subject_id: c.req.param("id"),
      summary: `连通测试 ${res.model}：${res.ok ? `通（${res.latency_ms}ms）` : `不通 —— ${(res.error ?? "").slice(0, 120)}`}`,
    });
    return c.json(res);
  });
}
