// 枚举 → 中文标签与色调。名册（职位/官员）标签见 registry.tsx。
import type {
  DeptId,
  EdictState,
  ExamDimension,
  MessageKind,
  NotificationCategory,
  OfficialState,
  Priority,
  SpanKind,
  Stance,
  TaskState,
  Visibility,
} from "@court/shared/types";

/** 色调：对应 CSS 中 .tag/.seal 的修饰类 */
export type Tone = "red" | "gold" | "jade" | "azure" | "plum" | "ink" | "";

export const DEPT_ORDER: DeptId[] = [
  "zhengshitang",
  "zhongshu",
  "menxia",
  "shangshu",
  "libu",
  "hubu",
  "libu_rites",
  "bingbu",
  "xingbu",
  "gongbu",
  "yushitai",
];

/** 名册未载入时的兜底部门名 */
export const DEPT_NAMES: Record<string, string> = {
  zhengshitang: "政事堂",
  zhongshu: "中书省",
  menxia: "门下省",
  shangshu: "尚书省",
  libu: "吏部",
  hubu: "户部",
  libu_rites: "礼部",
  bingbu: "兵部",
  xingbu: "刑部",
  gongbu: "工部",
  yushitai: "御史台",
};

/** 部门印字（单字） */
export const DEPT_SEAL: Record<string, string> = {
  zhengshitang: "政",
  zhongshu: "中",
  menxia: "门",
  shangshu: "尚",
  libu: "吏",
  hubu: "户",
  libu_rites: "礼",
  bingbu: "兵",
  xingbu: "刑",
  gongbu: "工",
  yushitai: "宪",
};

/** 部门分组（三省 / 六部 / 台） */
export const DEPT_GROUP: Record<string, string> = {
  zhengshitang: "中枢",
  zhongshu: "三省",
  menxia: "三省",
  shangshu: "三省",
  libu: "六部",
  hubu: "六部",
  libu_rites: "六部",
  bingbu: "六部",
  xingbu: "六部",
  gongbu: "六部",
  yushitai: "台",
};

export const EDICT_STATE: Record<EdictState, { label: string; tone: Tone }> = {
  issued: { label: "已颁", tone: "gold" },
  drafting: { label: "起草中", tone: "azure" },
  reviewing: { label: "审核中", tone: "azure" },
  remonstrated: { label: "谏诤待裁", tone: "plum" },
  escalated: { label: "封驳升级", tone: "red" },
  approved: { label: "已准待分派", tone: "jade" },
  awaiting_sign: { label: "待画可", tone: "gold" },
  executing: { label: "执行中", tone: "azure" },
  reported: { label: "已复奏", tone: "gold" },
  completed: { label: "已完成", tone: "jade" },
  withdrawn: { label: "已撤回", tone: "ink" },
  failed: { label: "失败", tone: "red" },
  blocked_budget: { label: "预算阻塞", tone: "red" },
};

/** 诏令六阶段：起草→审核→分派→执行→复奏→完成 */
export const EDICT_STAGES = ["起草", "审核", "分派", "执行", "复奏", "完成"] as const;

/** 状态 → 所处阶段序号（0..5），终态失败/撤回返回 -1 */
export function edictStageIndex(s: EdictState): number {
  switch (s) {
    case "issued":
    case "drafting":
      return 0;
    case "reviewing":
    case "remonstrated":
    case "escalated":
      return 1;
    case "approved":
    case "awaiting_sign":
      return 2;
    case "executing":
    case "blocked_budget":
      return 3;
    case "reported":
      return 4;
    case "completed":
      return 5;
    default:
      return -1;
  }
}

export const EDICT_TERMINAL: EdictState[] = ["completed", "withdrawn", "failed"];

export const TASK_STATE: Record<TaskState, { label: string; tone: Tone }> = {
  pending: { label: "待派", tone: "" },
  assigned: { label: "已派", tone: "gold" },
  in_progress: { label: "办理中", tone: "azure" },
  blocked: { label: "受阻", tone: "red" },
  submitted: { label: "待核验", tone: "plum" },
  returned: { label: "退回", tone: "red" },
  done: { label: "办结", tone: "jade" },
  cancelled: { label: "已撤", tone: "ink" },
  failed: { label: "失败", tone: "red" },
};
export const TASK_COLUMNS: TaskState[] = ["pending", "assigned", "in_progress", "blocked", "submitted", "returned", "done"];

export const OFFICIAL_STATE: Record<OfficialState, { label: string; tone: Tone; icon: string }> = {
  thinking: { label: "思考中", tone: "red", icon: "思" },
  tool: { label: "办事中", tone: "azure", icon: "办" },
  waiting: { label: "等待", tone: "gold", icon: "候" },
  sleeping: { label: "睡眠", tone: "ink", icon: "眠" },
  idle: { label: "闲", tone: "", icon: "闲" },
  paused: { label: "暂停", tone: "ink", icon: "停" },
  suspended: { label: "停俸", tone: "red", icon: "俸" },
  sick: { label: "抱病", tone: "plum", icon: "病" },
  offline: { label: "离线", tone: "ink", icon: "离" },
  vacant: { label: "空缺", tone: "", icon: "缺" },
};

