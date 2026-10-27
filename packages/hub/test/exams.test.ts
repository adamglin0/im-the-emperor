// 科举：题库（基础 + 难题）、自动判分器、考场流程、阅卷回避、LLM 兜底阅卷、网关不可达、难度加权与实测指标。
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, EXAM_DIMENSIONS, type ExamQuestion, type GatewayCompleteReq, type GatewayCompleteRes } from "@court/shared";
import {
  BUILTIN_QUESTIONS,
  argMatches,
  autoScore,
  computeFitness,
  computeMetrics,
  computeScores,
  costEfficiencyScore,
  measureLength,
  parseJudgeScore,
  questionWeight,
  speedScore,
  validateExpected,
} from "../src/services/exam-bank.ts";
import { createFakeCtx, gwText, gwTool } from "./fakes-b.ts";

const CANDIDATE = "opencode-go/kimi-k3";

const REGEX_SAMPLES: Record<string, string> = {
  q_builtin_reasoning_3: "42",
  q_builtin_instruction_2: "- 红\n- 绿\n- 蓝",
  q_builtin_instruction_4: "seven",
  q_builtin_writing_1: "上联：春风送暖入屠苏\n下联：瑞雪迎春到人间",
  q_builtin_writing_2: "春风又绿江南岸",
  q_builtin_json_3: "```json\n[1, 2, 3, 4, 5]\n```",
  q_builtin_code_1: "function add(a, b) { return a + b; }",
  q_builtin_summary_2: "三省分工，相互制衡",
};

type CallSample = { name: string; arguments: Record<string, unknown> }[];

