// 科举内置题库与自动判分器。
// 基础题（basic，权重 1）：客观题为主，外加少量主观题（rubric）考文采。
// 难题（hard，权重 3）：全部确定性判分（json_exact / numeric / multi_regex / length_range / code_output / tool_calls），用于拉开模型差距。
// 题目 ID 稳定（基础 q_builtin_<维度>_<序号>，难题 q_builtin_<维度>_h<序号>），播种幂等；已上线的题目 ID 与参考答案不可改动。
import type { ExamDifficulty, ExamDimension, ExamMetrics, ExamQuestion, ExamScoresByDifficulty } from "@court/shared";

export type BuiltinQuestion = Omit<ExamQuestion, "author" | "status" | "created_at">;

const q = (dimension: ExamDimension, n: number, rest: Omit<BuiltinQuestion, "id" | "dimension">): BuiltinQuestion => ({
  id: `q_builtin_${dimension}_${n}`,
  dimension,
  ...rest,
});

const h = (dimension: ExamDimension, n: number, rest: Omit<BuiltinQuestion, "id" | "dimension" | "difficulty">): BuiltinQuestion => ({
  id: `q_builtin_${dimension}_h${n}`,
  dimension,
  difficulty: "hard",
  ...rest,
});

const spec = (x: unknown) => JSON.stringify(x);

