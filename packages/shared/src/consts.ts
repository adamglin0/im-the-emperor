// 系统级常量与安全阀（集中定义，便于调参）
export const LIMITS = {
  // 官员轮次
  maxToolCallsPerTurn: 40,
  maxTurnMs: 10 * 60_000,
  /** 每小时「无实效」轮次上限（只读/结束类工具的轮次；防空转） */
  maxTurnsPerHour: 20,
  /** 每小时总轮次硬上限（防失控；有实效的公务不受 maxTurnsPerHour 限制） */
  maxTurnsPerHourHard: 80,
  minTurnGapMs: 3_000,
  wakeDebounceMs: 2_000,
  maxSleepSeconds: 86_400,
  idleBackoffMaxSeconds: 2 * 3600,
  toolOutputMaxBytes: 8 * 1024,
  briefingMaxItems: 12,
  // 上下文
  compactAtRatio: 0.6,
  compactKeepRecentTokens: 12_000,
  defaultContextWindow: 128_000,
  memoryNoteMaxBytes: 4 * 1024,
  // 消息与风暴
  maxHopCount: 8,
  pairThreadMaxPer10Min: 6,
  petitionPerHour: 3,
  broadcastMaxRecipients: 8,
  // 公文
  maxRejects: 3,
  maxReturns: 3,
  maxReassign: 2,
  maxOpenTasksPerPost: 8,
  councilMaxRounds: 2,
  // 定时任务
  scheduleMinIntervalSeconds: 300,
  scheduleApprovalBelowSeconds: 900,
  schedulesPerOwner: 10,
  // 运行
  hubUnreachablePauseMs: 30_000,
  inboxPollMs: 30_000,
  heartbeatMs: 5_000,
  deptLlmConcurrency: 4,
  watchdogMs: 30_000,
  schedulerTickMs: 5_000,
  outboxMaxItems: 50_000,
} as const;

/** 各类状态默认 SLA（秒） */
export const SLA = {
  edict_drafting: 20 * 60,
  edict_reviewing: 15 * 60,
  edict_approved: 15 * 60, // 等尚书分派
  edict_executing_default: 6 * 3600,
  task_assigned: 30 * 60,
  task_in_progress: 2 * 3600,
  task_submitted: 30 * 60, // 等核验
  lease: 10 * 60,
  service_default: 30 * 60,
  council_turn: 10 * 60,
} as const;

export const DEPT_PORT = 8080;
export const HUB_PORT = 8000;
export const GATEWAY_PORT = 8100;
export const SANDBOX_PORT = 8200;
export const TZ = "Asia/Shanghai";
export const API_VERSION = "1";