/** 难题的满分样例答卷（同时验证每道难题的参考答案可达） */
const HARD_SAMPLES: Record<string, string | CallSample> = {
  q_builtin_reasoning_h1: "116",
  q_builtin_reasoning_h2: "共 52 个。",
  q_builtin_reasoning_h3: "丙 丁 戊 甲 乙",
  q_builtin_reasoning_h4: "38/5",
  q_builtin_instruction_h1: "长安乃大唐都城。城中设一百零八坊。坊市整齐如棋盘。此诚天下第一城也。",
  q_builtin_instruction_h2: "Seven bright stars shine above\nBig brave bears bring berries\nAll hail the great emperor!",
  q_builtin_instruction_h3: "TOKYO | SEOUL | QUITO | PARIS | HANOI | DUBAI | DELHI | CAIRO",
  q_builtin_instruction_h4: "秋风萧瑟落叶纷飞山林尽染金黄雁阵南归长空万里稻谷满仓农家欢笑",
  q_builtin_writing_h1: "天高云淡雁南飞，\n下有清江映月辉。\n太液池边花似锦，\n平安喜乐万家归。",
  q_builtin_writing_h2:
    "敕：朕闻朱雀门乃皇城正门，岁久失修，栋宇倾颓，有碍观瞻。今命工部即日鸠工庀材，务于十日之内修缮完竣，所需钱粮着户部拨给，不得延误。工成之日，具状奏闻。故兹敕示。",
  q_builtin_writing_h3: "下联：秋月秋霜秋意浓",
  q_builtin_writing_h4:
    "上元之夜，长安城开坊禁，金吾不禁夜行。朱雀大街两侧灯轮高悬，火树银花，照彻夜空。士女倾城而出，摩肩接踵，笑语喧阗。胡商摊前异香扑鼻，乐坊歌声随风飘荡。孩童提着兔子灯穿行人群，老者驻足猜谜，捻须而笑。直至月落西山，灯火方渐渐阑珊，而人们意犹未尽，相约来年再会。",
  q_builtin_translation_h1: "中书省起草诏令，门下省审核并可封驳，尚书省负责执行。",
  q_builtin_translation_h2: "The Ministry of Revenue has exceeded its budget by 12% this month and has petitioned Your Majesty to approve additional funding.",
  q_builtin_translation_h3: "To ruin something by adding unnecessary details\nTo address the wrong audience\nTo take a superficial glance",
  q_builtin_tool_use_h1: [
    { name: "create_task", arguments: { title: "修缮朱雀门", assignee: { post: "gongbu.shilang", dept: "gongbu" }, priority: "high", due_date: "2026-10-29", tags: ["城防", "营造"] } },
  ],
  q_builtin_tool_use_h2: [
    { name: "get_weather", arguments: { city: "长安", unit: "celsius" } },
    { name: "get_weather", arguments: { city: "洛阳", unit: "celsius" } },
  ],
  q_builtin_tool_use_h3: [{ name: "transfer_funds", arguments: { from_dept: "hubu", to_dept: "bingbu", amount: 6005, memo: "秋防" } }],
  q_builtin_tool_use_h4: [
    {
      name: "schedule_meeting",
      arguments: {
        title: "秋税会议",
        start: "2026-10-27T15:30:00",
        duration_minutes: 90,
        participants: [
          { post: "menxia.shizhong", role: "attendee" },
          { post: "zhongshu.ling", role: "chair" },
          { post: "shangshu.zuopuye", role: "attendee" },
        ],
      },
    },
  ],
  q_builtin_json_h1: '```json\n[{"dept":"gongbu","name":"宇文恺","amount":20040},{"name":"张巡","dept":"bingbu","amount":3500},{"name":"李淳风","dept":"gongbu","amount":1200}]\n```',
  q_builtin_json_h2: '{"libu": 1, "hubu": 2, "bingbu": 1, "gongbu": 2}',
  q_builtin_json_h3: '{"edict_id":"E-2026-117","deadline_days":45,"depts":[{"id":"gongbu","lead":true},{"id":"hubu","lead":false}],"budget":{"unit":"guan","amount":15000},"urgent":false}',
  q_builtin_json_h4: '{"quote": "He said \\"C:\\\\new\\\\table\\"", "length": 22}',
  q_builtin_code_h1: "True 2 [2] 4",
  q_builtin_code_h2: "[6, 6, 6, 6] 12",
  q_builtin_code_h3: "1,10,100,5 1,NaN,NaN false number",
  q_builtin_code_h4: "60试举 -4 2 2 4 2.67",
  q_builtin_code_h5: "14",
  q_builtin_summary_h1: "贞观十四年，唐太宗命侯君集率军讨伐高昌，高昌王麹文泰忧惧而死，其子麹智盛出降，唐于其地设西州并置安西都护府。",
  q_builtin_summary_h2:
    "On March 3, the payment service was down for 47 minutes because an expired TLS certificate broke bank connections. About 12,000 transactions were retried automatically, none were lost, and certificate-expiry alerts will be added.",
  q_builtin_summary_h3: "- 一月：户部拨付一万贯修缮经费\n- 三月：工部因木料短缺申请延期十日获批\n- 五月：正殿修缮完工并通过验收",
  // 第二、三批
  q_builtin_reasoning_h5: "121",
  q_builtin_reasoning_h6: "13",
  q_builtin_reasoning_h7: "2029-07-21 星期六",
  q_builtin_reasoning_h8: "121,932,631,355,968,601,347,401",
  q_builtin_instruction_h5:
    "Chang'an, Tang capital, stood as a vast city with a grand grid. Broad roads, stout walls, and many wards built strong form. Its busy stalls and rows of shops brought trading visitors from distant lands. Court officials and scholars found a rich civic world, and Buddhist worship and laws form daily habits. This capital's grand plan and strong public customs mark it as a famous urban form.",
  q_builtin_instruction_h6:
    "Cats calmly chase small bright toys.\nHappy children sing songs during warm sunny days.\nAll friendly animals quietly gather near the old stone bridge.\nNew students carefully read every book and write clear notes before exams.",
  q_builtin_instruction_h7: "8：独、独、必、出、必、兴、作、闭",
  q_builtin_writing_h5: "山青水秀水青山\n月明湖中湖明月",
  q_builtin_writing_h6: "长安春好，柳色青青映水；燕语呢喃，桃红点点盈枝。",
  q_builtin_writing_h7: "贞心报国守山河\n观政清明庆丰年\n之子于归歌盛世\n治平有道乐尧天\n天高云淡长安道\n下马题诗醉酒泉\n太液池中鱼戏水\n平湖春色映晴川",
  q_builtin_translation_h4: "1729年，军机处开始处理秘密奏折。皇帝以朱批答复每一份奏折，往往在24小时之内，副本由翰林院的学士归档。",
  q_builtin_translation_h5:
    "The Ministry of Works requested funds to repair Chang'an's wall; the Revenue Ministry, finding finances tight, proposed revisiting next spring.",
  q_builtin_translation_h6: "春季粮仓收谷三千零七十二斛，秋季收一万零五百斛；如今城中供养一百五十万百姓及二百零七名官员。",
  q_builtin_tool_use_h5: [
    { name: "set_reminder", arguments: { text: "岁末对账", remind_at: "2027-01-01T03:00Z" } },
    { name: "set_reminder", arguments: { text: "秋税截止", remind_at: "2026-10-31T15:30Z" } },
    { name: "set_reminder", arguments: { text: "早朝", remind_at: "2026-10-31T21:15Z" } },
  ],
  q_builtin_tool_use_h6: [
    {
      name: "allocate_budget",
      arguments: {
        project: "城防",
        allocations: [
          { dept: "libu_rites", amount: 1500 },
          { dept: "gongbu", amount: 4500 },
          { dept: "bingbu", amount: 3000 },
        ],
      },
    },
  ],
  q_builtin_json_h5:
    '[{"date":"2026-03-01","from":"libu","to":"libu_rites","amount":650},{"date":"2026-03-02","from":"bingbu","to":"hubu","amount":2300},{"date":"2026-03-02","from":"gongbu","to":"hubu","amount":2030},{"date":"2026-03-05","from":"hubu","to":"bingbu","amount":12000},{"date":"2026-03-05","from":"hubu","to":"gongbu","amount":1500}]',
  q_builtin_json_h6: '{"bingbu":{"count":2,"total":1550},"hubu":{"total":324,"count":3},"gongbu":{"total":70,"count":3}}',
  q_builtin_code_h6: "fin [1, 2] [1, 2, 20] ['y', 'z'] try False",
  q_builtin_code_h7: "A1 S P1 Q A2 P2 T1",
  q_builtin_code_h8: "[-5] [-46, 8] 8",
  q_builtin_code_h9: "486 839",
  q_builtin_summary_h4:
    "The Wei River Bridge is 18% over budget because unexpected bedrock conditions required deeper foundations; consequently, its completion has been moved from March to June, and additional funds were approved.",
  q_builtin_summary_h5: "去年全县赋税合计 5,500 贯，以三季度收入最高。",
};