const BASIC_QUESTIONS: BuiltinQuestion[] = [
  // ── 推理 ──
  q("reasoning", 1, { kind: "exact", prompt: "一个篮子里有 3 个苹果，你从中拿走了 2 个。请问你手里有几个苹果？只回答阿拉伯数字。", expected: "2" }),
  q("reasoning", 2, { kind: "exact", prompt: "甲比乙高，乙比丙高，丙比丁高。四人中谁最矮？只回答一个字。", expected: "丁" }),
  q("reasoning", 3, { kind: "regex", prompt: "数列 2, 6, 12, 20, 30, ? 的下一个数是多少？只输出数字。", expected: "^42$" }),
  q("reasoning", 4, {
    kind: "rubric",
    prompt: "某朝廷由多个持续运行的 AI 官员组成，消息可能重复投递。请论证为什么写操作需要「幂等键」，并举一个不用幂等键会出错的例子。200 字以内。",
    rubric: "满分 100：指出重复投递/重试会导致副作用重复（40）；给出具体且合理的出错例子（30）；说明幂等键如何避免（20）；简洁、不超字数（10）。",
  }),

  // ── 指令遵循 ──
  q("instruction", 1, { kind: "exact", prompt: "请只输出大写英文单词 HELLO，不要输出任何其他字符（包括标点和解释）。", expected: "HELLO" }),
  q("instruction", 2, { kind: "regex", prompt: "列出三种颜色。要求：恰好三行，每行以「- 」开头，不要输出任何其他内容。", expected: "^- [^\\n]+\\n- [^\\n]+\\n- [^\\n]+$" }),
  q("instruction", 3, { kind: "contains", prompt: "用一句话回答：太阳从哪个方向升起？回答的末尾必须加上「臣谨奏」三个字。", expected: "东&&臣谨奏" }),
  q("instruction", 4, { kind: "regex", prompt: "请用全部小写的英文写出数字 7 的英文单词，不要标点、不要解释。", expected: "^seven$" }),

  // ── 中文写作 ──
  q("writing", 1, { kind: "regex", prompt: "写一副对联。要求：输出两行，第一行以「上联：」开头，第二行以「下联：」开头，不要其他内容。", expected: "^上联：[^\\n]+\\n\\s*下联：[^\\n]+$" }),
  q("writing", 2, { kind: "regex", prompt: "写一句含有「春风」二字的七言诗句（恰好 7 个汉字，可带句末标点），只输出这一句。", expected: "^(?=[\\u4e00-\\u9fa5]{7}[，。！]?$).*春风.*$" }),
  q("writing", 3, {
    kind: "rubric",
    prompt: "以唐代公文（告示）的口吻，写一份 150 字以内的告示，通知长安百姓今春按时春耕、官府借贷种子。",
    rubric: "满分 100：文体得当、有公文格式感（30）；要素齐全：对象、事项、时间、办法（40）；语言简练通顺（20）；不超字数（10）。",
  }),

  // ── 翻译 ──
  q("translation", 1, { kind: "contains", prompt: "把下列英文翻译成中文，只输出译文：The cat is sleeping on the sofa.", expected: "猫&&沙发" }),
  q("translation", 2, { kind: "contains", prompt: "把下列中文翻译成英文，只输出译文：我爱北京。", expected: "love&&beijing" }),
  q("translation", 3, { kind: "contains", prompt: "Translate into Japanese and output only the translation: Thank you very much.", expected: "ありがとう" }),
  q("translation", 4, {
    kind: "rubric",
    prompt: "把「学而时习之，不亦说乎？」先译成现代汉语，再译成英文，分两行输出。",
    rubric: "满分 100：现代汉语译文准确（「说」通「悦」）（40）；英文译文准确自然（40）；格式为两行（20）。",
  }),

  // ── 工具调用 ──
  q("tool_use", 1, {
    kind: "tool_call",
    prompt: "长安今天天气如何？请调用工具查询。",
    expected: JSON.stringify({ name: "get_weather", args: { city: "长安" } }),
    tools: [{ name: "get_weather", description: "查询某城市今日天气", parameters: { type: "object", properties: { city: { type: "string", description: "城市名" } }, required: ["city"] } }],
  }),
  q("tool_use", 2, {
    kind: "tool_call",
    prompt: "请使用计算器工具计算 17*23。",
    expected: JSON.stringify({ name: "calculator", args: { expression: "17*23" } }),
    tools: [
      { name: "calculator", description: "计算算术表达式", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
      { name: "get_weather", description: "查询某城市今日天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
    ],
  }),
  q("tool_use", 3, {
    kind: "tool_call",
    prompt: "请给 post:libu.shangshu 发一条消息，内容是「明日早朝议铨选」。",
    expected: JSON.stringify({ name: "send_message", args: { to: "post:libu.shangshu" } }),
    tools: [
      {
        name: "send_message",
        description: "给某官员发消息",
        parameters: { type: "object", properties: { to: { type: "string", description: "收件地址，如 post:xxx" }, body: { type: "string" } }, required: ["to", "body"] },
      },
      { name: "list_officials", description: "列出官员", parameters: { type: "object", properties: { dept: { type: "string" } } } },
    ],
  }),

  // ── 结构化输出 ──
  q("json", 1, { kind: "json_keys", prompt: "以 JSON 对象输出一个虚构人物的信息，必须包含 name、age、city 三个键。只输出 JSON。", expected: "name,age,city" }),
  q("json", 2, {
    kind: "json_keys",
    prompt: "把下面的信息整理成 JSON 对象，键为 title（字符串）、deadline（字符串）、depts（字符串数组）：「工部三日内修好长安城东门，兵部协助。」只输出 JSON。",
    expected: "title,deadline,depts",
  }),
  q("json", 3, { kind: "regex", prompt: "输出一个 JSON 数组，按顺序包含整数 1 到 5。只输出 JSON。", expected: "^\\[\\s*1\\s*,\\s*2\\s*,\\s*3\\s*,\\s*4\\s*,\\s*5\\s*\\]$" }),

  // ── 代码 ──
  q("code", 1, { kind: "regex", prompt: "写一个 JavaScript 函数 add(a, b)，返回两数之和。只输出代码。", expected: "(function\\s+add\\s*\\(|(const|let|var)\\s+add\\s*=)" }),
  q("code", 2, { kind: "exact", prompt: "下面的 Python 代码输出什么？只回答输出结果。\n\nprint(len('hello') * 2)", expected: "10" }),
  q("code", 3, { kind: "exact", prompt: "在 JavaScript 中，typeof null 的结果是什么？只回答结果字符串本身，不要引号。", expected: "object" }),
  q("code", 4, {
    kind: "rubric",
    prompt: "用任意编程语言写一个函数，判断字符串是否为回文（忽略大小写），并说明其时间复杂度。",
    rubric: "满分 100：代码正确（50）；正确处理大小写（20）；复杂度分析正确 O(n)（20）；代码清晰（10）。",
  }),

  // ── 摘要 ──
  q("summary", 1, {
    kind: "contains",
    prompt: "用一句话（不超过 30 字）概括下文主旨：\n\n唐太宗李世民即位后，虚心纳谏，任用贤能，轻徭薄赋，使得社会安定、经济恢复，史称「贞观之治」。",
    expected: "贞观",
  }),
  q("summary", 2, {
    kind: "regex",
    prompt: "用不超过 20 个字概括：\n\n三省六部制中，中书省负责起草诏令，门下省负责审核封驳，尚书省负责执行，三者相互制衡。",
    expected: "^[^\\n]{1,24}$",
  }),
  q("summary", 3, {
    kind: "rubric",
    prompt:
      "把下文概括为三条要点（每条一行，以「- 」开头）：\n\n御史台负责监察百官。台院侍御史负责弹劾违法官员；殿院殿中侍御史负责检查朝会礼仪与议事流程；察院监察御史负责巡察各地与各部门，发现问题写成稽查意见。弹劾须附证据，查阅私人资产须奏请皇帝批准。",
    rubric: "满分 100：三条要点覆盖三院职责与弹劾/查阅规则（60）；格式为三行（20）；语言简洁准确（20）。",
  }),
];
// ───────────────────────── 难题（hard） ─────────────────────────
// 参考答案均已用 python3 / node 实算核对（排列计数、日历、代码输出等），改动前务必重新核算。

const PY = (code: string) => `下面的 Python 3 代码输出什么？只输出程序的标准输出原文，不要解释、不要代码块。\n\n${code}`;

const WEATHER_TOOLS: NonNullable<ExamQuestion["tools"]> = [
  {
    name: "get_weather",
    description: "查询某城市当前天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "城市名" }, unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "温度单位" } },
      required: ["city", "unit"],
    },
  },
  { name: "get_forecast", description: "查询某城市未来若干天的天气预报", parameters: { type: "object", properties: { city: { type: "string" }, days: { type: "integer" } }, required: ["city", "days"] } },
  { name: "get_air_quality", description: "查询某城市空气质量指数", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];

const SEND_MESSAGE_TOOL = {
  name: "send_message",
  description: "给某官员发消息",
  parameters: { type: "object", properties: { to: { type: "string", description: "收件地址，如 post:xxx" }, body: { type: "string" } }, required: ["to", "body"] },
};

const HARD_QUESTIONS: BuiltinQuestion[] = [
  // ── 推理（难） ──
  h("reasoning", 1, {
    kind: "numeric",
    // python 穷举 720 个排列 → 116
    prompt: "用数字 1、2、3、4、5、6 各一次组成六位数。要求：① 1 和 2 不相邻；② 3 不在首位；③ 5 和 6 之间恰好隔着一个数字。满足全部条件的六位数共有多少个？只输出最终的阿拉伯数字。",
    expected: "116",
  }),
  h("reasoning", 2, {
    kind: "numeric",
    // python 逐日计数 → 52
    prompt: "从 2024 年 2 月 27 日（星期二）到 2025 年 3 月 1 日（含首尾两天），一共有多少个星期日？只输出最终的阿拉伯数字。",
    expected: "52",
  }),
  h("reasoning", 3, {
    kind: "regex",
    // python 穷举 120 种分配 → 唯一解：吏丙 户丁 礼戊 兵甲 刑乙
    prompt:
      "甲、乙、丙、丁、戊五人分任吏、户、礼、兵、刑五部尚书，每人一部，各不相同。已知：\n1. 甲不在吏部，不在户部，也不在刑部；\n2. 乙在兵部或刑部；\n3. 按「吏、户、礼、兵、刑」的顺序，丙与丁所在的部相邻；\n4. 按同一顺序，戊所在的部排在甲所在的部之前；\n5. 丁不在礼部；\n6. 如果乙在刑部，那么丙在吏部。\n请按吏、户、礼、兵、刑的顺序依次写出各部尚书，五个字之间用一个空格分隔，只输出这五个字。",
    expected: "^丙[\\s、,，]*丁[\\s、,，]*戊[\\s、,，]*甲[\\s、,，]*乙$",
  }),
  h("reasoning", 4, {
    kind: "numeric",
    // 3/12 + t(1/12+1/18) + 2/18 = 1 → t = 23/5，甲共 3 + 4.6 = 7.6 天
    prompt: "一项工程，甲单独做需 12 天完成，乙单独做需 18 天完成。甲先单独做 3 天，然后乙加入，两人合作若干天后甲离开，乙再单独做 2 天恰好完工。问甲一共做了多少天？只输出数字（可为小数）。",
    expected: "7.6±0.01",
  }),

  // ── 指令遵循（难） ──
  h("instruction", 1, {
    kind: "multi_regex",
    prompt:
      "写一段介绍唐代长安城的中文短文，必须同时满足以下全部要求：\n1. 恰好 4 句，每句都以句号「。」结尾，句号只出现在句末；\n2. 第一句必须以「长安」二字开头；\n3. 全文必须出现「一百零八坊」这五个字；\n4. 最后一句必须以「也。」结尾；\n5. 全文不得出现「的」字；\n6. 全文不得出现任何逗号（，或 ,）、阿拉伯数字或换行。\n只输出这段短文。",
    expected: spec({
      all: ["^长安", "^[^。]+。[^。]+。[^。]+。[^。]+。$", "一百零八坊", "也。$"],
      none: ["的", "[，,]", "[0-9０-９]", "\\n"],
    }),
  }),
  h("instruction", 2, {
    kind: "multi_regex",
    prompt:
      'Write exactly three lines of English, following ALL rules:\n1. Each line has exactly five words, separated by single spaces.\n2. Line 1 starts with the word "Seven".\n3. Every word in line 2 starts with the letter b or B.\n4. Line 3 ends with the word "emperor" immediately followed by "!".\n5. No digits and no punctuation anywhere except that single final "!" (no commas, periods, apostrophes, hyphens or quotes).\nOutput only the three lines.',
    expected: spec({
      all: ["^[^\\n]+\\n[^\\n]+\\n[^\\n]+$", "^Seven(?: [A-Za-z]+){4}\\n", "\\n[Bb][A-Za-z]*(?: [Bb][A-Za-z]*){4}\\n", "\\n(?:[A-Za-z]+ ){4}emperor!$"],
      none: ["[0-9]", "[.,;:?'\"\\-‘’“”]", "![\\s\\S]"],
    }),
  }),
  h("instruction", 3, {
    kind: "multi_regex",
    prompt:
      "从下列城市中，挑出英文名恰好由 5 个字母组成的城市，按英文字母顺序倒序（Z→A）排列，全部大写，城市之间用「 | 」（空格、竖线、空格）分隔，只输出这一行，不要任何其他内容：\nParis, Lima, Tokyo, Cairo, Rome, Delhi, Seoul, Oslo, Dubai, Hanoi, Quito, Bern",
    expected: spec({ all: ["^TOKYO \\| SEOUL \\| QUITO \\| PARIS \\| HANOI \\| DUBAI \\| DELHI \\| CAIRO$"] }),
  }),
  h("instruction", 4, {
    kind: "multi_regex",
    prompt: "只输出恰好 30 个汉字，描写一个秋天的场景。要求：不含任何标点符号、空格、数字、字母或换行；必须包含「秋」字；不得包含「的」字。",
    expected: spec({ all: ["^\\p{Script=Han}+$", "秋"], none: ["的"], length: { min: 30, max: 30, unit: "han" } }),
  }),

  // ── 中文写作（难） ──
  h("writing", 1, {
    kind: "multi_regex",
    prompt:
      "写一首七言藏头诗，四句的首字依次为「天」「下」「太」「平」。要求：\n1. 恰好四行，每行一句，每句恰好 7 个汉字，句末可带一个标点（，或 。）；\n2. 全诗必须出现「月」字；\n3. 全诗不得出现「天下」「太平」这两个词，也不得出现「风」字；\n4. 不要标题、作者或任何解释。\n只输出这四行诗。",
    expected: spec({
      all: ["^(?:\\p{Script=Han}{7}[，。！？,.]?\\n){3}\\p{Script=Han}{7}[，。！？,.]?$", "^天[^\\n]*\\n下[^\\n]*\\n太[^\\n]*\\n平", "月"],
      none: ["天下", "太平", "风"],
    }),
  }),
  h("writing", 2, {
    kind: "multi_regex",
    prompt:
      "以唐代敕书口吻写一道短敕，命工部十日内修缮朱雀门。要求：\n1. 以「敕：」开头，以「故兹敕示。」结尾；\n2. 正文须出现「工部」和「十日」；\n3. 不得出现「的」「了」二字，不得使用阿拉伯数字；\n4. 汉字总数（不计标点）在 60 到 90 个之间；\n5. 只输出一段，不分行。",
    expected: spec({
      all: ["^敕：", "故兹敕示。$", "工部", "十日"],
      none: ["的", "了", "[0-9０-９]", "\\n"],
      length: { min: 60, max: 90, unit: "han" },
    }),
  }),
  h("writing", 3, {
    kind: "multi_regex",
    prompt:
      "上联：春水春山春色好\n请对下联。要求：\n1. 只输出一行，格式为「下联：」加 7 个汉字，句末不加标点；\n2. 与上联结构一致：第 1、3、5 字必须是同一个字（如上联的三个「春」）；\n3. 下联中不得出现「春」字，且最后一字不得是「好」；\n4. 不要任何解释。",
    expected: spec({
      all: ["^下联：\\p{Script=Han}{7}$", "^下联：(\\p{Script=Han})\\p{Script=Han}\\1\\p{Script=Han}\\1"],
      none: ["春", "好$", "\\n"],
    }),
  }),
  h("writing", 4, {
    kind: "length_range",
    prompt: "写一段描写长安上元夜灯市的文字，汉字数（不计标点）必须在 100 到 120 个之间。只输出这段文字。",
    expected: spec({ min: 100, max: 120, unit: "han" }),
  }),

  // ── 翻译（难） ──
  h("translation", 1, {
    kind: "multi_regex",
    prompt:
      "将下面这句英文译成中文，只输出译文：\nThe Secretariat drafts the edicts, the Chancellery reviews them and may veto them, and the Department of State Affairs carries them out.\n说明：句中说的是唐代三省制度，机构名必须用唐代的正式名称；veto 须译为制度术语「封驳」。",
    expected: spec({
      all: ["中书省", "门下省", "尚书省", "封驳", "中书省[\\s\\S]*门下省[\\s\\S]*尚书省"],
      none: ["秘书", "总理|大法官", "国务", "否决"],
    }),
  }),
  h("translation", 2, {
    kind: "multi_regex",
    prompt:
      "把下面这句话译成英文，只输出译文：\n户部本月预算超支百分之十二，已奏请陛下批准追加拨款。\n术语要求：「户部」必须译为 Ministry of Revenue；「陛下」必须译为 Your Majesty；百分数用阿拉伯数字加 % 表示（如 5%）。",
    expected: spec({
      all: ["Ministry of Revenue", "Your Majesty", "\\b12\\s?%", "budget"],
      none: ["\\p{Script=Han}", "household", "twelve", "percent"],
      flags: "iu",
    }),
  }),
  h("translation", 3, {
    kind: "multi_regex",
    prompt:
      "把下列三个成语分别意译为英文，按顺序输出三行，每行一个，每行只写英文意译（不超过 8 个单词），不要编号、不要中文、不要解释。注意：必须译出其比喻义，不得直译字面意象——译文中不得出现任何动物名称。\n画蛇添足\n对牛弹琴\n走马观花",
    expected: spec({
      all: [
        "^[^\\n]+\\n[^\\n]+\\n[^\\n]+$",
        "^[^\\n]*(unnecessar|superfluous|needless|overdo|overkill|gild|redundant|excess|too far|ruin|spoil|counterproductive|extra)[^\\n]*\\n",
        "^[^\\n]*\\n[^\\n]*(audience|deaf|wrong (person|people|crowd|listener)|unappreciat|unreceptive|waste|ears|listener|understand|appreciat|over (their|his|her|someone's|one's) head|in vain|futile|wall|preach)[^\\n]*\\n",
        "\\n[^\\n]*(superficial|cursor|hast|hurried|hurry|glance|quick|brief|skim|surface|passing|fleeting|without (depth|looking|care))[^\\n]*$",
      ],
      none: [
        "snake|serpent|\\bfeet\\b|\\blegs?\\b|\\bcows?\\b|\\box(en)?\\b|\\bbulls?\\b|cattle|horse|steed|swine|\\bpigs?\\b|\\bhogs?\\b",
        "\\p{Script=Han}",
        "(?:^|\\n)\\s*(?:\\d+[.)、]|[-*•])",
        "(?:^|\\n)[^\\S\\n]*(?:\\S+[^\\S\\n]+){8}\\S+",
      ],
      flags: "iu",
    }),
  }),

  // ── 工具调用（难） ──
  h("tool_use", 1, {
    kind: "tool_calls",
    prompt:
      "今天是 2026-10-26。请为工部侍郎（职位 ID：gongbu.shilang，部门代号 gongbu）创建一项任务：修缮朱雀门。截止日期为三天后；此事重要但并非十万火急，优先级按 high 处理；标签为「营造」和「城防」两项。只需建任务，不要发消息，也不要起草诏令。",
    expected: spec({
      calls: [{ name: "create_task", args: { title: "朱雀门", assignee: { dept: "gongbu", post: "gongbu.shilang" }, priority: "high", due_date: "2026-10-29", tags: ["营造", "城防"] } }],
      forbid: ["create_edict", "send_message"],
      exact_count: true,
    }),
    tools: [
      {
        name: "create_task",
        description: "为某官员创建一项任务",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "任务标题" },
            assignee: {
              type: "object",
              properties: { dept: { type: "string", description: "部门代号，如 gongbu" }, post: { type: "string", description: "职位 ID，如 gongbu.shilang" } },
              required: ["dept", "post"],
            },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            due_date: { type: "string", description: "截止日期，格式 YYYY-MM-DD" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["title", "assignee", "priority", "due_date", "tags"],
        },
      },
      { name: "create_edict", description: "起草诏令（须皇帝用印），用于朝廷大政", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] } },
      SEND_MESSAGE_TOOL,
      { name: "search_tasks", description: "按关键词搜索已有任务", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    ],
  }),
  h("tool_use", 2, {
    kind: "tool_calls",
    prompt: "请在同一次回复中发起两次工具调用，分别查询洛阳和长安「当前」的天气，温度单位用摄氏度。不要查询天气预报，也不要查询空气质量。",
    expected: spec({
      calls: [
        { name: "get_weather", args: { city: "洛阳", unit: "celsius" } },
        { name: "get_weather", args: { city: "长安", unit: "celsius" } },
      ],
      forbid: ["get_forecast", "get_air_quality"],
      exact_count: true,
    }),
    tools: WEATHER_TOOLS,
  }),
  h("tool_use", 3, {
    kind: "tool_calls",
    // 1250 + 3780 + 975 = 6005
    prompt: "户部要向兵部拨付三笔款项：粮草钱 1,250 贯、军械钱 3,780 贯、抚恤钱 975 贯。请只用一次资金拨付调用，按合计总额拨付（amount 为整数，单位贯），备注写「秋防」。部门代号：户部 hubu，兵部 bingbu。无需先查余额。",
    expected: spec({
      calls: [{ name: "transfer_funds", args: { from_dept: "hubu", to_dept: "bingbu", amount: 6005, memo: "秋防" } }],
      forbid: ["transfer_goods", "query_balance"],
      exact_count: true,
    }),
    tools: [
      { name: "query_balance", description: "查询某部门账上余额", parameters: { type: "object", properties: { dept: { type: "string" } }, required: ["dept"] } },
      {
        name: "transfer_goods",
        description: "在部门之间调拨实物（粮草、器械等）",
        parameters: { type: "object", properties: { from_dept: { type: "string" }, to_dept: { type: "string" }, item: { type: "string" }, quantity: { type: "integer" } }, required: ["from_dept", "to_dept", "item", "quantity"] },
      },
      {
        name: "transfer_funds",
        description: "在部门之间拨付钱款",
        parameters: {
          type: "object",
          properties: { from_dept: { type: "string" }, to_dept: { type: "string" }, amount: { type: "integer", description: "金额（贯）" }, memo: { type: "string" } },
          required: ["from_dept", "to_dept", "amount"],
        },
      },
    ],
  }),
  h("tool_use", 4, {
    kind: "tool_calls",
    prompt:
      "今天是 2026-10-26（星期一）。请安排一次会议：明天下午三点半开始，开一个半小时，议题「秋税」。由中书令（zhongshu.ling）主持，门下侍中（menxia.shizhong）与尚书左仆射（shangshu.zuopuye）参加。不必另发消息通知。",
    expected: spec({
      calls: [
        {
          name: "schedule_meeting",
          args: {
            title: "秋税",
            start: "2026-10-27T15:30",
            duration_minutes: 90,
            participants: [
              { post: "zhongshu.ling", role: "chair" },
              { post: "menxia.shizhong", role: "attendee" },
              { post: "shangshu.zuopuye", role: "attendee" },
            ],
          },
        },
      ],
      forbid: ["send_message", "cancel_meeting"],
      exact_count: true,
    }),
    tools: [
      {
        name: "schedule_meeting",
        description: "安排会议",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            start: { type: "string", description: "开始时间，ISO 8601 本地时间，如 2026-01-02T09:00" },
            duration_minutes: { type: "integer" },
            participants: {
              type: "array",
              items: { type: "object", properties: { post: { type: "string", description: "职位 ID" }, role: { type: "string", enum: ["chair", "attendee"] } }, required: ["post", "role"] },
            },
          },
          required: ["title", "start", "duration_minutes", "participants"],
        },
      },
      { name: "cancel_meeting", description: "取消会议", parameters: { type: "object", properties: { meeting_id: { type: "string" } }, required: ["meeting_id"] } },
      SEND_MESSAGE_TOOL,
    ],
  }),

  // ── 结构化输出（难） ──
  h("json", 1, {
    kind: "json_exact",
    prompt:
      '从下面的奏报中，提取所有「仍然有效」的拨款请求，输出 JSON 数组；每个元素为 {"name": 请款人姓名, "dept": 部门代号, "amount": 金额（整数，单位贯）}，按 amount 从大到小排序。部门代号：户部 hubu，工部 gongbu，兵部 bingbu。只输出 JSON。\n\n奏报：臣户部郎中王守仁谨奏：工部员外郎李淳风请拨修渠钱一千二百贯；兵部主事张巡请拨军械钱 3,500 贯；户部主事刘晏原请拨五百贯，后已自行撤回；工部主事宇文恺请拨营造钱二万零四十贯。以上请旨定夺。',
    expected: spec([
      { name: "宇文恺", dept: "gongbu", amount: 20040 },
      { name: "张巡", dept: "bingbu", amount: 3500 },
      { name: "李淳风", dept: "gongbu", amount: 1200 },
    ]),
  }),
  h("json", 2, {
    kind: "json_exact",
    // python 统计 → hubu 2, gongbu 2, bingbu 1, libu 1
    prompt:
      "下面是若干条日志，每行格式为「[部门] 级别 内容」。统计每个部门「级别」为 error 的条数（级别不区分大小写；内容里出现的 error 字样不算）。输出 JSON 对象：键为部门（不带方括号），值为条数；只包含条数大于 0 的部门。只输出 JSON。\n\n[hubu] ERROR 账本对不上\n[gongbu] info 开工\n[bingbu] Error 兵器库存不足\n[hubu] warn 预算接近上限\n[gongbu] ERROR 材料延误\n[hubu] info 已修复 error 记录\n[libu] ERROR 名册缺失\n[hubu] error 重复入账\n[bingbu] INFO error rate normal\n[gongbu] Error 工匠不足",
    expected: spec({ hubu: 2, gongbu: 2, bingbu: 1, libu: 1 }),
  }),
  h("json", 3, {
    kind: "json_exact",
    prompt:
      '把下面的诏令要素转换为 JSON，严格使用如下结构与类型：{"edict_id": 字符串, "deadline_days": 整数, "depts": [{"id": 部门代号, "lead": 是否牵头（布尔）}]（按文中出现顺序）, "budget": {"amount": 整数, "unit": "guan"}, "urgent": 布尔}。部门代号：工部 gongbu，户部 hubu。不要添加其他键。只输出 JSON。\n\n诏令 E-2026-117：命工部牵头、户部协办，修缮洛阳宫，限四十五日内完成，拨款一万五千贯，此非急务。',
    expected: spec({ edict_id: "E-2026-117", deadline_days: 45, depts: [{ id: "gongbu", lead: true }, { id: "hubu", lead: false }], budget: { amount: 15000, unit: "guan" }, urgent: false }),
  }),
  h("json", 4, {
    kind: "json_exact",
    // len('He said "C:\\new\\table"') == 22
    prompt:
      '输出一个 JSON 对象，含两个键："quote" 的值恰为下面方括号内的原文（不含方括号，逐字保留其中的英文双引号与反斜杠）；"length" 为该原文的字符数（整数）。只输出 JSON。\n\n[He said "C:\\new\\table"]',
    expected: spec({ quote: 'He said "C:\\new\\table"', length: 22 }),
  }),

  // ── 代码（难） ──（期望输出均为实际运行所得）
  h("code", 1, {
    kind: "code_output",
    prompt: PY("def f(x, acc=[]):\n    acc.append(x)\n    return acc\n\na = f(1)\nb = f(2, [])\nc = f(3)\nprint(a is c, len(a), b, sum(c))"),
    expected: "True 2 [2] 4",
  }),
  h("code", 2, {
    kind: "code_output",
    prompt: PY("fs = [lambda: i * 2 for i in range(4)]\ng = (i * 2 for i in range(4))\nnext(g)\nprint([f() for f in fs], sum(g))"),
    expected: "[6, 6, 6, 6] 12",
  }),
  h("code", 3, {
    kind: "code_output",
    prompt:
      "下面的 JavaScript 代码（Node.js）输出什么？只输出程序的标准输出原文，不要解释、不要代码块。\n\nconst a = [10, 1, 5, 100];\na.sort();\nconsole.log(a.join(\",\"), [1, 2, 3].map(parseInt).join(\",\"), 0.1 + 0.2 === 0.3, typeof NaN);",
    expected: "1,10,100,5 1,NaN,NaN false number",
  }),
  h("code", 4, {
    kind: "code_output",
    prompt: PY('s = "科举考试2026"\nprint(s[::-2], -7 // 2, -7 % 3, round(2.5), round(3.5), "%.2f" % 2.675)'),
    expected: "60试举 -4 2 2 4 2.67",
  }),
  h("code", 5, {
    kind: "code_output",
    prompt: PY("x = 0\nfor i in range(1, 6):\n    for j in range(i):\n        if (i + j) % 3 == 0:\n            continue\n        x += i * j if j % 2 else -i\nprint(x)"),
    expected: "14",
  }),

  // ── 摘要（难） ──
  h("summary", 1, {
    kind: "multi_regex",
    prompt:
      "用 40 到 70 个汉字（不计标点）概括下文中这场战事的经过与结果，写成一段话，不分行。只写战事本身：不要提及战后侯君集个人的遭遇，也不要提及与战事无关的事。\n\n贞观十四年（640 年），唐太宗命侯君集为交河道行军大总管，率军讨伐高昌。高昌王麹文泰闻唐军将至，忧惧而死，其子麹智盛继位后出降。唐于其地设西州，并置安西都护府。战后侯君集私取珍宝，回朝后被下狱，旋即获释。同年，长安城中有一场大雪，百姓多有冻馁。",
    expected: spec({
      all: ["侯君集", "高昌", "西州|安西都护府", "降"],
      none: ["珍宝|下狱|获释|私取", "大雪|冻馁|百姓", "\\n"],
      length: { min: 40, max: 70, unit: "han" },
    }),
  }),
  h("summary", 2, {
    kind: "multi_regex",
    prompt:
      "Summarize the incident report below in exactly two sentences totaling 25 to 45 words. You must mention the outage duration and the root cause, and state that no transactions were lost. Do not mention anything unrelated to the incident or anything about individual people.\n\nReport: On March 3, the payment service was down for 47 minutes because an expired TLS certificate broke connections to the bank gateway. About 12,000 transactions were queued and retried automatically after recovery; none were lost. The on-call engineer, who had just returned from vacation, renewed the certificate manually. To prevent recurrence, the team will add certificate-expiry alerts 30 days in advance. Separately, the office cafeteria introduced a new lunch menu.",
    expected: spec({
      all: ["^[^.!?]+[.!?]\\s+[^.!?]+[.!?]$", "47[\\s-]*min", "certificate", "\\b(lost|loss)\\b"],
      none: ["vacation|engineer|on-call", "cafeteria|menu|lunch"],
      length: { min: 25, max: 45, unit: "words" },
      flags: "iu",
    }),
  }),
  h("summary", 3, {
    kind: "multi_regex",
    prompt:
      "把下文压缩为恰好 3 条要点，按时间先后排列。格式要求：每条单独一行，依次以「- 一月：」「- 三月：」「- 五月：」开头；每行（含开头）不超过 22 个字符；只写与修缮洛阳宫正殿直接相关的事；不要其他内容。\n\n五月，工部完成洛阳宫正殿的修缮并通过验收。此前的一月，户部拨付了一万贯修缮经费。三月，工部因木料短缺申请延期十日，获尚书省批准。其间兵部曾借调工匠二十人，与本工程无关。",
    expected: spec({
      all: ["^- 一月：[^\\n]+\\n- 三月：[^\\n]+\\n- 五月：[^\\n]+$", "一万贯|1万贯|10,?000贯", "延期|推迟|延后|展期", "验收"],
      none: ["兵部|借调|工匠", "(?:^|\\n)[^\\n]{23,}"],
    }),
  }),
  // ───── 第二批难题：更长的推理链、精确计数、多条件综合（参考答案均经 python3 / node 实算） ─────
  h("reasoning", 5, {
    kind: "numeric",
    // python：sum(1 for n in range(1, 2027) if digit_sum(n) == 10) → 121
    prompt: "在 1 到 2026（含两端）的整数中，各位数字之和恰好等于 10 的整数有多少个？只输出最终的阿拉伯数字。",
    expected: "121",
  }),
  h("reasoning", 6, {
    kind: "numeric",
    // python 模拟 → 13（未被 7 整除的平方数 9 个 + 7·{1,4,9} + 49）
    prompt:
      "长廊里有编号 1 到 100 的 100 盏灯，起初全灭。进行 100 轮操作：第 k 轮（k = 1, 2, …, 100）把编号为 k 的倍数的灯全部切换一次（亮变灭、灭变亮），但凡 k 是 7 的倍数的那一轮整轮跳过、不做任何操作。100 轮结束后有几盏灯亮着？只输出最终的阿拉伯数字。",
    expected: "13",
  }),
  h("reasoning", 7, {
    kind: "multi_regex",
    // python：date(2026,10,26) + 999 天 → 2029-07-21，星期六
    prompt: "以 2026 年 10 月 26 日（星期一）为第 1 天，往后数，第 1000 天是哪一天、星期几？只输出「YYYY-MM-DD 星期X」这一行。",
    expected: spec({ all: ["2029\\D{1,3}0?7\\D{1,3}21", "星期六|周六|礼拜六"] }),
  }),
  h("instruction", 5, {
    kind: "multi_regex",
    prompt:
      'Write one English paragraph of 60 to 80 words about the capital city of the Tang dynasty. Hard rule: the letter "e" (upper or lower case) must not appear anywhere in your output. Also: include the words "Tang" and "capital"; use no digits; write a single paragraph without line breaks. Output only the paragraph.',
    expected: spec({ all: ["\\bTang\\b", "\\bcapital\\b"], none: ["[eE]", "[0-9]", "\\n"], length: { min: 60, max: 80, unit: "words" } }),
  }),
  h("instruction", 6, {
    kind: "multi_regex",
    prompt:
      "Write exactly four lines of English. Line 1 has exactly 6 words, line 2 exactly 8 words, line 3 exactly 10 words, line 4 exactly 12 words (words separated by single spaces). The first letters of the four lines must be C, H, A, N in that order. Every line ends with a period. No commas anywhere. Output only the four lines.",
    expected: spec({
      all: ["^[^\\n]+\\n[^\\n]+\\n[^\\n]+\\n[^\\n]+$", "^C\\S*(?: \\S+){5}\\.\\n", "\\nH\\S*(?: \\S+){7}\\.\\n", "\\nA\\S*(?: \\S+){9}\\.\\n", "\\nN\\S*(?: \\S+){11}\\.$"],
      none: [","],
    }),
  }),
  h("writing", 5, {
    kind: "multi_regex",
    prompt:
      "写两句回文句：每句恰好 7 个汉字，正读与倒读完全相同（第 1 字与第 7 字相同、第 2 字与第 6 字相同、第 3 字与第 5 字相同）。第一句须含「山」字，第二句须含「月」字，两句不得相同。分两行输出，不加任何标点，不要解释。",
    expected: spec({
      all: [
        "^(\\p{Script=Han})(\\p{Script=Han})(\\p{Script=Han})\\p{Script=Han}\\3\\2\\1\\n",
        "\\n(\\p{Script=Han})(\\p{Script=Han})(\\p{Script=Han})\\p{Script=Han}\\3\\2\\1$",
        "^[^\\n]*山[^\\n]*\\n",
        "\\n[^\\n]*月",
      ],
      none: ["[，。！？、；：,.!?;:]", "^([^\\n]+)\\n\\1$"],
    }),
  }),
  h("writing", 6, {
    kind: "multi_regex",
    prompt:
      "写一段咏长安春色的骈文，共四句，字数依次为 4、6、4、6 个汉字；第一、三句末用「，」，第二句末用「；」，第四句末用「。」。必须出现「长安」与「春」。全文不得出现「之」「而」「其」「以」「不」「一」「的」这七个字中的任何一个。只输出这一段。",
    expected: spec({
      all: ["^\\p{Script=Han}{4}，\\p{Script=Han}{6}；\\p{Script=Han}{4}，\\p{Script=Han}{6}。$", "长安", "春"],
      none: ["[之而其以不一的]"],
    }),
  }),
  h("translation", 4, {
    kind: "multi_regex",
    prompt:
      "将下面的英文译为中文，只输出译文。术语表（必须严格采用）：Grand Council → 军机处；memorial → 奏折；vermilion rescript → 朱批；Hanlin Academy → 翰林院。数字保留阿拉伯数字。\n\nIn 1729 the Grand Council began handling secret memorials. The emperor answered each memorial with a vermilion rescript, often within 24 hours, and copies were filed by scholars from the Hanlin Academy.",
    expected: spec({
      all: ["军机处", "奏折", "朱批", "翰林院", "1729", "24"],
      none: ["大理事会|大议会|大委员会|大会议", "备忘录", "朱红|红色批|红批", "汉林", "一七二九|二十四"],
    }),
  }),
  h("translation", 5, {
    kind: "multi_regex",
    prompt:
      "将下面这句话译成英文，译文必须恰好 20 个英文单词（以空格分隔计数），以句号结尾，只输出译文：\n工部奏请拨款修缮长安城墙，户部认为今年财政紧张，建议明年春天再议。",
    expected: spec({
      all: ["\\bwalls?\\b", "\\bspring\\b", "\\bnext (year|spring)\\b", "\\bWorks\\b", "\\b(Revenue|Finance|Treasury|Household|Revenues)\\b", "\\.$"],
      none: ["\\p{Script=Han}", "\\n"],
      length: { min: 20, max: 20, unit: "words" },
      flags: "iu",
    }),
  }),
  h("tool_use", 5, {
    kind: "tool_calls",
    // python 换算：+8 的 10-31 23:30 → 10-31T15:30Z；+8 的 11-01 05:15 → 10-31T21:15Z；-5 的 12-31 22:00 → 2027-01-01T03:00Z
    prompt:
      "请设置三个提醒，remind_at 必须换算为 UTC，格式 YYYY-MM-DDTHH:MMZ：\n① 长安时间（UTC+8）2026-10-31 23:30，内容「秋税截止」；\n② 长安时间（UTC+8）2026-11-01 05:15，内容「早朝」；\n③ 纽约时间（UTC-5）2026-12-31 22:00，内容「岁末对账」。\n请在同一次回复中发起三次调用。",
    expected: spec({
      calls: [
        { name: "set_reminder", args: { text: "秋税截止", remind_at: "2026-10-31T15:30" } },
        { name: "set_reminder", args: { text: "早朝", remind_at: "2026-10-31T21:15" } },
        { name: "set_reminder", args: { text: "岁末对账", remind_at: "2027-01-01T03:00" } },
      ],
      forbid: ["set_local_alarm", "list_reminders"],
      exact_count: true,
    }),
    tools: [
      {
        name: "set_reminder",
        description: "设置提醒（时间一律为 UTC）",
        parameters: { type: "object", properties: { text: { type: "string" }, remind_at: { type: "string", description: "UTC 时间，YYYY-MM-DDTHH:MMZ" } }, required: ["text", "remind_at"] },
      },
      {
        name: "set_local_alarm",
        description: "在本机设置本地时间闹钟（不支持时区）",
        parameters: { type: "object", properties: { time: { type: "string" }, label: { type: "string" } }, required: ["time"] },
      },
      { name: "list_reminders", description: "列出已有提醒", parameters: { type: "object", properties: {} } },
    ],
  }),
  h("tool_use", 6, {
    kind: "tool_calls",
    // 9000 × 3/6、2/6、1/6 = 4500、3000、1500
    prompt:
      "将 9,000 贯预算按 3:2:1 的比例分配给工部、兵部、礼部（代号依次为 gongbu、bingbu、libu_rites），项目名「城防」。这是项目内部的预算分配：不涉及部门之间转账，也无需向陛下申请追加。",
    expected: spec({
      calls: [
        {
          name: "allocate_budget",
          args: {
            project: "城防",
            allocations: [
              { dept: "gongbu", amount: 4500 },
              { dept: "bingbu", amount: 3000 },
              { dept: "libu_rites", amount: 1500 },
            ],
          },
        },
      ],
      forbid: ["request_budget", "transfer_funds"],
      exact_count: true,
    }),
    tools: [
      { name: "request_budget", description: "向陛下奏请追加预算", parameters: { type: "object", properties: { amount: { type: "integer" }, reason: { type: "string" } }, required: ["amount", "reason"] } },
      {
        name: "transfer_funds",
        description: "在部门之间拨付钱款",
        parameters: { type: "object", properties: { from_dept: { type: "string" }, to_dept: { type: "string" }, amount: { type: "integer" } }, required: ["from_dept", "to_dept", "amount"] },
      },
      {
        name: "allocate_budget",
        description: "把某项目的预算分配到各部门（一次调用给出全部分配）",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string" },
            allocations: {
              type: "array",
              items: { type: "object", properties: { dept: { type: "string" }, amount: { type: "integer", description: "贯" } }, required: ["dept", "amount"] },
            },
          },
          required: ["project", "allocations"],
        },
      },
    ],
  }),
  h("json", 5, {
    kind: "json_exact",
    prompt:
      '下面是驿站登记的钱款往来记录（含重复登记与作废记录）。请整理为 JSON 数组，每个元素为 {"date": "YYYY-MM-DD", "from": 部门代号, "to": 部门代号, "amount": 整数（单位贯）}。规则：① 标注「作废」的记录不要；② 完全相同的重复记录只保留一条；③ 按 date 升序排列，同一天按 amount 降序；④ 部门代号：户部 hubu、工部 gongbu、兵部 bingbu、礼部 libu_rites、吏部 libu。只输出 JSON。\n\n1. 2026年3月5日，户部拨工部 一千五百贯。\n2. 03/02/2026（月/日/年），兵部 → 户部：2,300 贯。\n3. 2026.03.05 礼部拨吏部 800 贯（作废）\n4. 2026-3-5，户部拨兵部，1.2 万贯。\n5. 2026年3月5日，户部拨工部 一千五百贯。\n6. 三月一日（2026 年），吏部拨礼部 六百五十贯。\n7. 2026/03/02 工部拨户部 2030 贯',
    expected: spec([
      { date: "2026-03-01", from: "libu", to: "libu_rites", amount: 650 },
      { date: "2026-03-02", from: "bingbu", to: "hubu", amount: 2300 },
      { date: "2026-03-02", from: "gongbu", to: "hubu", amount: 2030 },
      { date: "2026-03-05", from: "hubu", to: "bingbu", amount: 12000 },
      { date: "2026-03-05", from: "hubu", to: "gongbu", amount: 1500 },
    ]),
  }),
  h("json", 6, {
    kind: "json_exact",
    // hubu 120+105+99=324（3 笔）；gongbu 75+25-30=70（3 笔）；bingbu 300+1250=1550（2 笔）
    prompt:
      '统计下面各部门的支出合计与笔数，输出 JSON 对象：键为部门代号，值为 {"total": 整数合计（贯）, "count": 笔数}。「退回」表示冲减支出（合计中减去），但同样算一笔。部门代号：户部 hubu、工部 gongbu、兵部 bingbu。只输出 JSON。\n\n1. 户部 支 120 贯\n2. 工部 支 七十五 贯\n3. 户部 支 一百零五 贯\n4. 兵部 支 三百 贯\n5. 工部 支 25 贯\n6. 工部 退回 30 贯\n7. 兵部 支 1,250 贯\n8. 户部 支 九十九 贯',
    expected: spec({ hubu: { total: 324, count: 3 }, gongbu: { total: 70, count: 3 }, bingbu: { total: 1550, count: 2 } }),
  }),
  h("code", 6, {
    kind: "code_output",
    prompt: PY(
      'class A:\n    items = []\n    def __init__(self, n):\n        self.n = n\n        self.items.append(n)\n        self.items = self.items + [n * 10]\n\ndef g():\n    try:\n        return "try"\n    finally:\n        print("fin", end=" ")\n\na, b = A(1), A(2)\nd = {"x": 1, "y": 2}\nd["z"] = d.pop("x") + 2\nprint(A.items, b.items, list(d), g(), 1 < 3 > 2 == True)',
    ),
    expected: "fin [1, 2] [1, 2, 20] ['y', 'z'] try False",
  }),
  h("code", 7, {
    kind: "code_output",
    prompt:
      '下面的 JavaScript 代码（Node.js）输出什么？只输出程序的标准输出原文，不要解释、不要代码块。\n\nconst out = [];\nsetTimeout(() => out.push("T1"), 0);\nPromise.resolve().then(() => out.push("P1")).then(() => out.push("P2"));\nqueueMicrotask(() => out.push("Q"));\n(async () => {\n  out.push("A1");\n  await null;\n  out.push("A2");\n})();\nout.push("S");\nsetTimeout(() => console.log(out.join(" ")), 5);',
    expected: "A1 S P1 Q A2 P2 T1",
  }),
  h("code", 8, {
    kind: "code_output",
    prompt: PY(
      'def run(src):\n    st = []\n    for ch in src:\n        if ch.isdigit():\n            st.append(int(ch))\n        elif ch == "+":\n            st.append(st.pop() + st.pop())\n        elif ch == "*":\n            st.append(st.pop() * st.pop())\n        elif ch == "-":\n            b, a = st.pop(), st.pop()\n            st.append(a - b)\n        elif ch == "d":\n            st.append(st[-1])\n        elif ch == "s":\n            st[-1], st[-2] = st[-2], st[-1]\n    return st\n\nprint(run("34+2*d5-s-"), run("92-d*3s-8"), sum(run("12d+s*d")))',
    ),
    expected: "[-5] [-46, 8] 8",
  }),
  h("summary", 4, {
    kind: "multi_regex",
    prompt:
      "Summarize the report below in exactly 30 words, as a single paragraph. You must mention the Wei River Bridge, the cost overrun percentage, its cause, and the new completion month. Do not mention the contractor or the weather.\n\nReport: The Wei River Bridge project, led by contractor Liang Construction, is now 18% over budget after unexpected bedrock conditions required deeper foundations. Heavy autumn rains also delayed work by two weeks, though officials say the rain did not affect costs. Completion has been moved from March to June. The ministry has approved the additional funds.",
    expected: spec({
      all: ["Wei River Bridge", "18\\s?%", "\\bJune\\b", "bedrock|foundation"],
      none: ["Liang|contractor", "\\brain|weather|storm", "\\n"],
      length: { min: 30, max: 30, unit: "words" },
      flags: "iu",
    }),
  }),
  h("summary", 5, {
    kind: "multi_regex",
    // 1280 + 965 + 1742 + 1513 = 5500；最高为第三季度
    prompt:
      "下文给出某县去年四个季度的赋税收入。请用一句话（不超过 40 个汉字，不分行）概括全年情况，必须写出全年赋税合计（阿拉伯数字，单位贯）以及收入最高的季度。\n\n一季度收赋税 1,280 贯；二季度因春旱减收，仅 965 贯；三季度秋粮入库，收 1,742 贯；四季度收 1,513 贯。另有罚没钱 300 贯，不属赋税。",
    expected: spec({
      all: ["5,?500\\s*贯", "三季度|第三季|第3季|秋季"],
      none: ["5,?800", "\\n"],
      length: { max: 40, unit: "han" },
    }),
  }),
  // ───── 第三批难题：长链精确推理（大数乘法、取模散列）、逐字计数、格律与数字转写 ─────
  h("reasoning", 8, {
    kind: "regex",
    // python：987654321987 * 123456789123 = 121932631355968601347401
    prompt: "不借助任何工具，计算 987654321987 × 123456789123 的精确乘积。只输出结果（阿拉伯数字，可带千分位逗号），不要过程。",
    expected: "^121,?932,?631,?355,?968,?601,?347,?401$",
  }),
  h("instruction", 7, {
    kind: "multi_regex",
    // python：t.count("不") == 8；其后一字依次为 独 独 必 出 必 兴 作 闭
    prompt:
      "统计下文中「不」字出现的次数，并按出现顺序列出每个「不」字后面紧跟的那个字。严格按此格式输出一行：「次数：字、字、……」（次数用阿拉伯数字，字之间用顿号），不要其他内容。\n\n大道之行也，天下为公。选贤与能，讲信修睦。故人不独亲其亲，不独子其子，使老有所终，壮有所用，幼有所长，矜寡孤独废疾者皆有所养。男有分，女有归。货恶其弃于地也，不必藏于己；力恶其不出于身也，不必为己。是故谋闭而不兴，盗窃乱贼而不作，故外户而不闭，是谓大同。",
    expected: spec({ all: ["^8[：:]", "独、独、必、出、必、兴、作、闭$", "^8[：:]\\s*独、独、必、出、必、兴、作、闭$"] }),
  }),
  h("writing", 7, {
    kind: "multi_regex",
    prompt:
      "写一首七言律诗：共八句，每句恰好 7 个汉字，每句单独一行，句末不加标点。要求：\n1. 八句的首字依次为「贞」「观」「之」「治」「天」「下」「太」「平」；\n2. 第 2、4、6、8 句的最后一字必须从下列韵字中选取，且四个韵脚互不相同：天 年 前 然 边 川 烟 田 先 连 泉 篇 眠 仙 千 钱 弦 船 传 贤；\n3. 全诗不得出现「风」「花」「雪」「月」四字；\n4. 不要标题、作者和解释。",
    expected: spec({
      all: [
        "^(?:\\p{Script=Han}{7}\\n){7}\\p{Script=Han}{7}$",
        "^贞[^\\n]*\\n观[^\\n]*\\n之[^\\n]*\\n治[^\\n]*\\n天[^\\n]*\\n下[^\\n]*\\n太[^\\n]*\\n平",
        "^[^\\n]*\\n[^\\n]*[天年前然边川烟田先连泉篇眠仙千钱弦船传贤]\\n[^\\n]*\\n[^\\n]*[天年前然边川烟田先连泉篇眠仙千钱弦船传贤]\\n[^\\n]*\\n[^\\n]*[天年前然边川烟田先连泉篇眠仙千钱弦船传贤]\\n[^\\n]*\\n[^\\n]*[天年前然边川烟田先连泉篇眠仙千钱弦船传贤]$",
        "^[^\\n]*\\n[^\\n]*(\\p{Script=Han})\\n[^\\n]*\\n[^\\n]*(?!\\1)(\\p{Script=Han})\\n[^\\n]*\\n[^\\n]*(?!\\1|\\2)(\\p{Script=Han})\\n[^\\n]*\\n[^\\n]*(?!\\1|\\2|\\3)\\p{Script=Han}$",
      ],
      none: ["[风花雪月]"],
    }),
  }),
  h("translation", 6, {
    kind: "multi_regex",
    prompt:
      "将下面的英文译为中文，只输出译文。要求：所有数字一律写成中文数字（不得出现任何阿拉伯数字）。\n\nThe granary received 3,072 bushels of grain in spring and 10,500 bushels in autumn; the city now feeds 1.5 million people and 207 officials.",
    expected: spec({
      all: ["三千零七十二", "一万零五百", "一百五十万", "[二两]百零七", "春", "秋"],
      none: ["[0-9０-９]"],
    }),
  }),
  h("code", 9, {
    kind: "code_output",
    // python 实算 → 486 839
    prompt: PY('def h(s):\n    x = 0\n    for c in s:\n        x = (x * 31 + ord(c)) % 1000\n    return x\n\nprint(h("tang"), h("chang\'an"))'),
    expected: "486 839",
  }),
];

