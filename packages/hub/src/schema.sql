-- 皇城档案库 schema v1（node:sqlite, WAL）。JSON 字段以 TEXT 存储，列名后缀 _json。
-- 时间一律 epoch 毫秒。

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- ── 名册 ──
CREATE TABLE IF NOT EXISTS depts (
  id TEXT PRIMARY KEY,
  def_json TEXT NOT NULL,            -- DeptDef（含 countersign）
  token TEXT NOT NULL                -- 部门 runtime 凭证
);
CREATE TABLE IF NOT EXISTS posts (
  post_id TEXT PRIMARY KEY,
  dept TEXT NOT NULL,
  def_json TEXT NOT NULL             -- PostDef
);
CREATE TABLE IF NOT EXISTS officials (
  official_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL            -- Official
);
CREATE TABLE IF NOT EXISTS appointments (
  post_id TEXT PRIMARY KEY,
  official_id TEXT NOT NULL UNIQUE,
  since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS appointment_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,              -- appoint|transfer|dismiss|set_model|new_official
  official_id TEXT,
  post_id TEXT,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  official_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,       -- Official 快照（变更后）
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- ── 幂等 ──
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  status INTEGER NOT NULL,
  at INTEGER NOT NULL
);

-- ── 消息 ──
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  reply_to TEXT,
  requires_reply INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- 完整 Message
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_addr, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_addr, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);

CREATE TABLE IF NOT EXISTS deliveries (
  post_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  wakes INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_msg ON deliveries(message_id);
CREATE TABLE IF NOT EXISTS inbox_cursors (
  post_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1,   -- 下一个待分配 seq
  acked_seq INTEGER NOT NULL DEFAULT 0   -- runtime 已处理到的 seq
);

-- ── 议事 ──
CREATE TABLE IF NOT EXISTS deliberations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- Deliberation
);
CREATE TABLE IF NOT EXISTS council_entries (
  id TEXT PRIMARY KEY,
  deliberation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- CouncilEntry
);
CREATE INDEX IF NOT EXISTS idx_council_entries ON council_entries(deliberation_id, created_at);

-- ── 诏令 ──
CREATE TABLE IF NOT EXISTS edicts (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- Edict
);
CREATE INDEX IF NOT EXISTS idx_edicts_state ON edicts(state);
CREATE TABLE IF NOT EXISTS edict_drafts (
  edict_id TEXT NOT NULL,
  no INTEGER NOT NULL,
  data_json TEXT NOT NULL,           -- EdictDraft
  PRIMARY KEY (edict_id, no)
);
CREATE TABLE IF NOT EXISTS edict_reviews (
  id TEXT PRIMARY KEY,
  edict_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- EdictReview
);
CREATE INDEX IF NOT EXISTS idx_edict_reviews ON edict_reviews(edict_id, created_at);
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transitions ON transitions(subject_type, subject_id, at);

-- ── 任务 ──
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  edict_id TEXT,
  parent_id TEXT,
  dept TEXT NOT NULL,
  assignee_post TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- Task
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_post, state);
CREATE INDEX IF NOT EXISTS idx_tasks_edict ON tasks(edict_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks(trace_id);
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_comments ON task_comments(task_id, created_at);

-- ── 服务调用 ──
CREATE TABLE IF NOT EXISTS service_requests (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  routed_to TEXT,
  caller TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- ServiceRequest
);
CREATE INDEX IF NOT EXISTS idx_service_routed ON service_requests(routed_to, state);

-- ── 皇帝待办与审批 ──
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  dedupe_key TEXT,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- Notification
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending';
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  type TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- Approval
);

-- ── 定时任务 ──
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at INTEGER,
  data_json TEXT NOT NULL            -- Schedule
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(owner);
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  UNIQUE (schedule_id, scheduled_at)
);

-- ── 资产 ──
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  owner_official TEXT,
  path TEXT NOT NULL,
  visibility TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,           -- Asset
  UNIQUE (owner, owner_official, path)
);
CREATE TABLE IF NOT EXISTS asset_versions (
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,           -- AssetVersion
  PRIMARY KEY (asset_id, version)
);
CREATE TABLE IF NOT EXISTS asset_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  viewer TEXT NOT NULL,
  action TEXT NOT NULL,              -- read|write|share|delete
  at INTEGER NOT NULL
);

-- ── 账本与预算 ──
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  idem_key TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  post_id TEXT NOT NULL,
  official_id TEXT NOT NULL,
  dept TEXT NOT NULL,
  trace_id TEXT,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  data_json TEXT NOT NULL            -- LedgerEntry
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
CREATE INDEX IF NOT EXISTS idx_ledger_post ON ledger(post_id, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_trace ON ledger(trace_id);
CREATE TABLE IF NOT EXISTS budgets (
  scope TEXT PRIMARY KEY,
  data_json TEXT NOT NULL            -- Budget
);

-- ── 模型与科举 ──
CREATE TABLE IF NOT EXISTS models (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL            -- ModelEntry
);
CREATE TABLE IF NOT EXISTS exam_questions (
  id TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exam_sessions (
  id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exam_answers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_answers ON exam_answers(session_id);

-- ── 稽查 ──
CREATE TABLE IF NOT EXISTS audit_findings (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS impeachments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);

-- ── 事件、追踪、心跳 ──
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  dept TEXT,
  trace_id TEXT,
  span_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  summary TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, id);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor, id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id);
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- Span
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, started_at);
CREATE TABLE IF NOT EXISTS span_links (
  from_span TEXT NOT NULL,
  to_span TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  trace_id TEXT NOT NULL,
  PRIMARY KEY (from_span, to_span, kind)
);
CREATE INDEX IF NOT EXISTS idx_span_links_trace ON span_links(trace_id);
CREATE TABLE IF NOT EXISTS statuses (
  post_id TEXT PRIMARY KEY,
  dept TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- OfficialStatus
);
CREATE TABLE IF NOT EXISTS dept_health (
  dept TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  data_json TEXT
);

-- ── MCP 服务器（仅配置；env/headers 为密钥原文，只给 broker）──
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL            -- McpServerConfig
);