function gwTools(calls: CallSample): GatewayCompleteRes {
  return gwText("", { content: calls.map((c, i) => ({ type: "toolCall" as const, id: `c${i}`, name: c.name, arguments: c.arguments })), stopReason: "toolUse" });
}

/** 每道客观题的标准答案（同时验证题库的参考答案可达） */
function perfect(q: Omit<ExamQuestion, "author" | "status" | "created_at">): GatewayCompleteRes {
  const sample = HARD_SAMPLES[q.id];
  if (sample !== undefined) return typeof sample === "string" ? gwText(sample) : gwTools(sample);
  switch (q.kind) {
    case "exact":
      return gwText(q.expected!);
    case "contains":
      return gwText(q.expected!.split("&&").map((p) => p.split("|")[0]).join("，"));
    case "json_keys":
      return gwText(JSON.stringify(Object.fromEntries(q.expected!.split(",").map((k) => [k, "x"]))));
    case "tool_call": {
      const w = JSON.parse(q.expected!);
      return gwTool(w.name, w.args);
    }
    case "regex":
      return gwText(REGEX_SAMPLES[q.id]);
    default:
      return gwText("这是一份主观题答卷。");
  }
}

function makeGateway(opts: { judge?: string; fail?: boolean } = {}) {
  const calls: GatewayCompleteReq[] = [];
  return {
    calls,
    async complete(r: GatewayCompleteReq): Promise<GatewayCompleteRes> {
      calls.push(r);
      if (opts.fail) throw new ApiError(503, "unavailable", "无法连接网关");
      if (r.metadata.purpose === "grading") return gwText(opts.judge ?? '{"score": 80, "comment": "尚可"}');
      const prompt = (r.context.messages[0] as { content: string }).content;
      const q = BUILTIN_QUESTIONS.find((x) => x.prompt === prompt)!;
      return perfect(q);
    },
  };
}

afterEach(() => {
  delete process.env.EXAM_AUTOGRADE;
});

describe("题库与判分", () => {
  it("内置题库每维度至少 3 题、ID 稳定、播种幂等", () => {
    expect(BUILTIN_QUESTIONS.length).toBeGreaterThanOrEqual(24);
    for (const d of EXAM_DIMENSIONS) expect(BUILTIN_QUESTIONS.filter((q) => q.dimension === d).length).toBeGreaterThanOrEqual(3);
    expect(BUILTIN_QUESTIONS.filter((q) => q.kind !== "rubric").length).toBeGreaterThan(BUILTIN_QUESTIONS.length / 2);
    const ctx = createFakeCtx();
    ctx.ex.seedQuestions();
    ctx.ex.seedQuestions();
    expect(ctx.ex.listQuestions()).toHaveLength(BUILTIN_QUESTIONS.length);
    for (const q of BUILTIN_QUESTIONS.filter((x) => x.kind !== "rubric")) {
      const res = perfect(q);
      const text = res.message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
      const calls = res.message.content.flatMap((c) => (c.type === "toolCall" ? [{ name: c.name, arguments: c.arguments }] : []));
      expect(autoScore(q, text, calls), q.id).toBe(100);
    }
  });

  it("自动判分细节", () => {
    expect(autoScore({ kind: "exact", expected: "HELLO" }, " hello。")).toBe(100);
    expect(autoScore({ kind: "contains", expected: "猫&&沙发" }, "猫在床上")).toBe(50);
    expect(autoScore({ kind: "json_keys", expected: "a,b.c" }, '结果：{"a":1,"b":{"c":2}}')).toBe(100);
    expect(autoScore({ kind: "json_keys", expected: "a,b" }, "不是 JSON")).toBe(0);
    expect(autoScore({ kind: "tool_call", expected: '{"name":"calc","args":{"expression":"17*23"}}' }, "", [{ name: "calc", arguments: { expression: "17 * 23" } }])).toBe(100);
    expect(autoScore({ kind: "tool_call", expected: '{"name":"calc","args":{"expression":"17*23"}}' }, "", [{ name: "calc", arguments: { expression: "1+1" } }])).toBe(50);
    expect(autoScore({ kind: "regex", expected: "(" }, "x")).toBe(0);
    expect(autoScore({ kind: "rubric" }, "x")).toBeUndefined();
    expect(parseJudgeScore('```json\n{"score": 75, "comment": "好"}\n```')).toEqual({ score: 75, comment: "好" });
    expect(parseJudgeScore("得分：88 分")?.score).toBe(88);
    expect(parseJudgeScore("无法评分")).toBeUndefined();
  });
});

