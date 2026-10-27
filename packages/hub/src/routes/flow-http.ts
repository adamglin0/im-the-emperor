// B 组路由公共件：身份 → FlowActor、幂等包装、常用校验。
import type { Context } from "hono";
import { requireActingPost, requireOwnDeptPost } from "../auth.ts";
import { bad, type HubCtx } from "../ctx.ts";
import type { FlowActor } from "../services/workflow-tasks.ts";

export { readJson, requireTool, requireEmperor, queryInt, principal } from "../auth.ts";

/** 解析调用者：部门调用 → 其 acting post；皇帝/系统 → emperor（或 body 指定的代行职位） */
export function flowActor(c: Context, bodyPost?: unknown, callerSpan?: unknown): FlowActor {
  const p = requireActingPost(c, typeof bodyPost === "string" ? bodyPost : undefined);
  if (p === "emperor") return { addr: "emperor" };
  if (p.startsWith("system:")) return { addr: p };
  const a: FlowActor = { addr: `post:${p}`, post: p };
  if (typeof callerSpan === "string" && callerSpan && callerSpan.length <= 100) a.span = callerSpan;
  return a;
}

/** 必须以职位身份行事（议事发言等） */
export function postActor(c: Context, bodyPost: unknown, what: string): FlowActor & { post: string } {
  const a = flowActor(c, bodyPost);
  if (!a.post) throw bad(`${what}须以职位身份执行：请在请求体 post 中写明你的职位（post_id）`);
  return a as FlowActor & { post: string };
}

/** 幂等：同一 idem_key 重放返回首次结果 */
export function withIdem<T>(ctx: HubCtx, scope: string, idemKey: unknown, fn: () => T): T {
  const key = typeof idemKey === "string" && idemKey ? `flow:${scope}:${idemKey}` : undefined;
  return ctx.idem.wrap(key, fn);
}

export { requireOwnDeptPost };
