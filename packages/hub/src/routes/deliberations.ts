// 政事堂议事：列表、详情、发言、下一轮、总结。
import type { Hono } from "hono";
import type { Stance } from "@court/shared";
import { bad, type HubCtx } from "../ctx.ts";
import { workflowOf } from "../services/workflow.ts";
import { optNum, optStr, reqStr, reqEnum } from "../services/flow-util.ts";
import { postActor, queryInt, readJson, requireTool, withIdem } from "./flow-http.ts";

const STANCES: Stance[] = ["support", "oppose", "reserve", "pass"];
const STATES = ["open", "concluded", "closed"] as const;

export function register(app: Hono, ctx: HubCtx): void {
  const wf = () => workflowOf(ctx);

  app.get("/api/deliberations", (c) => {
    const state = c.req.query("state") || undefined;
    if (state && !STATES.includes(state as (typeof STATES)[number])) throw bad(`state 只能是 ${STATES.join(" / ")}`);
    return c.json(wf().council.list(state, queryInt(c, "limit", 50, 1, 200)));
  });

  app.get("/api/deliberations/:id", (c) => c.json(wf().council.detail(c.req.param("id"))));

  app.post("/api/deliberations/:id/speak", async (c) => {
    requireTool(c, "council_speak");
    const b = await readJson(c);
    const actor = postActor(c, b.post, "议事发言");
    const stance = reqEnum(b.stance, STANCES, "stance（立场）");
    const content = stance === "pass" ? (optStr(b.content, "content（发言）", 8000) ?? "（弃权）") : reqStr(b.content, "content（发言）", 8000);
    const ev = typeof b.expected_version === "number" ? b.expected_version : undefined;
    return c.json(withIdem(ctx, "council_speak", b.idem_key, () => wf().council.speak(c.req.param("id"), actor.post, stance, content, ev)));
  });

  app.post("/api/deliberations/:id/next-round", async (c) => {
    requireTool(c, "council_next_round");
    const b = await readJson(c);
    const actor = postActor(c, b.post, "开启下一轮");
    const note = optStr(b.note, "note", 4000);
    return c.json(withIdem(ctx, "council_next_round", b.idem_key, () => wf().council.nextRound(c.req.param("id"), actor.post, note)));
  });

  app.post("/api/deliberations/:id/conclude", async (c) => {
    requireTool(c, "council_conclude");
    const b = await readJson(c);
    const actor = postActor(c, b.post, "总结议事");
    const summary = reqStr(b.summary, "summary（结论）", 8000);
    const dissent = optStr(b.dissent, "dissent（异议）", 4000) ?? "";
    let proposed: { title: string; intent: string } | undefined;
    if (b.proposed_edict !== undefined && b.proposed_edict !== null) {
      const pe = b.proposed_edict as Record<string, unknown>;
      if (typeof pe !== "object") throw bad("proposed_edict 必须是对象 {title, intent}");
      proposed = { title: reqStr(pe.title, "proposed_edict.title（旨意标题）", 200), intent: reqStr(pe.intent, "proposed_edict.intent（旨意内容）", 8000) };
    }
    const confidence = optNum(b.confidence, "confidence（置信度 0–1）", 0, 1) ?? 0.5;
    return c.json(
      withIdem(ctx, "council_conclude", b.idem_key, () => wf().council.conclude(c.req.param("id"), actor.post, { summary, dissent, proposed_edict: proposed, confidence })),
    );
  });
}