describe("考场", () => {
  it("作答 → 主观题待阅 → 阅卷官评分 → 考毕 → 放榜", async () => {
    const gw = makeGateway();
    const ctx = createFakeCtx({ gateway: gw });
    ctx.ex.seedQuestions();
    const s = ctx.ex.start(CANDIDATE, "post:libu.kaogong_yuanwailang");
    expect(ctx.registry.model(CANDIDATE)?.status).toBe("examining");
    expect(() => ctx.ex.start(CANDIDATE, "emperor")).toThrow(/已有进行中的考试/);

    await ctx.ex.runOnce();
    const exam = gw.calls.filter((c) => c.metadata.purpose === "exam");
    expect(exam).toHaveLength(BUILTIN_QUESTIONS.length);
    expect(exam.every((c) => c.model_key === CANDIDATE && c.skip_budget && c.metadata.post_id === "system.kaochang")).toBe(true);
    let det = ctx.ex.sessionDetail(s.id);
    expect(det.session.state).toBe("grading");
    const pending = det.answers.filter((a) => a.state === "needs_grading");
    expect(pending).toHaveLength(BUILTIN_QUESTIONS.filter((q) => q.kind === "rubric").length);
    expect(det.answers.filter((a) => a.state === "answered").every((a) => a.auto_score === 100)).toBe(true);
    expect(ctx.inboxOf("libu.kaogong_langzhong").at(-1)?.subject).toMatch(/待阅卷/);
    expect(ctx.briefing.pendingItems("libu.kaogong_langzhong")).toHaveLength(3);

    for (const a of pending) ctx.ex.grade(a.id, "libu.kaogong_langzhong", 90, "言之有物");
    det = ctx.ex.sessionDetail(s.id);
    expect(det.session.state).toBe("done");
    expect(det.session.total).toBeGreaterThan(95);
    const model = ctx.registry.model(CANDIDATE)!;
    expect(model.status).toBe("examined");
    expect(model.scores).toBeUndefined(); // 放榜前不公开
    expect(ctx.notificationsList("exam")[0].kind).toBe("fyi");
    expect(ctx.inboxOf("libu.kaogong_yuanwailang").at(-1)?.subject).toMatch(/待放榜/);

    const pub = ctx.ex.publish(s.id, "post:libu.kaogong_yuanwailang");
    expect(pub.scores?.reasoning).toBeGreaterThan(90);
    expect(Object.keys(pub.fitness ?? {})).toHaveLength(11);
  });

  it("阅卷回避考生同模型；EXAM_AUTOGRADE=1 时由阅卷模型代评且不用考生模型", async () => {
    process.env.EXAM_AUTOGRADE = "1";
    const gw = makeGateway({ judge: '{"score": 60}' });
    const ctx = createFakeCtx({ gateway: gw });
    ctx.ex.seedQuestions();
    const cand = ctx.modelsCfg.grader_model; // 考生恰为阅卷模型 → 改用默认模型阅卷
    const s = ctx.ex.start(cand, "emperor");
    await ctx.ex.runOnce();
    const judge = gw.calls.filter((c) => c.metadata.purpose === "grading");
    expect(judge.length).toBeGreaterThan(0);
    expect(judge.every((c) => c.model_key === ctx.modelsCfg.default_model)).toBe(true);
    expect(ctx.ex.sessionDetail(s.id).session.state).toBe("done");

    const s2 = ctx.ex.start(ctx.modelsCfg.default_model, "emperor");
    delete process.env.EXAM_AUTOGRADE;
    await ctx.ex.runOnce();
    const a = ctx.ex.sessionDetail(s2.id).answers.find((x) => x.state === "needs_grading")!;
    // 阅卷官本人模型即默认模型 → 回避
    expect(() => ctx.ex.grade(a.id, "libu.kaogong_langzhong", 50, "x")).toThrow(/回避/);
  });

  it("网关持续 10 分钟不可达 → 场次作废、模型退回待考", async () => {
    const ctx = createFakeCtx({ gateway: makeGateway({ fail: true }) });
    ctx.ex.seedQuestions();
    const s = ctx.ex.start(CANDIDATE, "emperor");
    await ctx.ex.runOnce();
    expect(ctx.ex.sessionDetail(s.id).session.state).toBe("running");
    expect(ctx.ex.sessionDetail(s.id).answers).toHaveLength(0);
    ctx.advance(11 * 60_000);
    await ctx.ex.runOnce();
    expect(ctx.ex.sessionDetail(s.id).session).toMatchObject({ state: "failed" });
    expect(ctx.registry.model(CANDIDATE)?.status).toBe("candidate");
  });

  it("出题校验", () => {
    const ctx = createFakeCtx();
    expect(() => ctx.ex.addQuestion({ dimension: "code", kind: "rubric", prompt: "写代码" }, "emperor")).toThrow(/rubric/);
    expect(() => ctx.ex.addQuestion({ dimension: "code", kind: "regex", prompt: "x", expected: "(" }, "emperor")).toThrow(/合法正则/);
    expect(() => ctx.ex.addQuestion({ dimension: "tool_use", kind: "tool_call", prompt: "x", expected: '{"name":"a"}' }, "emperor")).toThrow(/tools/);
    const q = ctx.ex.addQuestion({ dimension: "code", kind: "exact", prompt: "1+1=?", expected: "2" }, "post:libu.kaogong_yuanwailang");
    expect(q).toMatchObject({ status: "active", author: "post:libu.kaogong_yuanwailang" });
  });

  it("网关侧故障（熔断/限流）不记 0 分：视同不可达，持续 10 分钟作废并清掉待阅卷", async () => {
    const calls: string[] = [];
    let okCalls = Infinity;
    const ctx = createFakeCtx({
      gateway: {
        async complete(r: GatewayCompleteReq) {
          calls.push(r.metadata.purpose ?? "");
          if (okCalls-- <= 0) return gwText("", { stopReason: "error", errorMessage: "CIRCUIT_OPEN: 提供商熔断中" });
          const prompt = (r.context.messages[0] as { content: string }).content;
          return perfect(BUILTIN_QUESTIONS.find((x) => x.prompt === prompt)!);
        },
      },
    });
    ctx.ex.seedQuestions();
    const s = ctx.ex.start(CANDIDATE, "emperor");
    // 先正常作答，主观题进入待阅
    await ctx.ex.runOnce();
    const graded = ctx.ex.sessionDetail(s.id);
    expect(graded.session.state).toBe("grading");
    expect(ctx.briefing.pendingItems("libu.kaogong_langzhong").length).toBeGreaterThan(0);

    const s2 = ctx.ex.start(ctx.registry.models().find((m) => m.key !== CANDIDATE && m.key !== ctx.modelsCfg.default_model)!.key, "emperor");
    okCalls = 8; // 答完前 8 题（含主观题）后提供商熔断
    await ctx.ex.runOnce();
    let d2 = ctx.ex.sessionDetail(s2.id);
    expect(d2.session.state).toBe("running");
    expect(d2.answers).toHaveLength(8);
    expect(d2.answers.some((a) => a.state === "needs_grading")).toBe(true);
    expect(d2.answers.every((a) => a.state !== "error")).toBe(true);
    ctx.advance(11 * 60_000);
    await ctx.ex.runOnce();
    d2 = ctx.ex.sessionDetail(s2.id);
    expect(d2.session.state).toBe("failed");
    expect(d2.answers.some((a) => a.state === "needs_grading")).toBe(false);
    for (const it of ctx.briefing.pendingItems("libu.kaogong_langzhong")) expect(it).toMatchObject({ session_id: s.id });
  });
});

