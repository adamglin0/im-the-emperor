// 工具组 → 工具名。dept 侧据此装配工具；hub 侧据此做服务端 ACL（工具对应的写接口）。
export const TOOL_GROUPS = {
  common: [
    // 消息
    "send_message", "reply_message", "forward_message", "escalate", "read_inbox", "get_message", "get_thread",
    "search_messages", "ack_message", "ask_official", "message_department",
    // 名册
    "list_departments", "list_officials", "get_official_profile", "get_official_status", "get_department_status",
    // 服务
    "list_services", "call_service", "get_service_result", "service_respond",
    // 公文（只读 + 自己的任务）
    "edict_get", "edict_list", "task_get", "task_list", "task_start", "task_update", "task_comment", "task_submit",
    "task_block", "task_create_subtask", "trace_timeline",
    // 皇帝
    "petition_emperor", "report_progress", "get_notification",
    // 资产
    "asset_write", "asset_read", "asset_list", "asset_share", "asset_search", "asset_delete",
    // 定时
    "schedule",
    // 自我
    "sleep", "wait_for", "end_turn", "whats_happening", "compact_memory", "memory_note", "set_status", "my_status",
  ],
  council: ["council_get", "council_speak", "council_next_round", "council_conclude", "propose_edict"],
  drafting: ["edict_submit_draft", "edict_countersign", "edict_request_clarification", "edict_diff"],
  review: ["edict_review", "edict_diff"],
  remonstrate: ["edict_remonstrate"],
  dispatch: ["edict_dispatch", "edict_report", "task_assign", "task_reassign", "task_cancel", "task_extend_deadline", "task_verify"],
  ministry_head: ["task_assign", "task_reassign", "task_verify", "task_cancel", "broadcast_department"],
  config: ["config_get", "config_preview_prompt", "config_propose", "config_history", "config_rollback"],
  exam: ["exam_list_models", "exam_add_question", "exam_list_questions", "exam_start", "exam_status", "exam_grade", "exam_publish"],
  finance: ["ledger_report", "ledger_by_trace", "budget_get", "budget_set"],
  personnel: ["personnel_appoint", "personnel_transfer", "personnel_dismiss", "personnel_set_model", "personnel_new_official", "post_vacancies", "personnel_history"],
  workshop: ["ws_run", "ws_job_status", "ws_job_cancel", "ws_read", "ws_write", "ws_list", "http_fetch", "asset_publish_from_workspace", "asset_import_to_workspace", "tool_inventory"],
  justice: ["task_verify", "bug_report", "bug_list"],
  rites: ["glossary_get", "glossary_update", "style_guide_get"],
  censor: ["audit_findings", "audit_update_finding", "audit_search_events", "audit_trace", "audit_logs", "audit_ledger", "impeach", "audit_report"],
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;
export const ALL_TOOL_GROUPS = Object.keys(TOOL_GROUPS) as ToolGroup[];

/**
 * 有效工具组 = 职位默认 ∪ 额外授予 − 禁用；common 永远在。
 * 职位默认即常规上限：吏部可自行禁用/恢复职位默认组；授予职位默认之外的组（extra）须皇帝批准。
 */
export function effectiveToolGroups(post: { tool_groups: string[] }, official?: { extra_tool_groups: string[]; disabled_tool_groups: string[] }): string[] {
  const set = new Set<string>(post.tool_groups);
  for (const g of official?.extra_tool_groups ?? []) set.add(g);
  set.add("common");
  for (const g of official?.disabled_tool_groups ?? []) if (g !== "common") set.delete(g);
  return [...set];
}

export function toolsForGroups(groups: string[]): string[] {
  const out = new Set<string>();
  for (const g of groups) for (const t of (TOOL_GROUPS as Record<string, readonly string[]>)[g] ?? []) out.add(t);
  return [...out];
}
