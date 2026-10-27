// 资产：列表、读取、写入、分享、删除、版本。
import type { Context, Hono } from "hono";
import type { Address, PutAssetReq, Visibility } from "@court/shared";
import { forbidden, type HubCtx } from "../ctx.ts";
import { actingAddress, principal, queryInt, readJson, requireTool } from "../auth.ts";
import type { AssetServiceExt } from "../services/assets.ts";

/** 查看者：部门调用以 acting post（或部门）为准；皇帝可指定 viewer 预览他人视角 */
function viewerOf(c: Context): Address {
  const p = principal(c);
  if (p.kind === "dept") return p.post ? `post:${p.post}` : `dept:${p.dept}`;
  if (p.kind === "gateway") throw forbidden("网关无权查看资产");
  const v = c.req.query("viewer");
  return v || "emperor";
}

export function register(app: Hono, ctx: HubCtx): void {
  const svc = () => ctx.assets as AssetServiceExt;

  app.get("/api/assets", (c) => {
    requireTool(c, "asset_list");
    return c.json(
      ctx.assets.list({
        viewer: viewerOf(c),
        owner: c.req.query("owner") || undefined,
        q: c.req.query("q") || undefined,
        limit: queryInt(c, "limit", 100, 1, 500),
      }),
    );
  });

  app.get("/api/assets/:id/versions", (c) => {
    requireTool(c, "asset_read");
    return c.json(svc().versions(c.req.param("id"), viewerOf(c)));
  });

  app.get("/api/assets/:id", (c) => {
    requireTool(c, "asset_read");
    const v = c.req.query("version");
    return c.json(ctx.assets.read(c.req.param("id"), viewerOf(c), v ? Number(v) : undefined));
  });

  app.put("/api/assets", async (c) => {
    if (principal(c).kind === "gateway") throw forbidden("网关无权写资产");
    requireTool(c, "asset_write");
    const req = await readJson<PutAssetReq>(c);
    req.actor = actingAddress(c, req.actor);
    return c.json(ctx.assets.put(req));
  });

  app.post("/api/assets/:id/share", async (c) => {
    if (principal(c).kind === "gateway") throw forbidden("网关无权分享资产");
    requireTool(c, "asset_share");
    const body = await readJson<{ actor?: string; with?: Address[]; visibility?: Visibility; idem_key?: string }>(c);
    const actor = actingAddress(c, body.actor);
    const key = body.idem_key ? `asset_share:${actor}:${body.idem_key}` : undefined;
    return c.json(ctx.idem.wrap(key, () => svc().share(c.req.param("id"), actor, body.with ?? [], body.visibility)));
  });

  app.delete("/api/assets/:id", (c) => {
    if (principal(c).kind === "gateway") throw forbidden("网关无权删除资产");
    requireTool(c, "asset_delete");
    const actor = actingAddress(c, c.req.query("actor") || undefined);
    svc().remove(c.req.param("id"), actor);
    return c.json({ ok: true as const });
  });
}