describe("难题与确定性判分器", () => {
  const HARD = BUILTIN_QUESTIONS.filter((q) => q.difficulty === "hard");

  it("每维度至少 3 道难题、全部确定性判分、参考答案合法、题面与 ID 唯一、均有满分样例", () => {
    for (const d of EXAM_DIMENSIONS) expect(HARD.filter((q) => q.dimension === d).length, d).toBeGreaterThanOrEqual(3);
    for (const q of HARD) {
      expect(q.kind, q.id).not.toBe("rubric");
      expect(q.id).toMatch(/^q_builtin_[a-z_]+_h\d+$/);
      expect(autoScore(q, "")).not.toBeUndefined();
      expect(HARD_SAMPLES[q.id], q.id).toBeDefined();
    }
    for (const q of BUILTIN_QUESTIONS) expect(validateExpected(q.kind, q.expected, q.tools), q.id).toBeUndefined();
    expect(new Set(BUILTIN_QUESTIONS.map((q) => q.id)).size).toBe(BUILTIN_QUESTIONS.length);
    expect(new Set(BUILTIN_QUESTIONS.map((q) => q.prompt)).size).toBe(BUILTIN_QUESTIONS.length);
    expect(Object.keys(HARD_SAMPLES).sort()).toEqual(HARD.map((q) => q.id).sort());
    // 空答卷在难题上必须拿不到满分
    for (const q of HARD) expect(autoScore(q, "", []), q.id).toBeLessThan(100);
  });

  it("json_exact：深度全等不计键序；转义错误、顺序错误、多余键只给部分分", () => {
    const want = { quote: 'He said "C:\\new\\table"', length: 22 };
    const q = { kind: "json_exact" as const, expected: JSON.stringify(want) };
    expect(autoScore(q, JSON.stringify({ length: 22, quote: want.quote }))).toBe(100);
    expect(autoScore(q, '```json\n{"quote": "He said \\"C:\\\\new\\\\table\\"", "length": 22}\n```')).toBe(100);
    // 反斜杠未转义：\n、\t 被解析为换行与制表符
    expect(autoScore(q, '{"quote": "He said \\"C:\\new\\table\\"", "length": 22}')).toBe(25);
    expect(autoScore(q, '{"quote": "He said \\"C:\\\\new\\\\table\\"", "length": 22, "extra": 1}')).toBe(33);
    expect(autoScore(q, "不是 JSON")).toBe(0);
    const arr = { kind: "json_exact" as const, expected: "[1,2,3]" };
    expect(autoScore(arr, "[1, 2, 3]")).toBe(100);
    expect(autoScore(arr, "[1, 3, 2]")).toBe(17);
    expect(autoScore({ kind: "json_exact", expected: '{"a":1}' }, '{"a":"1"}')).toBe(0);
  });

  it("numeric：整段数字或末行末个数字；支持容差、分数与千分位", () => {
    expect(autoScore({ kind: "numeric", expected: "116" }, "116")).toBe(100);
    expect(autoScore({ kind: "numeric", expected: "116" }, "推导如下……\n答案：116 个。")).toBe(100);
    expect(autoScore({ kind: "numeric", expected: "116" }, "115")).toBe(0);
    expect(autoScore({ kind: "numeric", expected: "116" }, "不会")).toBe(0);
    expect(autoScore({ kind: "numeric", expected: "7.6±0.01" }, "7.61")).toBe(100);
    expect(autoScore({ kind: "numeric", expected: "7.6±0.01" }, "7.7")).toBe(0);
    expect(autoScore({ kind: "numeric", expected: "7.6" }, "38/5")).toBe(100);
    expect(autoScore({ kind: "numeric", expected: "6005" }, "6,005")).toBe(100);
    expect(autoScore({ kind: "numeric", expected: "-4" }, "-4")).toBe(100);
  });

  it("multi_regex：按检查条目给分，none 不得命中，缺省区分大小写，可带长度约束", () => {
    const sp = { kind: "multi_regex" as const, expected: JSON.stringify({ all: ["^a", "b$"], none: ["x"], length: { min: 3, max: 5, unit: "chars" } }) };
    expect(autoScore(sp, "acb")).toBe(100);
    expect(autoScore(sp, "ab")).toBe(75); // 长度不足
    expect(autoScore(sp, "xab")).toBe(50); // ^a 不中、含 x
    expect(autoScore({ kind: "multi_regex", expected: JSON.stringify({ all: ["Seven"] }) }, "seven")).toBe(0);
    expect(autoScore({ kind: "multi_regex", expected: JSON.stringify({ all: ["Seven"], flags: "iu" }) }, "seven")).toBe(100);
    expect(autoScore({ kind: "multi_regex", expected: "not json" }, "x")).toBe(0);
    const ins1 = BUILTIN_QUESTIONS.find((q) => q.id === "q_builtin_instruction_h1")!;
    expect(autoScore(ins1, "长安的城池很大。城中设一百零八坊。坊市整齐如棋盘。此诚天下第一城也。")).toBe(88); // 用了「的」
    expect(autoScore(ins1, "长安城中设一百零八坊，坊市整齐。此城天下第一也。")).toBe(75); // 句数不对、用了逗号
  });

  it("length_range：区间内满分，区间外按偏离线性扣分", () => {
    const q = { kind: "length_range" as const, expected: JSON.stringify({ min: 100, max: 120, unit: "han" }) };
    expect(autoScore(q, "长".repeat(110) + "。")).toBe(100);
    expect(autoScore(q, "长".repeat(90))).toBe(80);
    expect(autoScore(q, "长".repeat(130))).toBe(83);
    expect(autoScore(q, "长".repeat(40))).toBe(0);
    expect(measureLength("one two  three\nfour", "words")).toBe(4);
    expect(measureLength("a\n\n b \n", "lines")).toBe(2);
    expect(measureLength("春 眠, 不觉晓", "han")).toBe(5);
    expect(measureLength("a b,c", "chars")).toBe(4);
  });

  it("code_output：逐字比对（区分大小写与空格），容忍「输出：」标签、反引号与代码围栏", () => {
    const q = { kind: "code_output" as const, expected: "True 2 [2] 4" };
    expect(autoScore(q, "True 2 [2] 4")).toBe(100);
    expect(autoScore(q, "输出：True 2 [2] 4")).toBe(100);
    expect(autoScore(q, "`True 2 [2] 4`")).toBe(100);
    expect(autoScore(q, "```\nTrue 2 [2] 4\n```")).toBe(100);
    expect(autoScore(q, "true 2 [2] 4")).toBe(0);
    expect(autoScore(q, "True 2 [2]  4")).toBe(0);
    expect(autoScore({ kind: "code_output", expected: "[6, 6, 6, 6] 12" }, "[0, 2, 4, 6] 12")).toBe(0);
  });

  it("tool_calls：嵌套参数、多次调用、干扰工具与调用次数", () => {
    const tu1 = BUILTIN_QUESTIONS.find((q) => q.id === "q_builtin_tool_use_h1")!;
    const good = (HARD_SAMPLES.q_builtin_tool_use_h1 as { name: string; arguments: Record<string, unknown> }[])[0];
    expect(autoScore(tu1, "", [good])).toBe(100);
    expect(autoScore(tu1, "", [{ name: "create_task", arguments: { ...good.arguments, due_date: "2026-10-28" } }])).toBe(50); // 日期算错
    expect(autoScore(tu1, "", [{ name: "create_task", arguments: { ...good.arguments, assignee: { dept: "gongbu", post: "gongbu.shangshu" } } }])).toBe(50); // 嵌套参数错
    expect(autoScore(tu1, "", [{ name: "create_task", arguments: { ...good.arguments, tags: ["营造"] } }])).toBe(50); // 数组缺项
    expect(autoScore(tu1, "", [{ name: "create_task", arguments: { ...good.arguments, assignee: '{"dept":"gongbu","post":"gongbu.shilang"}' } }])).toBe(50); // 对象传成字符串
    expect(autoScore(tu1, "", [good, { name: "send_message", arguments: { to: "post:gongbu.shilang", body: "x" } }])).toBe(25); // 干扰工具 + 次数不符
    expect(autoScore(tu1, "", [{ name: "create_edict", arguments: { title: "x", body: "y" } }])).toBe(0);
    const tu2 = BUILTIN_QUESTIONS.find((q) => q.id === "q_builtin_tool_use_h2")!;
    expect(autoScore(tu2, "", [{ name: "get_weather", arguments: { city: "长安", unit: "celsius" } }])).toBe(25); // 只调了一次
    expect(autoScore(tu2, "", [{ name: "get_weather", arguments: { city: "洛阳市", unit: "celsius" } }, { name: "get_weather", arguments: { city: "长安", unit: "celsius" } }])).toBe(100);
    const tu3 = BUILTIN_QUESTIONS.find((q) => q.id === "q_builtin_tool_use_h3")!;
    expect(autoScore(tu3, "", [{ name: "transfer_funds", arguments: { from_dept: "hubu", to_dept: "bingbu", amount: "6005", memo: "秋防" } }])).toBe(100);
    expect(autoScore(tu3, "", [{ name: "transfer_funds", arguments: { from_dept: "hubu", to_dept: "bingbu", amount: 6000, memo: "秋防" } }])).toBe(50);
    expect(argMatches({ a: [{ x: 1 }, { x: 2 }] }, { a: [{ x: 2, y: 0 }, { x: 1 }], b: 3 })).toBe(true);
    expect(argMatches(true, "true")).toBe(true);
    expect(argMatches("x", { x: 1 })).toBe(false);
  });

  it("出题校验覆盖新题型", () => {
    const ctx = createFakeCtx();
    const tools = [{ name: "t", description: "d", parameters: { type: "object" } }];
    expect(() => ctx.ex.addQuestion({ dimension: "json", kind: "json_exact", prompt: "x", expected: "{bad" }, "emperor")).toThrow(/合法 JSON/);
    expect(() => ctx.ex.addQuestion({ dimension: "reasoning", kind: "numeric", prompt: "x", expected: "约四十" }, "emperor")).toThrow(/数字/);
    expect(() => ctx.ex.addQuestion({ dimension: "instruction", kind: "multi_regex", prompt: "x", expected: '{"all":["("]}' }, "emperor")).toThrow(/合法正则/);
    expect(() => ctx.ex.addQuestion({ dimension: "writing", kind: "length_range", prompt: "x", expected: '{"min":9,"max":3}' }, "emperor")).toThrow(/min/);
    expect(() => ctx.ex.addQuestion({ dimension: "tool_use", kind: "tool_calls", prompt: "x", expected: '{"calls":[{"name":"u"}]}', tools }, "emperor")).toThrow(/不在 tools/);
    expect(() => ctx.ex.addQuestion({ dimension: "code", kind: "code_output", prompt: "x", expected: "1", weight: 99 }, "emperor")).toThrow(/weight/);
    const q = ctx.ex.addQuestion({ dimension: "reasoning", kind: "numeric", prompt: "1/3=?", expected: "0.333±0.001", difficulty: "hard" }, "emperor");
    expect(q).toMatchObject({ kind: "numeric", difficulty: "hard" });
    expect(autoScore(q, "0.3333")).toBe(100);
  });
});

