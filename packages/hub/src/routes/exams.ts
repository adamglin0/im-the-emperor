// 科举：题库（保密）、开考、场次、阅卷、放榜。
import type { Context, Hono } from "hono";
import { EXAM_DIMENSIONS, type ExamQuestion } from "@court/shared";
import { bad, type HubCtx } from "../ctx.ts";
import { examsOf } from "../services/exams.ts";
import { optEnum, optStr, reqArr, reqEnum, reqNum, reqStr } from "../services/flow-util.ts";
import { actingAddress } from "../auth.ts";
import { flowActor, principal, readJson, requireTool, withIdem } from "./flow-http.ts";

const KINDS: ExamQuestion["kind"][] = ["exact", "contains", "regex", "json_keys", "tool_call", "rubric", "json_exact", "numeric", "multi_regex", "length_range", "code_output", "tool_calls"];
const STATUSES: ExamQuestion["status"][] = ["active", "draft", "retired"];

export function register(app: Hono, ctx: HubCtx): void {
  const ex = () => examsOf(ctx);

  /** 考题保密：只有陛下与持有 exam_list_questions 的吏部考功官可见题面与答案 */
  function canSeeQuestions(c: Context): boolean {
    const p = principal(c);
    if (p.kind === "emperor" || p.kind === "system") return true;
    return p.kind === "dept" && !!p.post && ctx.registry.hasTool(p.post, "exam_list_questions");
  }
  function redact(q: ExamQuestion): ExamQuestion {
    return { id: q.id, dimension: q.dimension, kind: q.kind, prompt: "（考题保密）", author: q.author, status: q.status, created_at: q.created_at };
  }

  app.get("/api/exams/questions", (c) => {
    const dim = c.req.query("dimension") || undefined;
    if (dim && !EXAM_DIMENSIONS.includes(dim as (typeof EXAM_DIMENSIONS)[number])) throw bad(`dimension 无效：${dim}；可选：${EXAM_DIMENSIONS.join(" / ")}`);
    const list = ex().listQuestions(dim);
    return c.json(canSeeQuestions(c) ? list : list.map(redact));
  });

  app.post("/api/exams/questions", async (c) => {
    requireTool(c, "exam_add_question");
    const b = await readJson(c);
    const author = actingAddress(c, typeof b.author === "string" ? b.author : typeof b.post === "string" ? b.post : undefined);
    const tools =
      b.tools === undefined || b.tools === null
        ? undefined
        : reqArr(b.tools, "tools（模拟工具）", 1, 10).map((t, i) => {
            const o = (t ?? {}) as Record<string, unknown>;
            if (!o.parameters || typeof o.parameters !== "object") throw bad(`tools[${i}].parameters 必须是 JSON Schema 对象`);
            return { name: reqStr(o.name, `tools[${i}].name`, 64), description: reqStr(o.description, `tools[${i}].description`, 1000), parameters: o.parameters as Record<string, unknown> };
          });
    const input = {
      dimension: reqEnum(b.dimension, EXAM_DIMENSIONS, "dimension（考查维度）"),
      prompt: reqStr(b.prompt, "prompt（题面）", 12_000),
      kind: reqEnum(b.kind, KINDS, "kind（题型）"),
      expected: optStr(b.expected, "expected（参考答案）", 8000),
      rubric: optStr(b.rubric, "rubric（评分细则）", 8000),
      tools,
      status: optEnum(b.status, STATUSES, "status"),
    };
    return c.json(withIdem(ctx, "exam_question", b.idem_key, () => ex().addQuestion(input, author)));
  });

  app.post("/api/exams/start", async (c) => {
    requireTool(c, "exam_start");
    const b = await readJson(c);
    const actor = actingAddress(c, typeof b.actor === "string" ? b.actor : undefined);
    const key = reqStr(b.model_key, "model_key（模型键 provider/model_id）", 200);
    return c.json(withIdem(ctx, "exam_start", b.idem_key, () => ex().start(key, actor)));
  });

  app.get("/api/exams/sessions", (c) => c.json(ex().listSessions(c.req.query("model_key") || undefined)));

  app.get("/api/exams/sessions/:id", (c) => {
    const d = ex().sessionDetail(c.req.param("id"));
    if (canSeeQuestions(c)) return c.json(d);
    return c.json({ ...d, answers: d.answers.map((a) => ({ ...a, question: redact(a.question) })) });
  });

  app.post("/api/exams/answers/:id/grade", async (c) => {
    requireTool(c, "exam_grade");
    const b = await readJson(c);
    const actor = flowActor(c, b.post);
    const score = reqNum(b.score, "score（0–100）", 0, 100);
    const comment = reqStr(b.comment, "comment（评语）", 4000);
    return c.json(withIdem(ctx, "exam_grade", b.idem_key, () => ex().grade(c.req.param("id"), actor.post, score, comment)));
  });

  app.post("/api/exams/publish", async (c) => {
    requireTool(c, "exam_publish");
    const b = await readJson(c);
    const actor = actingAddress(c, typeof b.actor === "string" ? b.actor : undefined);
    const sid = reqStr(b.session_id, "session_id", 100);
    return c.json(withIdem(ctx, "exam_publish", b.idem_key, () => ex().publish(sid, actor)));
  });
}