export const BUILTIN_QUESTIONS: BuiltinQuestion[] = [...BASIC_QUESTIONS, ...HARD_QUESTIONS];


// ───────────────────────── 自动判分 ─────────────────────────

/** 去掉 Markdown 代码围栏与首尾空白 */
export function cleanOutput(s: string): string {
  let t = (s ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

function normalizeExact(s: string): string {
  return s
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/[。.！!，,\s]+$/u, "")
    .toLowerCase();
}

function extractJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取 */
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const a = s.indexOf(open);
    const b = s.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* 下一种 */
      }
    }
  }
  return undefined;
}

function hasPath(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object" || !(k in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
}

const normArg = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, "").toLowerCase();
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** JSON 深度全等：对象不计键序，数组计顺序 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

export type LengthUnit = "chars" | "han" | "words" | "lines";
export interface LengthSpec {
  min?: number;
  max?: number;
  /** chars：非空白字符数；han：汉字数；words：空白分隔的词数；lines：非空行数。缺省 chars */
  unit?: LengthUnit;
}
export interface MultiRegexSpec {
  /** 每条都须命中 */
  all?: string[];
  /** 每条都不得命中 */
  none?: string[];
  /** 正则标志，缺省 "u"（区分大小写） */
  flags?: string;
  /** 可选长度约束，算作一条检查 */
  length?: LengthSpec;
}
export interface ToolCallsSpec {
  /** 期望的调用（按名称 + 参数匹配，不计顺序）；args 只校验列出的键，可嵌套 */
  calls: { name: string; args?: Record<string, unknown> }[];
  /** 不得调用的干扰工具 */
  forbid?: string[];
  /** 调用次数须恰为 calls.length */
  exact_count?: boolean;
}

