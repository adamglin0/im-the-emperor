// 皇帝流程接口：开议/续议、颁旨、诏令动作（撤回、墨敕、坚持、修改、御览、重试）。
import type { Hono } from "hono";
import type { EmperorEdictActionReq } from "@court/shared";
import type { HubCtx } from "../ctx.ts";
import { workflowOf } from "../services/workflow.ts";
import { optBool, optNum, optStr, reqEnum, reqStr } from "../services/flow-util.ts";
import { readJson, requireEmperor } from "./flow-http.ts";

const ACTIONS: EmperorEdictActionReq["action"][] = ["withdraw", "force_approve", "insist", "revise", "accept_report", "retry"];

export function register(app: Hono, ctx: HubCtx): void {
  const wf = () => workflowOf(ctx);

  app.post("/api/emperor/council", async (c) => {
    requireEmperor(c);
    const b = await readJson(c);
    const content = reqStr(b.content, "content（陛下发言）", 8000);
    const id = optStr(b.deliberation_id, "deliberation_id", 100);
    const d = wf().emperorSpeaks(content, id);
    return c.json(wf().council.detail(d.id));
  });

  app.post("/api/emperor/edicts", async (c) => {
    requireEmperor(c);
    const b = await readJson(c);
    const e = wf().issueEdict({
      title: reqStr(b.title, "title（旨意标题）", 200),
      intent: reqStr(b.intent, "intent（旨意）", 12_000),
      deliberation_id: optStr(b.deliberation_id, "deliberation_id", 100),
      skip_review: optBool(b.skip_review, "skip_review（墨敕）"),
      budget_tokens: optNum(b.budget_tokens, "budget_tokens", 0, 1e10),
      deadline_minutes: optNum(b.deadline_minutes, "deadline_minutes", 1, 60 * 24 * 365),
      actor: "emperor",
    });
    return c.json(e);
  });

  app.post("/api/emperor/edicts/:id/action", async (c) => {
    requireEmperor(c);
    const b = await readJson(c);
    const action = reqEnum(b.action, ACTIONS, "action");
    const comment = optStr(b.comment, "comment（朱批）", 8000) ?? "";
    return c.json(wf().emperorEdictAction(c.req.param("id"), action, comment));
  });
}