describe("题库播种（老库升级）", () => {
  it("老库只有基础题：再次播种按稳定 ID 补入难题，不重复、不动已有题", () => {
    const ctx = createFakeCtx();
    expect(ctx.ex.seedQuestions()).toBe(BUILTIN_QUESTIONS.length);
    // 模拟升级前的老库：没有难题，且某道基础题已被停用
    ctx.db.run("DELETE FROM exam_questions WHERE id LIKE 'q\\_builtin\\_%\\_h%' ESCAPE '\\'");
    const old = ctx.ex.listQuestions().find((q) => q.id === "q_builtin_code_1")!;
    ctx.db.run("UPDATE exam_questions SET status = 'retired', data_json = ? WHERE id = ?", JSON.stringify({ ...old, status: "retired" }), old.id);
    const hardCount = BUILTIN_QUESTIONS.filter((q) => q.difficulty === "hard").length;
    expect(ctx.ex.listQuestions()).toHaveLength(BUILTIN_QUESTIONS.length - hardCount);

    expect(ctx.ex.seedQuestions()).toBe(hardCount);
    expect(ctx.ex.seedQuestions()).toBe(0);
    const all = ctx.ex.listQuestions();
    expect(all).toHaveLength(BUILTIN_QUESTIONS.length);
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
    expect(all.find((q) => q.id === "q_builtin_code_1")?.status).toBe("retired");
    expect(all.filter((q) => q.difficulty === "hard").every((q) => q.status === "active" && q.author === "system:kaochang")).toBe(true);
  });
});