/** 按单位度量长度 */
export function measureLength(text: string, unit: LengthUnit = "chars"): number {
  switch (unit) {
    case "han":
      return (text.match(/\p{Script=Han}/gu) ?? []).length;
    case "words":
      return text.split(/\s+/).filter(Boolean).length;
    case "lines":
      return text.split("\n").filter((l) => l.trim()).length;
    default:
      return [...text.replace(/\s+/g, "")].length;
  }
}

const inLength = (n: number, sp: LengthSpec) => (sp.min === undefined || n >= sp.min) && (sp.max === undefined || n <= sp.max);

/** 长度区间分：区间内 100；区间外按偏离最近边界的比例线性扣分，偏离达边界值的 50% 记 0 */
export function lengthScore(text: string, sp: LengthSpec): number {
  const n = measureLength(text, sp.unit);
  if (inLength(n, sp)) return 100;
  const bound = sp.min !== undefined && n < sp.min ? sp.min : sp.max!;
  const dist = Math.abs(n - bound);
  return Math.max(0, Math.round(100 * (1 - (2 * dist) / Math.max(bound, 1))));
}

/** multi_regex：每条检查（all 各条、none 各条、长度约束）等分，按通过比例给分 */
export function multiRegexScore(text: string, sp: MultiRegexSpec): number {
  const flags = sp.flags ?? "u";
  const test = (p: string) => {
    try {
      return new RegExp(p, flags).test(text);
    } catch {
      return undefined; // 坏正则：算未通过
    }
  };
  const results: boolean[] = [...(sp.all ?? []).map((p) => test(p) === true), ...(sp.none ?? []).map((p) => test(p) === false)];
  if (sp.length) results.push(inLength(measureLength(text, sp.length.unit), sp.length));
  if (!results.length) return 0;
  return Math.round((results.filter(Boolean).length / results.length) * 100);
}

