// 科举：题库、考场执行器（经网关用候选模型作答）、自动判分、阅卷（人工 / 超时 LLM 兜底）、金榜与部门适配度。
import {
  ApiError,
  EXAM_DIMENSIONS,
  GatewayClient,
  newId,
  type Address,
  type DeptId,
  type ExamAnswer,
  type ExamDimension,
  type ExamQuestion,
  type ExamSession,
  type ExamSessionDetail,
  type GatewayCompleteReq,
  type GatewayCompleteRes,
  type ModelEntry,
} from "@court/shared";
import { bad, forbidden, invalidState, notFound, type ExamService, type HubCtx } from "../ctx.ts";
import {
  BUILTIN_QUESTIONS,
  autoScore,
  computeFitness,
  computeMetrics,
  computeScores,
  difficultyOf,
  parseJudgeScore,
  questionWeight,
  validateExpected,
  type ScoredItem,
  type ToolCallOut,
} from "./exam-bank.ts";
import { clip } from "./flow-util.ts";

const KAOCHANG: Address = "system:kaochang";
const RUNNER_MS = 5_000;
const GRADING_FALLBACK_MS = 30 * 60_000;
const UNREACHABLE_FAIL_MS = 10 * 60_000;
const FAIL_TOTAL = 40;
const MAX_JUDGE_ATTEMPTS = 3;
/**
 * 网关侧/提供商侧故障（非考生之过）：熔断、限流、罢朝、上游 5xx、鉴权/模型配置错误、预算。
 * 这类错误按「不可达」处理（稍后重试，持续 10 分钟则场次作废、模型退回待考），不能记 0 分害模型落第。
 */
const TRANSIENT_GATEWAY_ERROR = /^(CIRCUIT_OPEN|RATE_LIMITED|HALTED|UPSTREAM_ERROR|AUTH_ERROR|MODEL_NOT_FOUND|BUDGET_EXCEEDED)\b/;
const QUESTION_KINDS: ExamQuestion["kind"][] = [
  "exact",
  "contains",
  "regex",
  "json_keys",
  "tool_call",
  "rubric",
  "json_exact",
  "numeric",
  "multi_regex",
  "length_range",
  "code_output",
  "tool_calls",
];

/** 场次内部字段 */
type SessionRow = ExamSession & {
  question_ids: string[];
  actor: Address;
  fitness?: Partial<Record<DeptId, number>>;
  unreachable_since?: number;
  graders_notified?: boolean;
  published_at?: number;
};
/** 答卷内部字段 */
type AnswerRow = ExamAnswer & { answered_at: number; error?: string; judge_attempts?: number };

export interface GatewayLike {
  complete(r: GatewayCompleteReq): Promise<GatewayCompleteRes>;
}

export interface ExamDeps {
  /** 注入网关（测试用）；缺省按 ctx.gatewayUrl 构造 */
  gateway?: GatewayLike;
}

export interface AddQuestionInput {
  dimension: ExamDimension;
  prompt: string;
  kind: ExamQuestion["kind"];
  expected?: string;
  rubric?: string;
  tools?: ExamQuestion["tools"];
  status?: ExamQuestion["status"];
  difficulty?: ExamQuestion["difficulty"];
  weight?: number;
}

