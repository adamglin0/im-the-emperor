// 鉴权与 ACL：解析请求方身份（皇帝/部门/网关/系统），校验 acting post 与工具授权。
// B 组路由也使用这里导出的 principal / requireActingPost / requireTool / requireEmperor / readJson。
import type { Context, MiddlewareHandler } from "hono";
import type { Address } from "@court/shared";
import { bad, forbidden, HubError, type HubCtx, type Principal } from "./ctx.ts";

interface ReqState {
  ctx: HubCtx;
  principal: Principal;
}
const states = new WeakMap<Request, ReqState>();

const unauthorized = (msg: string) => new HubError(401, "unauthorized", msg);

/**
 * 监听模式：
 * - internal：内部 API 端口（部门/网关/控制面），必须带有效 token，绝不授予皇帝身份；
 * - emperor：皇帝/Web 端口（仅发布到本机），无 Authorization 视为皇帝，带 token 的照常解析。
 */
export type ListenerMode = "internal" | "emperor";

/** 解析身份（不依赖中间件，可单独测试） */
export function resolvePrincipal(ctx: HubCtx, authorization: string | undefined, actingPost: string | undefined, mode: ListenerMode = "emperor"): Principal {
  if (!authorization) {
    if (mode === "internal") throw unauthorized("内部 API 必须携带 Authorization: Bearer <token>（部门/网关/控制面令牌）");
    return { kind: "emperor" };
  }
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) throw unauthorized("Authorization 格式应为 Bearer <token>");
  const token = m[1].trim();
  if (ctx.gatewayToken && token === ctx.gatewayToken) return { kind: "gateway" };
  if (ctx.controlToken && token === ctx.controlToken) return { kind: "system" };
  const dept = ctx.registry.deptByToken(token);
  if (!dept) throw unauthorized("token 无效");
  const p: Principal = { kind: "dept", dept };
  const post = actingPost?.trim();
  if (post) {
    const def = ctx.registry.post(post);
    if (!def || def.dept !== dept) throw forbidden(`X-Acting-Post ${post} 不属于部门 ${dept}`);
    if (!ctx.registry.officialOf(post)) throw forbidden(`职位 ${post} 当前空缺，不能以其名义行事`);
    p.post = post;
  }
  return p;
}

/** 鉴权中间件：所有 /api/* 请求解析身份；无效（或内部端口缺失）token → 401，冒用职位 → 403 */
export function authMiddleware(ctx: HubCtx, mode: ListenerMode = "emperor"): MiddlewareHandler {
  return async (c, next) => {
    const principal = resolvePrincipal(ctx, c.req.header("authorization"), c.req.header("x-acting-post"), mode);
    // 无 token 即皇帝：拒绝浏览器发来的跨站请求（CSRF；text/plain 的 POST 无需预检，readJson 照样解析）。
    // 同源页面（含 vite 代理）为 same-origin，地址栏直接打开为 none；非浏览器客户端不带此头。
    const site = c.req.header("sec-fetch-site");
    const unsafe = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (principal.kind === "emperor" && unsafe && site && site !== "same-origin" && site !== "none") throw forbidden("拒绝跨站请求：请从皇城 Web 页面操作");
    states.set(c.req.raw, { ctx, principal });
    await next();
  };
}

function state(c: Context): ReqState {
  const s = states.get(c.req.raw);
  if (!s) throw new HubError(500, "internal", "鉴权中间件未运行");
  return s;
}

export function principal(c: Context): Principal {
  return state(c).principal;
}

/** 去掉 post: 前缀 */
function stripPost(a: string): string {
  return a.startsWith("post:") ? a.slice(5) : a;
}

/**
 * 校验调用者以哪个职位行事，返回 post_id（皇帝返回 "emperor"）。
 * - 部门调用必须带 X-Acting-Post；body 里声称的 post/actor/caller/from 必须与之一致。
 * - 皇帝（本机 Web，无 token）默认以 "emperor" 行事；若 body 指定了职位则以该职位行事（御前代行，便于测试与人工干预）。
 * - 系统（control token）同皇帝；网关不得以职位行事。
 */