const NUM_RE = /-?\d+(?:,\d{3})*(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?/g;

function parseNumberToken(tok: string): number | undefined {
  const t = tok.replace(/,/g, "").replace(/\s+/g, "");
  const [a, b] = t.split("/");
  const n = b === undefined ? Number(a) : Number(a) / Number(b);
  return Number.isFinite(n) ? n : undefined;
}

/** 解析 numeric 参考答案："42"、"7.6±0.05"、"38/5" */
export function parseNumericExpected(exp: string): { value: number; tol: number } | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s*(?:(?:±|\+-|\+\/-)\s*(\d+(?:\.\d+)?))?\s*$/.exec(exp ?? "");
  if (!m) return undefined;
  const value = parseNumberToken(m[1]);
  if (value === undefined) return undefined;
  return { value, tol: m[2] ? Number(m[2]) : 0 };
}

/** 从作答中取数值：整段即数字则用之，否则取最后一个非空行里的最后一个数字 */
export function extractNumber(out: string): number | undefined {
  const whole = out.replace(/[。.！!\s]+$/u, "").trim();
  if (/^-?[\d,]+(?:\.\d+)?(?:\s*\/\s*\d+)?$/.test(whole)) return parseNumberToken(whole);
  const lines = out.split("\n").filter((l) => l.trim());
  const last = lines.at(-1) ?? "";
  const toks = last.match(NUM_RE);
  return toks?.length ? parseNumberToken(toks.at(-1)!) : undefined;
}