export function createExams(ctx: HubCtx, deps: ExamDeps = {}) {
  const gateway: GatewayLike = deps.gateway ?? new GatewayClient({ baseUrl: ctx.gatewayUrl, token: ctx.gatewayToken, timeoutMs: 180_000 });
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  // ── 数据访问 ──
  const getQuestionOrNull = (id: string) => ctx.db.getJson<ExamQuestion>("SELECT data_json FROM exam_questions WHERE id = ?", id);
  const getSessionOrNull = (id: string) => ctx.db.getJson<SessionRow>("SELECT data_json FROM exam_sessions WHERE id = ?", id);
  const getAnswerOrNull = (id: string) => ctx.db.getJson<AnswerRow>("SELECT data_json FROM exam_answers WHERE id = ?", id);
  const listAnswers = (sessionId: string) => ctx.db.allJson<AnswerRow>("SELECT data_json FROM exam_answers WHERE session_id = ? ORDER BY rowid", sessionId);

  function saveQuestion(q: ExamQuestion): void {
    ctx.db.run(
      "INSERT INTO exam_questions (id, dimension, status, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET dimension = excluded.dimension, status = excluded.status, data_json = excluded.data_json",
      q.id,
      q.dimension,
      q.status,
      JSON.stringify(q),
    );
  }
  function saveSession(s: SessionRow): void {
    ctx.db.run(
      "INSERT INTO exam_sessions (id, model_key, state, created_at, data_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json",
      s.id,
      s.model_key,
      s.state,
      s.created_at,
      JSON.stringify(s),
    );
  }
  function saveAnswer(a: AnswerRow): void {
    ctx.db.run(
      "INSERT INTO exam_answers (id, session_id, question_id, state, data_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json",
      a.id,
      a.session_id,
      a.question_id,
      a.state,
      JSON.stringify(a),
    );
  }

  function setModelStatus(key: string, status: ModelEntry["status"], patch: Partial<ModelEntry> = {}): ModelEntry | undefined {
    const m = ctx.registry.model(key);
    if (!m) return undefined;
    const next = { ...m, ...patch, status };
    ctx.registry.saveModel(next);
    return next;
  }

  /** 阅卷模型：固定阅卷模型；与考生同模型则换默认模型；仍相同则换任一已及第的其他模型 */
  function judgeModel(candidate: string): string {
    const g = ctx.modelsCfg.grader_model;
    if (g && g !== candidate) return g;
    if (ctx.modelsCfg.default_model && ctx.modelsCfg.default_model !== candidate) return ctx.modelsCfg.default_model;
    return ctx.registry.models().find((m) => m.key !== candidate && m.status === "examined")?.key ?? g;
  }

  function graderPosts(): string[] {
    return ctx.registry
      .posts()
      .filter((p) => p.roles.includes("grader") && ctx.registry.officialOf(p.post_id))
      .map((p) => p.post_id);
  }

  // ── 判分与结算 ──
  function finalScore(a: AnswerRow): number {
    return a.grader_score ?? a.auto_score ?? 0;
  }

  function finalize(sessionId: string): void {
    ctx.db.tx(() => {
      const s = getSessionOrNull(sessionId);
      if (!s || s.state === "done" || s.state === "failed") return;
      const answers = listAnswers(sessionId);
      if (answers.length < s.question_ids.length || answers.some((a) => a.state === "needs_grading")) return;
      // 维度分按难度加权（basic 1 / hard 3）；主观题按基础题计权，不致主导维度分
      const items: ScoredItem[] = [];
      for (const a of answers) {
        const q = getQuestionOrNull(a.question_id);
        if (!q) continue;
        items.push({ dimension: q.dimension, difficulty: difficultyOf(q), weight: questionWeight(q), score: finalScore(a) });
      }
      const { scores, scores_by_difficulty, total, basic_total } = computeScores(items);
      const metrics = computeMetrics(answers);
      const fitness = computeFitness(scores, metrics, (ctx.modelsCfg.fitness_weights ?? {}) as Record<string, Record<string, number>>) as Partial<Record<DeptId, number>>;
      // 及第线看基础卷：难题用来拉开名次，不因难题落第
      const passTotal = basic_total ?? total;
      const failed = passTotal < FAIL_TOTAL;
      const now = ctx.now();
      Object.assign(s, { scores, scores_by_difficulty, metrics, total, fitness, state: "done", finished_at: now });
      saveSession(s);
      const model = setModelStatus(s.model_key, failed ? "failed" : "examined");
      const scoreText = EXAM_DIMENSIONS.filter((d) => scores[d] !== undefined)
        .map((d) => {
          const b = scores_by_difficulty.basic?.[d];
          const hd = scores_by_difficulty.hard?.[d];
          return `${d} ${scores[d]}${hd !== undefined ? `（基础 ${b ?? "—"} / 难题 ${hd}）` : ""}`;
        })
        .join("，");
      const metricText = [
        metrics.speed !== undefined ? `速度 ${metrics.speed}（耗时中位数 ${((metrics.median_latency_ms ?? 0) / 1000).toFixed(1)}s）` : "",
        metrics.cost_efficiency !== undefined ? `性价比 ${metrics.cost_efficiency}（每题 $${(metrics.cost_per_question ?? 0).toFixed(5)}）` : "",
      ]
        .filter(Boolean)
        .join("，");
      ctx.notifications.create({
        kind: "fyi",
        category: "exam",
        title: `科举考毕：${model?.name ?? s.model_key}（总分 ${total}）`,
        body: `模型 ${s.model_key} 考毕，总分 ${total}${basic_total !== undefined && basic_total !== total ? `（基础卷 ${basic_total}）` : ""}${failed ? "，基础卷未及格（落第）" : ""}。\n各维度：${scoreText}${metricText ? `\n实测：${metricText}` : ""}\n部门适配：${Object.entries(fitness)
          .map(([d, v]) => `${d} ${v}`)
          .join("，")}\n待考功员外郎放榜（exam_publish）后成绩对外可见。`,
        from: KAOCHANG,
        related: { type: "exam_session", id: s.id },
        options: [],
      });
      const examiner = ctx.registry.pickPost("libu", ["examiner"]);
      if (examiner) {
        ctx.messages.notifyPost(examiner, "system", `科举考毕待放榜：${s.model_key}`, `场次 ${s.id}（${s.model_key}）已考毕，总分 ${total}。请核阅后放榜（exam_publish session_id=${s.id}）。`, {
          from: KAOCHANG,
          meta: { session_id: s.id },
        });
      }
      ctx.events.emit({ type: "exam.finished", actor: KAOCHANG, subject_type: "exam_session", subject_id: s.id, summary: `科举考毕 ${s.model_key}：总分 ${total}`, data: { scores, scores_by_difficulty, metrics, total, fitness } });
    });
  }

  function failSession(s: SessionRow, error: string): void {
    ctx.db.tx(() => {
      s.state = "failed";
      s.error = error;
      s.finished_at = ctx.now();
      saveSession(s);
      // 作废场次的待阅卷一并作废：否则阅卷官简报里一直挂着无法完成的阅卷职事，阅卷兜底也会白白调用模型
      for (const a of ctx.db.allJson<AnswerRow>("SELECT data_json FROM exam_answers WHERE session_id = ? AND state = 'needs_grading'", s.id)) {
        Object.assign(a, { state: "error", error: `场次作废：${clip(error, 200)}` });
        saveAnswer(a);
      }
      // 考场故障不是模型之过：退回待考
      setModelStatus(s.model_key, "candidate");
      ctx.events.emit({ type: "exam.failed", actor: KAOCHANG, subject_type: "exam_session", subject_id: s.id, summary: `科举场次失败 ${s.model_key}：${clip(error, 200)}` });
    });
  }

  function notifyGraders(s: SessionRow, pendingIds: string[]): void {
    if (s.graders_notified || !pendingIds.length) return;
    for (const g of graderPosts()) {
      if (ctx.registry.officialOf(g)?.model === s.model_key) continue; // 考生模型不自评
      ctx.messages.notifyPost(
        g,
        "system",
        `科举待阅卷：${s.model_key}（${pendingIds.length} 份）`,
        `场次 ${s.id} 有 ${pendingIds.length} 份主观题待阅：${pendingIds.join(", ")}。请按评分细则盲评（exam_grade，0–100 分并写明理由）。逾 30 分钟未阅将由阅卷模型代评。`,
        { from: KAOCHANG, meta: { session_id: s.id } },
      );
    }
    s.graders_notified = true;
  }

  // ── 考场 ──
  function toolCallsOf(res: GatewayCompleteRes): ToolCallOut[] {
    return res.message.content.filter((c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => c.type === "toolCall").map((c) => ({ name: c.name, arguments: c.arguments ?? {} }));
  }
  function textOf(res: GatewayCompleteRes): string {
    return res.message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  const isUnreachable = (e: unknown) => e instanceof ApiError && e.code === "unavailable" && e.status === 503;

  async function answerQuestion(s: SessionRow, q: ExamQuestion): Promise<"ok" | "unreachable"> {
    const started = Date.now();
    const base: AnswerRow = {
      id: newId("ans"),
      session_id: s.id,
      question_id: q.id,
      output: "",
      latency_ms: 0,
      tokens: 0,
      cost: 0,
      state: "answered",
      answered_at: ctx.now(),
    };
    try {
      const res = await gateway.complete({
        model_key: s.model_key,
        context: {
          systemPrompt: "你是参加科举考试的考生。请严格按题目要求作答，不要输出多余内容。需要调用工具时直接调用工具。",
          messages: [{ role: "user", content: q.prompt, timestamp: Date.now() }],
          tools: q.tools,
        },
        metadata: { post_id: "system.kaochang", purpose: "exam" },
        skip_budget: true,
      });
      const m = res.message;
      base.latency_ms = m.durationMs ?? Date.now() - started;
      base.tokens = m.usage?.totalTokens ?? 0;
      base.cost = m.usage?.cost?.total ?? 0;
      base.output = textOf(res);
      const calls = toolCallsOf(res);
      if (calls.length) base.tool_calls = calls;
      if (m.stopReason === "error" && TRANSIENT_GATEWAY_ERROR.test(m.errorMessage ?? "")) return "unreachable";
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        base.state = "error";
        base.auto_score = 0;
        base.error = m.errorMessage ?? m.stopReason;
      } else {
        const sc = autoScore(q, base.output, calls);
        if (sc === undefined) base.state = "needs_grading";
        else base.auto_score = sc;
      }
    } catch (e) {
      if (isUnreachable(e)) return "unreachable";
      base.state = "error";
      base.auto_score = 0;
      base.error = (e as Error).message;
      base.latency_ms = Date.now() - started;
    }
    ctx.db.tx(() => {
      // 并发保护：同题已有答卷则放弃本次
      if (ctx.db.get("SELECT id FROM exam_answers WHERE session_id = ? AND question_id = ?", s.id, q.id)) return;
      saveAnswer(base);
    });
    return "ok";
  }

  async function runSession(sessionId: string): Promise<void> {
    let s = getSessionOrNull(sessionId);
    if (!s) return;
    if (s.state === "pending") {
      s.state = "running";
      s.started_at = ctx.now();
      saveSession(s);
      ctx.events.emit({ type: "exam.started", actor: KAOCHANG, subject_type: "exam_session", subject_id: s.id, summary: `科举开考：${s.model_key}（${s.question_ids.length} 题）` });
    }
    for (const qid of s.question_ids) {
      if (ctx.db.get("SELECT id FROM exam_answers WHERE session_id = ? AND question_id = ?", s.id, qid)) continue;
      const q = getQuestionOrNull(qid);
      if (!q) {
        saveAnswer({ id: newId("ans"), session_id: s.id, question_id: qid, output: "", latency_ms: 0, tokens: 0, cost: 0, auto_score: 0, state: "error", answered_at: ctx.now(), error: "题目已删除" });
        continue;
      }
      const r = await answerQuestion(s, q);
      s = getSessionOrNull(sessionId)!;
      if (r === "unreachable") {
        const now = ctx.now();
        s.unreachable_since ??= now;
        saveSession(s);
        if (now - s.unreachable_since > UNREACHABLE_FAIL_MS) failSession(s, "LLM 网关持续 10 分钟不可达，考试作废");
        return;
      }
      if (s.unreachable_since) {
        s.unreachable_since = undefined;
        saveSession(s);
      }
    }
    const answers = listAnswers(s.id);
    if (answers.length < s.question_ids.length) return;
    const pending = answers.filter((a) => a.state === "needs_grading").map((a) => a.id);
    if (pending.length) {
      if (s.state !== "grading") {
        s.state = "grading";
        notifyGraders(s, pending);
        saveSession(s);
      }
      return;
    }
    finalize(s.id);
  }

  async function judge(a: AnswerRow): Promise<void> {
    const s = getSessionOrNull(a.session_id);
    const q = getQuestionOrNull(a.question_id);
    if (!s || !q) return;
    const model = judgeModel(s.model_key);
    let text = "";
    try {
      const res = await gateway.complete({
        model_key: model,
        context: {
          systemPrompt: "你是吏部考功司的阅卷官。依据评分细则给考生答卷打分（0–100 的整数），只输出 JSON：{\"score\": 分数, \"comment\": \"简短理由\"}。",
          messages: [{ role: "user", content: `【题目】\n${q.prompt}\n\n【评分细则】\n${q.rubric ?? "按题意酌情评分"}\n\n【考生答卷】\n${a.output}`, timestamp: Date.now() }],
        },
        metadata: { post_id: "system.kaochang", purpose: "grading" },
        skip_budget: true,
      });
      if (res.message.stopReason === "error" && TRANSIENT_GATEWAY_ERROR.test(res.message.errorMessage ?? "")) return; // 网关故障不计阅卷失败次数
      text = textOf(res);
    } catch (e) {
      if (isUnreachable(e)) return;
      text = "";
    }
    const parsed = parseJudgeScore(text);
    ctx.db.tx(() => {
      const cur = getAnswerOrNull(a.id);
      if (!cur || cur.state !== "needs_grading") return;
      if (parsed) {
        Object.assign(cur, { grader_score: parsed.score, grader: `system:judge:${model}`, comment: clip(parsed.comment, 1000), state: "graded" });
      } else {
        cur.judge_attempts = (cur.judge_attempts ?? 0) + 1;
        if (cur.judge_attempts >= MAX_JUDGE_ATTEMPTS) Object.assign(cur, { grader_score: 0, grader: `system:judge:${model}`, comment: "阅卷模型多次输出无法解析，按 0 分计", state: "graded" });
      }
      saveAnswer(cur);
    });
  }

  async function gradeFallback(): Promise<void> {
    const now = ctx.now();
    const immediate = process.env.EXAM_AUTOGRADE === "1";
    const due = ctx.db
      .allJson<AnswerRow>("SELECT data_json FROM exam_answers WHERE state = 'needs_grading' ORDER BY rowid LIMIT 20")
      .filter((a) => immediate || now - a.answered_at > GRADING_FALLBACK_MS);
    for (const a of due) await judge(a);
    for (const s of ctx.db.allJson<SessionRow>("SELECT data_json FROM exam_sessions WHERE state = 'grading' LIMIT 50")) finalize(s.id);
  }

  /** 考场一步：先续考进行中的场次，再开考最早的待考场次，最后阅卷兜底 */
  async function runOnce(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const s =
        ctx.db.getJson<SessionRow>("SELECT data_json FROM exam_sessions WHERE state = 'running' ORDER BY created_at LIMIT 1") ??
        ctx.db.getJson<SessionRow>("SELECT data_json FROM exam_sessions WHERE state = 'pending' ORDER BY created_at LIMIT 1");
      if (s) await runSession(s.id);
      await gradeFallback();
    } catch (e) {
      try {
        ctx.events.emit({ type: "exam.error", actor: KAOCHANG, summary: `考场出错：${clip((e as Error).message ?? String(e), 300)}` });
      } catch {
        /* 忽略 */
      }
    } finally {
      busy = false;
    }
  }

  const self = {
    /** 播种内置题库：按稳定 ID 补入缺失的题（老库升级时补入新增的难题），已有的题不动（保留其状态与改动），可重复调用 */
    seedQuestions(): number {
      let added = 0;
      ctx.db.tx(() => {
        for (const bq of BUILTIN_QUESTIONS) {
          if (getQuestionOrNull(bq.id)) continue;
          saveQuestion({ ...bq, author: "system:kaochang", status: "active", created_at: ctx.now() });
          added++;
        }
      });
      return added;
    },

    startRunner(): void {
      if (timer) return;
      timer = setInterval(() => void runOnce(), RUNNER_MS);
      timer.unref?.();
    },

    stopRunner(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    runOnce,

    start(modelKey: string, actor: Address): ExamSession {
      if (!modelKey?.trim()) throw bad("缺少 model_key（形如 provider/model_id），可用 exam_list_models 查看模型池");
      return ctx.db.tx(() => {
        const model = ctx.registry.model(modelKey);
        if (!model) throw notFound(`模型 ${modelKey}（请先在模型池添加）`);
        if (model.status === "retired") throw invalidState(`模型 ${modelKey} 已退役，不能应考`);
        const open = ctx.db.get<{ id: string }>("SELECT id FROM exam_sessions WHERE model_key = ? AND state IN ('pending','running','grading')", modelKey);
        if (open) throw invalidState(`模型 ${modelKey} 已有进行中的考试 ${open.id}，请等待其结束`);
        // 出题官模型不考本卷：剔除作者当前模型与考生相同的题目
        const questions = ctx.db.allJson<ExamQuestion>("SELECT data_json FROM exam_questions WHERE status = 'active' ORDER BY rowid").filter((q) => {
          const author = q.author.startsWith("post:") ? q.author.slice(5) : undefined;
          return !(author && ctx.registry.officialOf(author)?.model === modelKey);
        });
        if (!questions.length) throw invalidState("题库中没有可用（active）的考题，请先出题（exam_add_question）");
        const s: SessionRow = { id: newId("ex"), model_key: modelKey, state: "pending", created_at: ctx.now(), question_ids: questions.map((q) => q.id), actor };
        saveSession(s);
        setModelStatus(modelKey, "examining");
        ctx.events.emit({ type: "exam.scheduled", actor, subject_type: "exam_session", subject_id: s.id, summary: `安排科举：${modelKey}（${questions.length} 题）` });
        return s;
      });
    },

    listQuestions(dimension?: string): ExamQuestion[] {
      if (dimension) return ctx.db.allJson<ExamQuestion>("SELECT data_json FROM exam_questions WHERE dimension = ? ORDER BY rowid LIMIT 1000", dimension);
      return ctx.db.allJson<ExamQuestion>("SELECT data_json FROM exam_questions ORDER BY rowid LIMIT 1000");
    },

    addQuestion(input: AddQuestionInput, author: Address): ExamQuestion {
      if (!EXAM_DIMENSIONS.includes(input.dimension)) throw bad(`dimension 无效：${input.dimension}；可选：${EXAM_DIMENSIONS.join(" / ")}`);
      if (!QUESTION_KINDS.includes(input.kind)) throw bad(`kind 无效：${input.kind}；可选：${QUESTION_KINDS.join(" / ")}`);
      if (!input.prompt?.trim()) throw bad("缺少题目 prompt");
      if (input.kind === "rubric" && !input.rubric?.trim()) throw bad("主观题（kind=rubric）必须附评分细则 rubric");
      const err = validateExpected(input.kind, input.expected, input.tools);
      if (err) throw bad(err);
      if (input.difficulty !== undefined && input.difficulty !== "basic" && input.difficulty !== "hard") throw bad("difficulty 须为 basic 或 hard");
      if (input.weight !== undefined && !(Number.isFinite(input.weight) && input.weight > 0 && input.weight <= 10)) throw bad("weight 须为 (0, 10] 的数字");
      const qn: ExamQuestion = {
        id: newId("q"),
        dimension: input.dimension,
        prompt: input.prompt.trim(),
        kind: input.kind,
        expected: input.expected?.trim(),
        rubric: input.rubric?.trim(),
        tools: input.tools,
        ...(input.difficulty ? { difficulty: input.difficulty } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        author,
        status: input.status ?? "active",
        created_at: ctx.now(),
      };
      ctx.db.tx(() => {
        saveQuestion(qn);
        ctx.events.emit({ type: "exam.question_added", actor: author, subject_type: "exam_question", subject_id: qn.id, summary: `新增考题（${qn.dimension}/${qn.kind}）` });
      });
      return qn;
    },

    listSessions(modelKey?: string): ExamSession[] {
      if (modelKey) return ctx.db.allJson<SessionRow>("SELECT data_json FROM exam_sessions WHERE model_key = ? ORDER BY created_at DESC LIMIT 200", modelKey);
      return ctx.db.allJson<SessionRow>("SELECT data_json FROM exam_sessions ORDER BY created_at DESC LIMIT 200");
    },

    sessionDetail(id: string): ExamSessionDetail {
      const session = getSessionOrNull(id);
      if (!session) throw notFound(`考试场次 ${id}`);
      const answers = listAnswers(id).flatMap((a) => {
        const question = getQuestionOrNull(a.question_id);
        return question ? [{ ...a, question }] : [];
      });
      return { session, answers };
    },

    grade(answerId: string, post: string | undefined, score: number, comment: string): ExamAnswer {
      if (!Number.isFinite(score) || score < 0 || score > 100) throw bad("score 必须是 0–100 的数字");
      return ctx.db.tx(() => {
        const a = getAnswerOrNull(answerId);
        if (!a) throw notFound(`答卷 ${answerId}`);
        const s = getSessionOrNull(a.session_id);
        if (!s) throw notFound(`考试场次 ${a.session_id}`);
        if (s.state === "done" || s.state === "failed") throw invalidState(`场次 ${s.id} 已${s.state === "done" ? "考毕" : "作废"}，不能再改分`);
        if (a.state !== "needs_grading" && a.state !== "graded") throw invalidState(`答卷 ${answerId} 是客观题或作答出错（${a.state}），无需阅卷`);
        if (post && ctx.registry.officialOf(post)?.model === s.model_key) throw forbidden(`你的模型与考生相同（${s.model_key}），按例回避，不得阅此卷`);
        Object.assign(a, { grader_score: score, grader: post ? `post:${post}` : "emperor", comment, state: "graded" });
        saveAnswer(a);
        ctx.events.emit({ type: "exam.graded", actor: post ? `post:${post}` : "emperor", subject_type: "exam_answer", subject_id: a.id, summary: `阅卷 ${a.id}：${score} 分` });
        if (s.state === "grading") finalize(s.id);
        return a;
      });
    },

    publish(sessionId: string, actor: Address): ModelEntry {
      return ctx.db.tx(() => {
        const s = getSessionOrNull(sessionId);
        if (!s) throw notFound(`考试场次 ${sessionId}`);
        if (s.state !== "done") throw invalidState(`场次 ${sessionId} 尚未考毕（${s.state}），不能放榜`);
        const m = ctx.registry.model(s.model_key);
        if (!m) throw notFound(`模型 ${s.model_key}`);
        const next: ModelEntry = { ...m, scores: s.scores, fitness: s.fitness, scores_by_difficulty: s.scores_by_difficulty, metrics: s.metrics };
        ctx.registry.saveModel(next);
        s.published_at = ctx.now();
        saveSession(s);
        ctx.events.emit({ type: "exam.published", actor, subject_type: "exam_session", subject_id: s.id, summary: `放榜：${m.name}（总分 ${s.total}）`, data: { scores: s.scores, scores_by_difficulty: s.scores_by_difficulty, metrics: s.metrics, fitness: s.fitness, total: s.total } });
        return next;
      });
    },
  };
  return self satisfies ExamService;
}

export type Exams = ReturnType<typeof createExams>;

export function examsOf(ctx: HubCtx): Exams {
  return ctx.exams as Exams;
}