export function requireActingPost(c: Context, bodyPost?: string): string {
  const { ctx, principal: p } = state(c);
  const claimed = typeof bodyPost === "string" && bodyPost ? bodyPost : undefined;
  if (p.kind === "dept") {
    if (!p.post) throw forbidden("缺少 X-Acting-Post 请求头：部门调用必须说明以哪个职位行事");
    if (claimed && stripPost(claimed) !== p.post) throw forbidden(`请求声称以 ${claimed} 行事，与 X-Acting-Post ${p.post} 不符`);
    return p.post;
  }
  if (p.kind === "emperor" || p.kind === "system") {
    if (!claimed || claimed === "emperor") return "emperor";
    if (claimed.startsWith("system:")) {
      if (p.kind === "system") return claimed;
      throw forbidden("system:* 身份只能由皇城内部使用");
    }
    const id = stripPost(claimed);
    if (!ctx.registry.post(id)) throw bad(`职位 ${claimed} 不存在`);
    return id;
  }
  throw forbidden("网关不能以官员职位行事");
}

/** 把 requireActingPost 的结果转为地址（post:x / emperor / system:x） */
export function actingAddress(c: Context, bodyPost?: string): Address {
  const p = requireActingPost(c, bodyPost);
  return p === "emperor" || p.startsWith("system:") ? p : `post:${p}`;
}

/** 工具级 ACL：部门调用须其 acting post 拥有该工具；皇帝与系统放行 */
export function requireTool(c: Context, tool: string): void {
  const { ctx, principal: p } = state(c);
  if (p.kind === "emperor" || p.kind === "system") return;
  if (p.kind === "gateway") throw forbidden(`网关无权调用需要工具 ${tool} 的接口`);
  if (!p.post) throw forbidden("缺少 X-Acting-Post 请求头");
  if (ctx.registry.hasTool(p.post, tool)) return;
  ctx.events.emit({
    type: "acl.denied",
    actor: `post:${p.post}`,
    dept: p.dept,
    summary: `${p.post} 越权尝试：无工具 ${tool}（${c.req.method} ${c.req.path}）`,
    data: { tool, method: c.req.method, path: c.req.path },
  });
  throw forbidden(`你（${p.post}）没有 ${tool} 的权限。此事请交给有职权的部门办理（call_service / send_message）`);
}

/** 仅皇帝（或系统） */
export function requireEmperor(c: Context): void {
  const p = principal(c);
  if (p.kind !== "emperor" && p.kind !== "system") throw forbidden("此接口仅限陛下使用");
}

/** 仅网关（或系统） */
export function requireGateway(c: Context): void {
  const p = principal(c);
  if (p.kind !== "gateway" && p.kind !== "system") throw forbidden("此接口仅限 LLM 网关调用");
}

/** 部门调用只能操作本部门职位 */
export function requireOwnDeptPost(c: Context, postId: string): void {
  const { ctx, principal: p } = state(c);
  const def = ctx.registry.post(postId);
  if (!def) throw new HubError(404, "not_found", `职位 ${postId} 不存在`);
  if (p.kind === "dept" && def.dept !== p.dept) throw forbidden(`部门 ${p.dept} 不能操作他部职位 ${postId}`);
  if (p.kind === "gateway") throw forbidden("网关无权访问收件箱");
}

/** 读取 JSON 请求体（必须是对象） */
export async function readJson<T = Record<string, unknown>>(c: Context): Promise<T> {
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    throw bad("请求体不是合法 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("请求体必须是 JSON 对象");
  return body as T;
}

/** 读取整数查询参数 */
export function queryInt(c: Context, name: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = c.req.query(name);
  if (v === undefined || v === "") return def;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) throw bad(`查询参数 ${name} 必须是整数`);
  return Math.max(min, Math.min(max, n));
}