/** code_output 规范化：去掉「输出：」之类标签、包裹的反引号、行尾空白；区分大小写 */
export function normalizeCodeOutput(s: string): string {
  let t = s.trim().replace(/^(?:输出(?:结果)?|output)\s*[:：]\s*/i, "");
  const tick = /^`([^`]*)`$/.exec(t);
  if (tick) t = tick[1];
  return t
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** 工具参数匹配：对象按期望键子集递归、数组等长且不计顺序、数字可为数字串、字符串规范化后包含即可 */
export function argMatches(want: unknown, got: unknown): boolean {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return false;
    const used = new Set<number>();
    return want.every((w) => {
      const i = got.findIndex((g, k) => !used.has(k) && argMatches(w, g));
      if (i < 0) return false;
      used.add(i);
      return true;
    });
  }
  if (isPlainObject(want)) {
    if (!isPlainObject(got)) return false;
    return Object.entries(want).every(([k, w]) => got[k] !== undefined && argMatches(w, got[k]));
  }
  if (typeof want === "number") return (typeof got === "number" || typeof got === "string") && got !== "" && Number(got) === want;
  if (typeof want === "boolean") return got === want || String(got).toLowerCase() === String(want);
  if (got === undefined || got === null || typeof got === "object") return false;
  const g = normArg(got);
  const w = normArg(want);
  return g === w || g.includes(w);
}

/**
 * tool_calls：每个期望调用全匹配记 1、仅工具名对记 0.5，按比例给分；
 * 调用了禁用的干扰工具 ×0.5；要求 exact_count 而调用次数不符 ×0.5。
 */
export function toolCallsScore(sp: ToolCallsSpec, calls: ToolCallOut[]): number {
  const want = sp.calls ?? [];
  if (!want.length) return 0;
  const used = new Set<number>();
  const credit: number[] = want.map(() => 0);
  want.forEach((w, i) => {
    const k = calls.findIndex((c, j) => !used.has(j) && c.name === w.name && argMatches(w.args ?? {}, c.arguments ?? {}));
    if (k >= 0) {
      used.add(k);
      credit[i] = 1;
    }
  });
  want.forEach((w, i) => {
    if (credit[i]) return;
    const k = calls.findIndex((c, j) => !used.has(j) && c.name === w.name);
    if (k >= 0) {
      used.add(k);
      credit[i] = 0.5;
    }
  });
  let score = (credit.reduce((x, y) => x + y, 0) / want.length) * 100;
  if (calls.some((c) => sp.forbid?.includes(c.name))) score *= 0.5;
  if (sp.exact_count && calls.length !== want.length) score *= 0.5;
  return Math.round(score);
}

/** json_exact：深度全等 100；否则按顶层键（对象）或位置元素（数组）命中比例给 0–50 分 */
export function jsonExactScore(got: unknown, want: unknown): number {
  if (got === undefined) return 0;
  if (deepEqual(got, want)) return 100;
  if (isPlainObject(want) && isPlainObject(got)) {
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    const hit = Object.keys(want).filter((k) => k in got && deepEqual(got[k], want[k])).length;
    return Math.round((50 * hit) / keys.size);
  }
  if (Array.isArray(want) && Array.isArray(got)) {
    const n = Math.max(want.length, got.length);
    const hit = want.filter((w, i) => deepEqual(got[i], w)).length;
    return n ? Math.round((50 * hit) / n) : 0;
  }
  return 0;
}

function parseSpec<T>(exp: string): T | undefined {
  try {
    const v = JSON.parse(exp);
    return v && typeof v === "object" ? (v as T) : undefined;
  } catch {
    return undefined;
  }
}

export interface ToolCallOut {
  name: string;
  arguments: Record<string, unknown>;
}

/** 自动判分（0..100）；rubric 题返回 undefined（需阅卷） */
export function autoScore(question: Pick<ExamQuestion, "kind" | "expected">, output: string, toolCalls: ToolCallOut[] = []): number | undefined {
  const out = cleanOutput(output);
  const exp = question.expected ?? "";
  switch (question.kind) {
    case "exact":
      return normalizeExact(out) === normalizeExact(exp) ? 100 : 0;
    case "contains": {
      // "a&&b"：都须包含；"a|b"：任一即可
      const parts = exp.split("&&").map((p) => p.split("|").map((x) => x.trim().toLowerCase()).filter(Boolean));
      if (!parts.length) return 0;
      const lower = out.toLowerCase();
      const hit = parts.filter((alts) => alts.some((a) => lower.includes(a))).length;
      return Math.round((hit / parts.length) * 100);
    }
    case "regex":
      try {
        return new RegExp(exp, "iu").test(out) ? 100 : 0;
      } catch {
        return 0;
      }
    case "json_keys": {
      const obj = extractJson(out);
      const keys = exp.split(",").map((k) => k.trim()).filter(Boolean);
      if (obj === undefined || !keys.length) return 0;
      return Math.round((keys.filter((k) => hasPath(obj, k)).length / keys.length) * 100);
    }
    case "tool_call": {
      let want: { name: string; args?: Record<string, unknown> };
      try {
        want = JSON.parse(exp);
      } catch {
        return 0;
      }
      const call = toolCalls.find((c) => c.name === want.name);
      if (!call) return 0;
      const keys = Object.keys(want.args ?? {});
      if (!keys.length) return 100;
      const ok = keys.filter((k) => {
        const got = call.arguments?.[k];
        if (got === undefined) return false;
        const g = normArg(got);
        const w = normArg(want.args![k]);
        return g === w || g.includes(w);
      }).length;
      return Math.round(50 + (ok / keys.length) * 50);
    }
    case "json_exact": {
      let want: unknown;
      try {
        want = JSON.parse(exp);
      } catch {
        return 0;
      }
      return jsonExactScore(extractJson(out), want);
    }
    case "numeric": {
      const want = parseNumericExpected(exp);
      const got = extractNumber(out);
      if (!want || got === undefined) return 0;
      return Math.abs(got - want.value) <= want.tol + 1e-9 * Math.max(1, Math.abs(want.value)) ? 100 : 0; // 加浮点余量
    }
    case "multi_regex": {
      const sp = parseSpec<MultiRegexSpec>(exp);
      return sp ? multiRegexScore(out, sp) : 0;
    }
    case "length_range": {
      const sp = parseSpec<LengthSpec>(exp);
      return sp ? lengthScore(out, sp) : 0;
    }
    case "code_output":
      return normalizeCodeOutput(out) === normalizeCodeOutput(exp) ? 100 : 0;
    case "tool_calls": {
      const sp = parseSpec<ToolCallsSpec>(exp);
      return sp ? toolCallsScore(sp, toolCalls) : 0;
    }
    case "rubric":
      return undefined;
  }
}

/**
 * 出题校验：返回错误说明，合法返回 undefined。
 * 供 exam_add_question 与内置题库自检共用。
 */
export function validateExpected(kind: ExamQuestion["kind"], expected: string | undefined, tools?: ExamQuestion["tools"]): string | undefined {
  if (kind === "rubric") return undefined;
  const exp = expected?.trim();
  if (!exp) return `客观题（kind=${kind}）必须给出参考答案 expected`;
  const badRegex = (p: unknown, flags: string): string | undefined => {
    if (typeof p !== "string") return `正则必须是字符串：${JSON.stringify(p)}`;
    try {
      new RegExp(p, flags);
      return undefined;
    } catch (e) {
      return `expected 不是合法正则（${p}）：${(e as Error).message}`;
    }
  };
  const lengthErr = (sp: LengthSpec | undefined): string | undefined => {
    if (!sp || typeof sp !== "object") return "长度约束须为 {min?, max?, unit?}";
    if (sp.min === undefined && sp.max === undefined) return "长度约束至少给出 min 或 max";
    if ((sp.min !== undefined && !Number.isFinite(sp.min)) || (sp.max !== undefined && !Number.isFinite(sp.max))) return "长度约束的 min/max 必须是数字";
    if (sp.min !== undefined && sp.max !== undefined && sp.min > sp.max) return "长度约束 min 不能大于 max";
    if (sp.unit !== undefined && !["chars", "han", "words", "lines"].includes(sp.unit)) return "长度单位须为 chars / han / words / lines";
    return undefined;
  };
  switch (kind) {
    case "regex":
      return badRegex(exp, "iu");
    case "tool_call": {
      const want = parseSpec<{ name?: unknown }>(exp);
      if (!want) return 'tool_call 题的 expected 必须是 JSON：{"name": "工具名", "args": {...}}';
      if (typeof want.name !== "string") return "tool_call 题的 expected.name 必须是工具名字符串";
      if (!tools?.length) return "tool_call 题必须提供 tools（模拟工具定义）";
      if (!tools.some((t) => t.name === want.name)) return `expected.name=${want.name} 不在 tools 中`;
      return undefined;
    }
    case "tool_calls": {
      const sp = parseSpec<ToolCallsSpec>(exp);
      if (!sp || !Array.isArray(sp.calls) || !sp.calls.length) return 'tool_calls 题的 expected 必须是 JSON：{"calls": [{"name", "args"}], "forbid"?: [...], "exact_count"?: true}';
      if (!tools?.length) return "tool_calls 题必须提供 tools（模拟工具定义）";
      for (const c of sp.calls) if (typeof c?.name !== "string" || !tools.some((t) => t.name === c.name)) return `expected.calls 中的工具 ${c?.name} 不在 tools 中`;
      return undefined;
    }
    case "json_exact":
      try {
        JSON.parse(exp);
        return undefined;
      } catch {
        return "json_exact 题的 expected 必须是合法 JSON（目标值）";
      }
    case "numeric":
      return parseNumericExpected(exp) ? undefined : 'numeric 题的 expected 须为数字，可带容差，如 "42"、"7.6±0.05"、"38/5"';
    case "multi_regex": {
      const sp = parseSpec<MultiRegexSpec>(exp);
      if (!sp) return 'multi_regex 题的 expected 必须是 JSON：{"all": [...], "none": [...], "flags"?: "u", "length"?: {...}}';
      const flags = sp.flags ?? "u";
      try {
        new RegExp("", flags);
      } catch {
        return `flags 非法：${flags}`;
      }
      if (![...(sp.all ?? []), ...(sp.none ?? [])].length && !sp.length) return "multi_regex 至少要有一条检查";
      for (const p of [...(sp.all ?? []), ...(sp.none ?? [])]) {
        const e = badRegex(p, flags);
        if (e) return e;
      }
      return sp.length ? lengthErr(sp.length) : undefined;
    }
    case "length_range":
      return lengthErr(parseSpec<LengthSpec>(exp));
    default:
      return undefined;
  }
}

/** 从阅卷模型输出中解析 0..100 分 */
export function parseJudgeScore(text: string): { score: number; comment: string } | undefined {
  const t = cleanOutput(text);
  const obj = extractJson(t) as { score?: unknown; comment?: unknown } | undefined;
  if (obj && typeof obj === "object" && obj.score !== undefined && Number.isFinite(Number(obj.score))) {
    return { score: Math.max(0, Math.min(100, Number(obj.score))), comment: String(obj.comment ?? "") };
  }
  const m = /(?:score|分数|得分)\D{0,6}(\d{1,3}(?:\.\d+)?)/i.exec(t) ?? /\b(\d{1,3})\b/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n > 100) return undefined;
  return { score: n, comment: t.slice(0, 500) };
}

// ───────────────────────── 计分 ─────────────────────────

/** 难度权重：basic 1，hard 3（可被题目自带 weight 覆盖） */
export const DIFFICULTY_WEIGHT: Record<ExamDifficulty, number> = { basic: 1, hard: 3 };

export const difficultyOf = (q: Pick<ExamQuestion, "difficulty">): ExamDifficulty => q.difficulty ?? "basic";

export function questionWeight(q: Pick<ExamQuestion, "difficulty" | "weight">): number {
  return q.weight !== undefined && Number.isFinite(q.weight) && q.weight > 0 ? q.weight : DIFFICULTY_WEIGHT[difficultyOf(q)];
}

export interface ScoredItem {
  dimension: ExamDimension;
  difficulty: ExamDifficulty;
  weight: number;
  score: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function weightedByDim(items: ScoredItem[]): Partial<Record<ExamDimension, number>> {
  const acc = new Map<ExamDimension, { sum: number; w: number }>();
  for (const it of items) {
    const a = acc.get(it.dimension) ?? { sum: 0, w: 0 };
    a.sum += it.score * it.weight;
    a.w += it.weight;
    acc.set(it.dimension, a);
  }
  const out: Partial<Record<ExamDimension, number>> = {};
  for (const [d, a] of acc) if (a.w > 0) out[d] = round1(a.sum / a.w);
  return out;
}

const mean = (xs: number[]) => (xs.length ? round1(xs.reduce((x, y) => x + y, 0) / xs.length) : 0);

/**
 * 维度分 = 该维度各题按权重（basic 1 / hard 3）加权平均；总分 = 各维度分的算术平均。
 * 另给出分难度维度分与基础卷总分（basic_total，用于及第线判定：难题只拉开名次，不让模型因难题落第）。
 */
export function computeScores(items: ScoredItem[]): {
  scores: Partial<Record<ExamDimension, number>>;
  scores_by_difficulty: ExamScoresByDifficulty;
  total: number;
  basic_total?: number;
} {
  const scores = weightedByDim(items);
  const scores_by_difficulty: ExamScoresByDifficulty = {};
  for (const diff of ["basic", "hard"] as const) {
    const part = items.filter((x) => x.difficulty === diff);
    if (part.length) scores_by_difficulty[diff] = weightedByDim(part);
  }
  const basic = scores_by_difficulty.basic;
  return {
    scores,
    scores_by_difficulty,
    total: mean(Object.values(scores) as number[]),
    basic_total: basic ? mean(Object.values(basic) as number[]) : undefined,
  };
}

/** 速度映射：耗时中位数 ≤ 2s 记 100，≥ 60s 记 0，其间按对数线性：100 × ln(60s/L) / ln(30) */
export const SPEED_FAST_MS = 2_000;
export const SPEED_SLOW_MS = 60_000;
export function speedScore(medianMs: number): number {
  if (!Number.isFinite(medianMs) || medianMs <= SPEED_FAST_MS) return 100;
  if (medianMs >= SPEED_SLOW_MS) return 0;
  return round1((100 * Math.log(SPEED_SLOW_MS / medianMs)) / Math.log(SPEED_SLOW_MS / SPEED_FAST_MS));
}

/** 性价比映射：每题平均成本 ≤ $0.0001 记 100，≥ $0.01 记 0，其间按对数线性：50 × log10($0.01/C) */
export const COST_CHEAP = 0.0001;
export const COST_DEAR = 0.01;
export function costEfficiencyScore(costPerQuestion: number): number {
  if (!Number.isFinite(costPerQuestion) || costPerQuestion <= COST_CHEAP) return 100;
  if (costPerQuestion >= COST_DEAR) return 0;
  return round1((100 * Math.log(COST_DEAR / costPerQuestion)) / Math.log(COST_DEAR / COST_CHEAP));
}

/**
 * 实测指标：只统计成功作答的答卷（出错的不计）。
 * 全部成本为 0 视为价格未知 → 不给 cost_efficiency（不参与适配度）。
 */
export function computeMetrics(answers: { latency_ms: number; cost: number; state: string }[]): ExamMetrics {
  const ok = answers.filter((a) => a.state !== "error");
  const lat = ok
    .map((a) => a.latency_ms)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((x, y) => x - y);
  const m: ExamMetrics = {};
  if (lat.length) {
    const mid = lat.length >> 1;
    const median = lat.length % 2 ? lat[mid] : (lat[mid - 1] + lat[mid]) / 2;
    m.median_latency_ms = Math.round(median);
    m.speed = speedScore(median);
  }
  if (ok.length) {
    const total = ok.reduce((s, a) => s + (Number.isFinite(a.cost) ? a.cost : 0), 0);
    m.cost_per_question = total / ok.length;
    if (total > 0) m.cost_efficiency = costEfficiencyScore(m.cost_per_question);
  }
  return m;
}

/** fitness_weights 中实测指标的缺省权重（未配置时各 0.5） */
export const DEFAULT_METRIC_WEIGHT = 0.5;
const METRIC_KEYS = ["speed", "cost_efficiency"] as const;

/**
 * 部门适配度 = Σ(维度分 × 权重) + Σ(实测指标分 × 权重)，除以参与权重之和。
 * 实测指标权重取 fitness_weights.<dept>.speed / cost_efficiency，缺省各 0.5；指标缺失（如价格未知）则不参与。
 */
export function computeFitness(
  scores: Partial<Record<ExamDimension, number>>,
  metrics: ExamMetrics,
  weightsByDept: Record<string, Record<string, number | undefined> | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [dept, weights] of Object.entries(weightsByDept ?? {})) {
    let sum = 0;
    let wsum = 0;
    for (const [k, w] of Object.entries(weights ?? {})) {
      if ((METRIC_KEYS as readonly string[]).includes(k)) continue;
      const sc = scores[k as ExamDimension];
      if (sc === undefined || !w) continue;
      sum += sc * w;
      wsum += w;
    }
    if (!wsum) continue; // 该部门没有任何已考维度：不给适配度（不能只凭速度/成本）
    for (const k of METRIC_KEYS) {
      const v = metrics[k];
      const w = weights?.[k] ?? DEFAULT_METRIC_WEIGHT;
      if (v === undefined || !w || !Number.isFinite(w)) continue;
      sum += v * w;
      wsum += w;
    }
    out[dept] = round1(sum / wsum);
  }
  return out;
}
