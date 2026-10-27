// 吏部考功·科举工具
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { EXAM_DIMENSIONS, type ExamSession } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { ToolError, defineTool, fmtTime, ok, selfAddr, snip, writeMeta } from "./_util.ts";

const QKINDS = ["exact", "contains", "regex", "json_keys", "tool_call", "rubric", "json_exact", "numeric", "multi_regex", "length_range", "code_output", "tool_calls"] as const;

function sessionRow(s: ExamSession) {
  return {
    session_id: s.id,
    model_key: s.model_key,
    state: s.state,
    total: s.total,
    scores: s.scores,
    started: fmtTime(s.started_at),
    finished: fmtTime(s.finished_at),
    error: s.error,
  };
}

export function examTools(ctx: ToolContext): AgentTool<any>[] {
  const self = selfAddr(ctx);
  const postId = ctx.post.post_id;
  return [
    defineTool({
      name: "exam_list_models",
      label: "模型池",
      description: "列出模型池：模型键（provider/model_id）、名称、状态（candidate 待考 / examining 考试中 / examined 已考 / failed / retired）、各维度得分、部门适配度。",
      parameters: Type.Object({}),
      async run() {
        const list = await ctx.hub.models();
        return ok(
          `模型 ${list.length} 个`,
          list.map((m) => ({ key: m.key, name: m.name, status: m.status, scores: m.scores, fitness: m.fitness, added: fmtTime(m.added_at), notes: m.notes })),
        );
      },
    }),

    defineTool({
      name: "exam_add_question",
      label: "出题",
      description:
        `向题库添加一道考题（存吏部私有，考后公开）。dimension：${EXAM_DIMENSIONS.join("/")}。` +
        "kind 决定判分方式：exact 全等、contains 包含、regex 正则、json_keys 输出 JSON 含指定键（expected 逗号分隔）、tool_call 以正确参数调用工具（expected 为 JSON {name,args}）、rubric 主观题由阅卷官评分（须给 rubric 评分细则）。难题判分：json_exact（expected 为目标 JSON，深度相等）、numeric（如 7.6±0.01 或 38/5）、multi_regex（expected 为 JSON {all:[...], none:[...], min_len?, max_len?}）、length_range（min-max 字数）、code_output（expected 为程序应输出的文本）、tool_calls（expected 为 JSON [{name,args}]，顺序不限）。hub 会校验 expected 格式。" +
        "客观题必须给 expected。题目要有区分度、答案唯一可判。",
      parameters: Type.Object({
        dimension: StringEnum(EXAM_DIMENSIONS, { description: "考查维度" }),
        prompt: Type.String({ description: "题面" }),
        kind: StringEnum(QKINDS, { description: "判分方式" }),
        expected: Type.Optional(Type.String({ description: "标准答案/判分依据（客观题必填）" })),
        rubric: Type.Optional(Type.String({ description: "评分细则（rubric 题必填）" })),
      }),
      async run(p, call) {
        if (p.kind === "rubric" && !p.rubric) throw new ToolError("rubric 题须给出评分细则 rubric");
        if (p.kind !== "rubric" && !p.expected) throw new ToolError(`${p.kind} 题须给出 expected`);
        if (p.kind === "regex") {
          try {
            new RegExp(p.expected!);
          } catch (e) {
            throw new ToolError(`正则无效：${(e as Error).message}`);
          }
        }
        if (p.kind === "tool_call") {
          try {
            JSON.parse(p.expected!);
          } catch {
            throw new ToolError("tool_call 题的 expected 须为 JSON：{\"name\":…, \"args\":{…}}");
          }
        }
        const q = await ctx.hub.addExamQuestion({
          ...writeMeta(ctx, call.toolCallId),
          dimension: p.dimension,
          prompt: p.prompt,
          kind: p.kind,
          expected: p.expected,
          rubric: p.rubric,
          author: self,
        });
        return ok(`已入题库 ${q.id}（${q.dimension}/${q.kind}，${q.status}）`, { question_id: q.id });
      },
    }),

    defineTool({
      name: "exam_list_questions",
      label: "题库",
      description: "查看题库（可按维度过滤）：题号、维度、判分方式、题面摘要、状态、出题人。",
      parameters: Type.Object({
        dimension: Type.Optional(StringEnum(EXAM_DIMENSIONS, { description: "维度过滤" })),
      }),
      async run(p) {
        const list = await ctx.hub.examQuestions({ dimension: p.dimension, viewer: self });
        return ok(
          `题目 ${list.length} 道`,
          list.map((q) => ({ id: q.id, dimension: q.dimension, kind: q.kind, status: q.status, author: q.author, prompt: snip(q.prompt, 120) })),
        );
      },
    }),

    defineTool({
      name: "exam_start",
      label: "开考",
      description: "为某模型开考（考场在后台用该模型作答全部在用题目，记录耗时/token/成本）。返回 session_id；考完后客观题自动判分，主观题待阅卷。",
      parameters: Type.Object({ model_key: Type.String({ description: "模型键 provider/model_id（见 exam_list_models）" }) }),
      async run(p, call) {
        const s = await ctx.hub.startExam({ ...writeMeta(ctx, call.toolCallId), model_key: p.model_key, actor: self });
        ctx.log("exam_start", { session_id: s.id, model_key: p.model_key });
        return ok(`已为 ${p.model_key} 开考（${s.id}），状态 ${s.state}`, sessionRow(s), { hint: `查看进度：exam_status {session_id: "${s.id}"}` });
      },
    }),

    defineTool({
      name: "exam_status",
      label: "考试进度",
      description: "查看考试进度：给 session_id 看该场详情（每题作答、自动得分、待阅卷的 answer_id）；给 model_key 或都不给则列出考试场次。",
      parameters: Type.Object({
        session_id: Type.Optional(Type.String({ description: "考试场次 ID" })),
        model_key: Type.Optional(Type.String({ description: "按模型过滤场次" })),
      }),
      async run(p) {
        if (p.session_id) {
          const d = await ctx.hub.examSession(p.session_id);
          const needs = d.answers.filter((a) => a.state === "needs_grading");
          return ok(`考试 ${d.session.id}（${d.session.model_key}）：${d.session.state}，${d.answers.length} 题，待阅卷 ${needs.length}`, {
            ...sessionRow(d.session),
            answers: d.answers.map((a) => ({
              answer_id: a.id,
              dimension: a.question.dimension,
              kind: a.question.kind,
              state: a.state,
              auto_score: a.auto_score,
              grader_score: a.grader_score,
              latency_ms: a.latency_ms,
              question: snip(a.question.prompt, 80),
              output: snip(a.output, a.state === "needs_grading" ? 600 : 120),
              rubric: a.state === "needs_grading" ? snip(a.question.rubric, 300) : undefined,
            })),
          });
        }
        const list = await ctx.hub.examSessions({ model_key: p.model_key });
        return ok(`考试场次 ${list.length} 个`, list.map(sessionRow));
      },
    }),

    defineTool({
      name: "exam_grade",
      label: "阅卷",
      description: "为主观题答卷评分（0–100），附评语。须对照题目 rubric 盲评、公正；不得评自己所用模型的答卷。",
      parameters: Type.Object({
        answer_id: Type.String({ description: "答卷 ID（exam_status 中 needs_grading 的 answer_id）" }),
        score: Type.Integer({ minimum: 0, maximum: 100, description: "分数 0–100" }),
        comment: Type.String({ description: "评语（依据 rubric 说明得失分）" }),
      }),
      async run(p, call) {
        const a = await ctx.hub.gradeAnswer(p.answer_id, { ...writeMeta(ctx, call.toolCallId), post: postId, score: p.score, comment: p.comment });
        return ok(`已评分 ${a.id}：${p.score} 分`, { answer_id: a.id, state: a.state });
      },
    }),

    defineTool({
      name: "exam_publish",
      label: "放榜",
      description: "考试全部判分完毕后放榜：计算各维度分与部门适配度，写入模型池，并奏报皇帝。须先确认无待阅卷答卷。",
      parameters: Type.Object({ session_id: Type.String({ description: "考试场次 ID" }) }),
      async run(p, call) {
        const m = await ctx.hub.publishExam({ ...writeMeta(ctx, call.toolCallId), session_id: p.session_id, actor: self });
        return ok(`已放榜：${m.key} 状态 ${m.status}`, { key: m.key, status: m.status, scores: m.scores, fitness: m.fitness });
      },
    }),
  ];
}
