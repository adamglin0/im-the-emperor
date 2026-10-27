// 流程数据访问层：诏令/草稿/审核/任务/议事/服务调用的读写（data_json 存储）。
// 另建两张 B 组私有表（CREATE TABLE IF NOT EXISTS，不改 schema.sql）：
//   flow_payloads(notification_id, data_json)：皇帝待办附带的结构化载荷（批复处理器据此执行）
//   watchdog_marks(key, level, at)：看门狗/升级去重标记，防止同一事项重复上报
import type {
  CouncilEntry,
  Deliberation,
  Edict,
  EdictDraft,
  EdictReview,
  EdictState,
  ServiceRequest,
  Task,
  TaskComment,
  TaskListQuery,
  TaskState,
  Transition,
} from "@court/shared";
import type { Db } from "../db.ts";
import { notFound } from "../ctx.ts";

/** 诏令行：在 Edict 契约之外附加的内部字段（随 data_json 存储，对外返回无害） */
export type EdictRow = Edict & {
  /** 中书侍郎尚未复署最新草稿 */
  awaiting_countersign?: boolean;
  /** 谏诤/预算阻塞前的状态，用于「坚持原旨」恢复 */
  resume_state?: EdictState;
  /** 「第 2 次起不得新增 blocking」只看 draft_no ≥ 该值的审核（皇帝改旨后重置） */
  review_baseline?: number;
  /** 根 span id */
  root_span_id?: string;
  /** 复奏被发回重办后尚未追加分派/重新复奏（简报给分派人 edict_dispatch 而非 edict_report） */
  awaiting_redispatch?: boolean;
};

/** 任务行：附加内部字段 */
export type TaskRow = Task & {
  /** 部门长官已转交下属（简报中 is_head=false） */
  delegated?: boolean;
};

export const TERMINAL_TASK_STATES: readonly TaskState[] = ["done", "cancelled", "failed"];
export const OPEN_TASK_STATES: readonly TaskState[] = ["pending", "assigned", "in_progress", "blocked", "submitted", "returned"];
export const TERMINAL_EDICT_STATES: readonly EdictState[] = ["completed", "withdrawn", "failed"];
/** 等皇帝定夺的停泊状态：看门狗不轮询、不升级 */
export const PARKED_EDICT_STATES: readonly EdictState[] = ["remonstrated", "escalated", "awaiting_sign", "reported", "blocked_budget"];