describe("计分：难度权重、实测指标与适配度", () => {
  it("维度分按 basic 1 / hard 3 加权，并给出分难度分与基础卷总分", () => {
    const r = computeScores([
      { dimension: "reasoning", difficulty: "basic", weight: questionWeight({}), score: 100 },
      { dimension: "reasoning", difficulty: "basic", weight: 1, score: 100 },
      { dimension: "reasoning", difficulty: "hard", weight: questionWeight({ difficulty: "hard" }), score: 0 },
      { dimension: "code", difficulty: "hard", weight: 3, score: 50 },
      { dimension: "code", difficulty: "basic", weight: questionWeight({ difficulty: "hard", weight: 1 }), score: 90 },
    ]);
    expect(r.scores).toEqual({ reasoning: 40, code: 60 });
    expect(r.scores_by_difficulty).toEqual({ basic: { reasoning: 100, code: 90 }, hard: { reasoning: 0, code: 50 } });
    expect(r.total).toBe(50);
    expect(r.basic_total).toBe(95);
  });

  it("速度与性价比映射（对数线性）及实测指标统计", () => {
    expect(speedScore(1_000)).toBe(100);
    expect(speedScore(2_000)).toBe(100);
    expect(speedScore(10_000)).toBe(52.7);
    expect(speedScore(60_000)).toBe(0);
    expect(speedScore(120_000)).toBe(0);
    expect(costEfficiencyScore(0.00005)).toBe(100);
    expect(costEfficiencyScore(0.001)).toBe(50);
    expect(costEfficiencyScore(0.02)).toBe(0);
    const m = computeMetrics([
      { latency_ms: 4_000, cost: 0.002, state: "answered" },
      { latency_ms: 6_000, cost: 0, state: "answered" },
      { latency_ms: 999_999, cost: 5, state: "error" }, // 出错的不计
      { latency_ms: 1_000, cost: 0.001, state: "graded" },
    ]);
    expect(m.median_latency_ms).toBe(4_000);
    expect(m.speed).toBe(speedScore(4_000));
    expect(m.cost_per_question).toBeCloseTo(0.001, 10);
    expect(m.cost_efficiency).toBe(50);
    // 价格未知（成本全 0）→ 不给性价比
    expect(computeMetrics([{ latency_ms: 3_000, cost: 0, state: "answered" }]).cost_efficiency).toBeUndefined();
  });

  it("适配度：实测指标缺省权重 0.5，可在 fitness_weights 覆盖；无已考维度的部门不给分", () => {
    const scores = { code: 80, tool_use: 60 };
    const f = computeFitness(scores, { speed: 100, cost_efficiency: 50 }, {
      gongbu: { code: 3, tool_use: 2 },
      bingbu: { code: 1, speed: 2, cost_efficiency: 0 },
      libu_rites: { writing: 3 },
    });
    expect(f.gongbu).toBe(Math.round(((80 * 3 + 60 * 2 + 100 * 0.5 + 50 * 0.5) / 6) * 10) / 10);
    expect(f.bingbu).toBe(Math.round(((80 + 200) / 3) * 10) / 10);
    expect(f.libu_rites).toBeUndefined();
    // 指标缺失时只按维度
    expect(computeFitness(scores, {}, { gongbu: { code: 1 } }).gongbu).toBe(80);
  });

  it("整场：基础全对、难题全错 → 维度分被难题拉低但不落第；记录分难度分、实测指标并随放榜公开", async () => {
    const calls: GatewayCompleteReq[] = [];
    const ctx = createFakeCtx({
      gateway: {
        async complete(r: GatewayCompleteReq) {
          calls.push(r);
          const prompt = (r.context.messages[0] as { content: string }).content;
          const q = BUILTIN_QUESTIONS.find((x) => x.prompt === prompt)!;
          return q.difficulty === "hard" ? gwText("不会") : perfect(q);
        },
      },
    });
    ctx.ex.seedQuestions();
    const s = ctx.ex.start(CANDIDATE, "emperor");
    await ctx.ex.runOnce();
    for (const a of ctx.ex.sessionDetail(s.id).answers.filter((x) => x.state === "needs_grading")) ctx.ex.grade(a.id, "libu.kaogong_langzhong", 90, "可");
    const done = ctx.ex.sessionDetail(s.id).session;
    expect(done.state).toBe("done");
    // 推理：基础 3 道客观 100 + 1 道主观 90（权重各 1），难题全 0 分（权重各 3）
    const nHard = BUILTIN_QUESTIONS.filter((q) => q.dimension === "reasoning" && q.difficulty === "hard").length;
    expect(done.scores_by_difficulty?.basic?.reasoning).toBe(97.5);
    expect(done.scores_by_difficulty?.hard?.reasoning).toBe(0);
    expect(done.scores?.reasoning).toBe(Math.round((390 / (4 + 3 * nHard)) * 10) / 10);
    expect(done.total).toBeLessThan(60);
    expect(ctx.registry.model(CANDIDATE)?.status).toBe("examined"); // 基础卷及格，不因难题落第
    expect(done.metrics).toMatchObject({ median_latency_ms: 5, speed: 100, cost_efficiency: 50 });
    const w = ctx.modelsCfg.fitness_weights.bingbu as Record<string, number>;
    const sc = done.scores!;
    const expected = (sc.tool_use! * w.tool_use + sc.code! * w.code + sc.instruction! * w.instruction + 100 * 0.5 + 50 * 0.5) / (w.tool_use + w.code + w.instruction + 1);
    expect((done as { fitness?: Record<string, number> }).fitness?.bingbu).toBeCloseTo(expected, 0);

    const pub = ctx.ex.publish(s.id, "emperor");
    expect(pub.metrics?.speed).toBe(100);
    expect(pub.scores_by_difficulty?.hard?.reasoning).toBe(0);
  });
});