export const STANCE: Record<Stance, { label: string; seal: string; tone: Tone }> = {
  support: { label: "赞成", seal: "可", tone: "jade" },
  oppose: { label: "反对", seal: "否", tone: "red" },
  reserve: { label: "保留", seal: "留", tone: "gold" },
  pass: { label: "弃权", seal: "默", tone: "ink" },
};

export const NOTIF_CATEGORY: Record<NotificationCategory, { label: string; seal: string; tone: Tone }> = {
  edict_proposal: { label: "拟旨待准", seal: "旨", tone: "red" },
  council_conclusion: { label: "议事结论", seal: "议", tone: "red" },
  remonstrance: { label: "谏诤", seal: "谏", tone: "plum" },
  escalation: { label: "封驳升级", seal: "驳", tone: "red" },
  report: { label: "复奏待览", seal: "奏", tone: "gold" },
  approval: { label: "审批", seal: "批", tone: "azure" },
  impeachment: { label: "弹劾", seal: "劾", tone: "red" },
  budget: { label: "预算", seal: "俸", tone: "gold" },
  exam: { label: "科举", seal: "榜", tone: "jade" },
  petition: { label: "上奏", seal: "奏", tone: "azure" },
  progress: { label: "进展知会", seal: "知", tone: "ink" },
  incident: { label: "事故", seal: "急", tone: "red" },
  audit_report: { label: "监察奏报", seal: "宪", tone: "plum" },
  clarification: { label: "请旨释疑", seal: "问", tone: "gold" },
};

export const MESSAGE_KIND: Record<MessageKind, string> = {
  chat: "对话",
  oral_order: "口谕",
  council: "议事",
  edict_notice: "诏令通知",
  task_notice: "任务通知",
  service_request: "服务请求",
  service_result: "服务回执",
  schedule: "定时",
  notification_reply: "御批",
  audit: "稽查",
  fyi: "知会",
  system: "系统",
};

export const PRIORITY: Record<Priority, { label: string; tone: Tone }> = {
  low: { label: "缓", tone: "" },
  normal: { label: "常", tone: "" },
  high: { label: "要", tone: "gold" },
  urgent: { label: "急", tone: "red" },
};

export const VISIBILITY: Record<Visibility | "shared", { label: string; tone: Tone }> = {
  private: { label: "私", tone: "red" },
  department: { label: "部", tone: "azure" },
  court: { label: "公", tone: "jade" },
  shared: { label: "共享", tone: "gold" },
};

export const SPAN_KIND: Record<SpanKind, string> = {
  edict: "圣旨",
  deliberation: "议事",
  draft: "草稿",
  review: "审核",
  remonstrance: "谏诤",
  dispatch: "分派",
  report: "复奏",
  task: "任务",
  turn: "轮次",
  message: "消息",
  service: "服务",
  schedule: "定时",
  tool: "工具",
  notification: "待办",
};

export const SPAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "进行", tone: "azure" },
  ok: { label: "成", tone: "jade" },
  error: { label: "误", tone: "red" },
  rejected: { label: "驳", tone: "red" },
  cancelled: { label: "撤", tone: "ink" },
};

export const EXAM_DIMENSION: Record<ExamDimension, string> = {
  reasoning: "推理",
  instruction: "遵令",
  writing: "文辞",
  translation: "译事",
  tool_use: "器用",
  json: "格式",
  code: "营造",
  summary: "撮要",
};

export const AUDIT_RULE: Record<string, string> = {
  loop_chat: "循环对话",
  idle_spin: "空转",
  overdue: "超期",
  tool_errors: "工具报错",
  claimed_no_output: "称完无产",
  privilege_attempt: "越权",
  injection_suspect: "疑似注入",
  budget_burn: "烧钱过速",
};

export const THINKING_LABEL: Record<string, string> = {
  off: "不思",
  minimal: "微思",
  low: "浅思",
  medium: "中思",
  high: "深思",
  xhigh: "极思",
};

export const TOOL_GROUP_LABEL: Record<string, string> = {
  common: "通用",
  council: "议事",
  drafting: "起草",
  review: "审核",
  remonstrate: "谏诤",
  dispatch: "分派",
  ministry_head: "部堂",
  config: "配置",
  exam: "科举",
  finance: "度支",
  personnel: "人事",
  workshop: "工坊",
  justice: "刑名",
  rites: "礼文",
  censor: "监察",
  mcp_admin: "MCP 配置",
};
export const ALL_TOOL_GROUPS = Object.keys(TOOL_GROUP_LABEL);

export const MODEL_STATUS: Record<string, { label: string; tone: Tone }> = {
  candidate: { label: "待考", tone: "gold" },
  examining: { label: "应试中", tone: "azure" },
  examined: { label: "及第", tone: "jade" },
  failed: { label: "落第", tone: "red" },
  retired: { label: "致仕", tone: "ink" },
};

export const SCHEDULE_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "运行", tone: "jade" },
  pending_approval: { label: "待批", tone: "gold" },
  paused: { label: "暂停", tone: "ink" },
  expired: { label: "过期", tone: "" },
};