export const isTaskTerminal = (s: TaskState) => TERMINAL_TASK_STATES.includes(s);
export const isEdictTerminal = (s: EdictState) => TERMINAL_EDICT_STATES.includes(s);

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export function ensureFlowTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_payloads (notification_id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS watchdog_marks (key TEXT PRIMARY KEY, level INTEGER NOT NULL, at INTEGER NOT NULL);
    -- B 组高频查询所需索引（简报/看门狗/稽查每 30s～数分钟执行一次，表随 24/7 运行无限增长，不能全表扫描）
    CREATE INDEX IF NOT EXISTS idx_flow_tasks_state ON tasks(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_flow_deliberations_state ON deliberations(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_flow_service_state ON service_requests(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_flow_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_flow_events_type_ts ON events(type, ts);
    CREATE INDEX IF NOT EXISTS idx_flow_audit_status ON audit_findings(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_flow_exam_answers_state ON exam_answers(state);
    CREATE INDEX IF NOT EXISTS idx_flow_exam_sessions_state ON exam_sessions(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_flow_spans_roots ON spans(kind, started_at) WHERE parent_span_id IS NULL;
  `);
}

export function createFlowStore(db: Db) {
  const store = {
    // ── 诏令 ──
    getEdictOrNull(id: string): EdictRow | undefined {
      return db.getJson<EdictRow>("SELECT data_json FROM edicts WHERE id = ?", id);
    },
    getEdict(id: string): EdictRow {
      const e = store.getEdictOrNull(id);
      if (!e) throw notFound(`诏令 ${id}`);
      return e;
    },
    createEdict(e: EdictRow, now: number): void {
      db.run("INSERT INTO edicts (id, state, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?)", e.id, e.state, e.created_at, now, JSON.stringify(e));
    },
    /** 版本 +1 后写回 */
    updateEdict(e: EdictRow, now: number): EdictRow {
      e.version += 1;
      db.run("UPDATE edicts SET state = ?, updated_at = ?, data_json = ? WHERE id = ?", e.state, now, JSON.stringify(e), e.id);
      return e;
    },
    listEdicts(state: string | undefined, limit: number): EdictRow[] {
      if (state === "active") return db.allJson<EdictRow>(`SELECT data_json FROM edicts WHERE state NOT IN (${inList(TERMINAL_EDICT_STATES)}) ORDER BY created_at DESC LIMIT ?`, limit);
      if (state) return db.allJson<EdictRow>("SELECT data_json FROM edicts WHERE state = ? ORDER BY created_at DESC LIMIT ?", state, limit);
      return db.allJson<EdictRow>("SELECT data_json FROM edicts ORDER BY created_at DESC LIMIT ?", limit);
    },
    listEdictsInStates(states: readonly EdictState[]): EdictRow[] {
      return db.allJson<EdictRow>(`SELECT data_json FROM edicts WHERE state IN (${inList(states)}) ORDER BY created_at LIMIT 2000`);
    },

    createDraft(d: EdictDraft): void {
      db.run("INSERT INTO edict_drafts (edict_id, no, data_json) VALUES (?, ?, ?)", d.edict_id, d.no, JSON.stringify(d));
    },
    updateDraft(d: EdictDraft): void {
      db.run("UPDATE edict_drafts SET data_json = ? WHERE edict_id = ? AND no = ?", JSON.stringify(d), d.edict_id, d.no);
    },
    listDrafts(edictId: string): EdictDraft[] {
      return db.allJson<EdictDraft>("SELECT data_json FROM edict_drafts WHERE edict_id = ? ORDER BY no", edictId);
    },
    getLatestDraftOrNull(edictId: string): EdictDraft | undefined {
      return db.getJson<EdictDraft>("SELECT data_json FROM edict_drafts WHERE edict_id = ? ORDER BY no DESC LIMIT 1", edictId);
    },

    createReview(r: EdictReview): void {
      db.run("INSERT INTO edict_reviews (id, edict_id, created_at, data_json) VALUES (?, ?, ?, ?)", r.id, r.edict_id, r.created_at, JSON.stringify(r));
    },
    listReviews(edictId: string): EdictReview[] {
      return db.allJson<EdictReview>("SELECT data_json FROM edict_reviews WHERE edict_id = ? ORDER BY created_at, rowid", edictId);
    },

    listTransitions(subjectType: string, subjectId: string): Transition[] {
      return db.all<Transition>(
        "SELECT id, subject_type, subject_id, from_state, to_state, actor, reason, at FROM transitions WHERE subject_type = ? AND subject_id = ? ORDER BY id LIMIT 1000",
        subjectType,
        subjectId,
      );
    },

    // ── 任务 ──
    getTaskOrNull(id: string): TaskRow | undefined {
      return db.getJson<TaskRow>("SELECT data_json FROM tasks WHERE id = ?", id);
    },
    getTask(id: string): TaskRow {
      const t = store.getTaskOrNull(id);
      if (!t) throw notFound(`任务 ${id}`);
      return t;
    },
    createTask(t: TaskRow): void {
      db.run(
        "INSERT INTO tasks (id, trace_id, edict_id, parent_id, dept, assignee_post, state, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        t.id,
        t.trace_id,
        t.edict_id ?? null,
        t.parent_id ?? null,
        t.dept,
        t.assignee_post ?? null,
        t.state,
        t.created_at,
        t.updated_at,
        JSON.stringify(t),
      );
    },
    updateTask(t: TaskRow, now: number): TaskRow {
      t.version += 1;
      t.updated_at = now;
      db.run(
        "UPDATE tasks SET assignee_post = ?, state = ?, updated_at = ?, data_json = ? WHERE id = ?",
        t.assignee_post ?? null,
        t.state,
        now,
        JSON.stringify(t),
        t.id,
      );
      return t;
    },
    listTasks(q: TaskListQuery): TaskRow[] {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (q.assignee) {
        where.push("assignee_post = ?");
        params.push(q.assignee);
      }
      if (q.dept) {
        where.push("dept = ?");
        params.push(q.dept);
      }
      if (q.state === "open") where.push(`state IN (${inList(OPEN_TASK_STATES)})`);
      else if (q.state) {
        where.push("state = ?");
        params.push(q.state);
      }
      if (q.trace_id) {
        where.push("trace_id = ?");
        params.push(q.trace_id);
      }
      if (q.edict_id) {
        where.push("edict_id = ?");
        params.push(q.edict_id);
      }
      if (q.parent_id) {
        where.push("parent_id = ?");
        params.push(q.parent_id);
      }
      const limit = Math.min(Math.max(1, Number(q.limit) || 100), 500);
      const sql = `SELECT data_json FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
      return db.allJson<TaskRow>(sql, ...params, limit);
    },
    listTasksOfEdict(edictId: string): TaskRow[] {
      return db.allJson<TaskRow>("SELECT data_json FROM tasks WHERE edict_id = ? ORDER BY created_at LIMIT 1000", edictId);
    },
    listRootTasksOfEdict(edictId: string): TaskRow[] {
      return db.allJson<TaskRow>("SELECT data_json FROM tasks WHERE edict_id = ? AND parent_id IS NULL ORDER BY created_at LIMIT 1000", edictId);
    },
    listChildren(parentId: string): TaskRow[] {
      return db.allJson<TaskRow>("SELECT data_json FROM tasks WHERE parent_id = ? ORDER BY created_at LIMIT 500", parentId);
    },
    listOpenTasks(): TaskRow[] {
      return db.allJson<TaskRow>(`SELECT data_json FROM tasks WHERE state IN (${inList(OPEN_TASK_STATES)}) ORDER BY created_at LIMIT 5000`);
    },
    listOpenTasksOfAssignee(post: string): TaskRow[] {
      return db.allJson<TaskRow>(`SELECT data_json FROM tasks WHERE assignee_post = ? AND state IN (${inList(OPEN_TASK_STATES)}) ORDER BY created_at LIMIT 500`, post);
    },
    countOpenTasks(post: string): number {
      return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_post = ? AND state IN (${inList(OPEN_TASK_STATES)})`, post)?.n ?? 0;
    },

    createComment(c: TaskComment): void {
      db.run("INSERT INTO task_comments (id, task_id, created_at, data_json) VALUES (?, ?, ?, ?)", c.id, c.task_id, c.created_at, JSON.stringify(c));
    },
    listComments(taskId: string): TaskComment[] {
      return db.allJson<TaskComment>("SELECT data_json FROM task_comments WHERE task_id = ? ORDER BY created_at, rowid LIMIT 500", taskId);
    },

    // ── 议事 ──
    getDeliberationOrNull(id: string): Deliberation | undefined {
      return db.getJson<Deliberation>("SELECT data_json FROM deliberations WHERE id = ?", id);
    },
    getDeliberation(id: string): Deliberation {
      const d = store.getDeliberationOrNull(id);
      if (!d) throw notFound(`议事 ${id}`);
      return d;
    },
    createDeliberation(d: Deliberation): void {
      db.run("INSERT INTO deliberations (id, state, created_at, data_json) VALUES (?, ?, ?, ?)", d.id, d.state, d.created_at, JSON.stringify(d));
    },
    updateDeliberation(d: Deliberation, now: number): Deliberation {
      d.version += 1;
      d.updated_at = now;
      db.run("UPDATE deliberations SET state = ?, data_json = ? WHERE id = ?", d.state, JSON.stringify(d), d.id);
      return d;
    },
    listDeliberations(state: string | undefined, limit: number): Deliberation[] {
      if (state) return db.allJson<Deliberation>("SELECT data_json FROM deliberations WHERE state = ? ORDER BY created_at DESC LIMIT ?", state, limit);
      return db.allJson<Deliberation>("SELECT data_json FROM deliberations ORDER BY created_at DESC LIMIT ?", limit);
    },
    createEntry(e: CouncilEntry): void {
      db.run("INSERT INTO council_entries (id, deliberation_id, created_at, data_json) VALUES (?, ?, ?, ?)", e.id, e.deliberation_id, e.created_at, JSON.stringify(e));
    },
    listEntries(deliberationId: string): CouncilEntry[] {
      return db.allJson<CouncilEntry>("SELECT data_json FROM council_entries WHERE deliberation_id = ? ORDER BY created_at, rowid LIMIT 2000", deliberationId);
    },

    // ── 服务调用 ──
    getServiceRequestOrNull(id: string): ServiceRequest | undefined {
      return db.getJson<ServiceRequest>("SELECT data_json FROM service_requests WHERE id = ?", id);
    },
    getServiceRequest(id: string): ServiceRequest {
      const r = store.getServiceRequestOrNull(id);
      if (!r) throw notFound(`服务请求 ${id}`);
      return r;
    },
    createServiceRequest(r: ServiceRequest): void {
      db.run(
        "INSERT INTO service_requests (id, state, routed_to, caller, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?)",
        r.id,
        r.state,
        r.routed_to ?? null,
        r.caller,
        r.created_at,
        JSON.stringify(r),
      );
    },
    updateServiceRequest(r: ServiceRequest): void {
      db.run("UPDATE service_requests SET state = ?, routed_to = ?, data_json = ? WHERE id = ?", r.state, r.routed_to ?? null, JSON.stringify(r), r.id);
    },
    listPendingServiceRequests(routedTo?: string): ServiceRequest[] {
      if (routedTo) return db.allJson<ServiceRequest>("SELECT data_json FROM service_requests WHERE routed_to = ? AND state = 'pending' ORDER BY created_at LIMIT 200", routedTo);
      return db.allJson<ServiceRequest>("SELECT data_json FROM service_requests WHERE state = 'pending' ORDER BY created_at LIMIT 5000");
    },

    // ── 待办载荷 ──
    setPayload(notificationId: string, data: Record<string, unknown>): void {
      db.run("INSERT OR REPLACE INTO flow_payloads (notification_id, data_json) VALUES (?, ?)", notificationId, JSON.stringify(data));
    },
    getPayloadOrNull<T = Record<string, unknown>>(notificationId: string): T | undefined {
      return db.getJson<T>("SELECT data_json FROM flow_payloads WHERE notification_id = ?", notificationId);
    },

    // ── 看门狗标记 ──
    getMarkLevel(key: string): number {
      return db.get<{ level: number }>("SELECT level FROM watchdog_marks WHERE key = ?", key)?.level ?? 0;
    },
    getMark(key: string): { level: number; at: number } | undefined {
      return db.get<{ level: number; at: number }>("SELECT level, at FROM watchdog_marks WHERE key = ?", key);
    },
    setMark(key: string, level: number, at: number): void {
      db.run("INSERT INTO watchdog_marks (key, level, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET level = excluded.level, at = excluded.at", key, level, at);
    },

    /**
     * 关闭与某对象相关、仍待批的皇帝待办（皇帝已经在别处处置过了）。
     * 直接改 notifications 表（status → dismissed），exceptId 为正在批复的那条。
     */
    dismissPendingNotifications(relatedId: string, categories: readonly string[], exceptId?: string): void {
      if (!categories.length) return;
      db.run(
        `UPDATE notifications SET status = 'dismissed', data_json = json_set(data_json, '$.status', 'dismissed')
         WHERE status = 'pending' AND category IN (${inList(categories)}) AND json_extract(data_json, '$.related.id') = ? AND id != ?`,
        relatedId,
        exceptId ?? "",
      );
    },
  };
  return store;
}

export type FlowStore = ReturnType<typeof createFlowStore>;
