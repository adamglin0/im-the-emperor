// 诏令调查：把「诏令详情 + 追踪 spans + 账本」归并为宏观执行图（DAG）。
// 结构以诏令详情为主（圣旨→草稿 vN→审核→分派→部门任务→子任务→复奏），
// spans 按 attrs.draft_no / review_id / task_id 归并；对不上的宏观 span 挂到最近的宏观祖先下。
import type { EdictDetail, LedgerTraceUsage } from "@court/shared/api";
import type { Address, CourtEvent, Span, Task, TaskState, TraceGraph } from "@court/shared/types";

export type MacroKind = "edict" | "deliberation" | "draft" | "review" | "remonstrance" | "dispatch" | "task" | "service" | "report" | "notification" | "schedule" | "message";
export type NodeStatus = "running" | "ok" | "error" | "rejected" | "cancelled" | "blocked" | "pending";

export interface MacroNode {
  id: string;
  kind: MacroKind;
  /** 卡片上方小字：草稿 v2 / 礼部任务 */
  label: string;
  title: string;
  actor?: Address;
  dept?: string;
  status: NodeStatus;
  /** 审核：approve / reject（决定印文） */
  decision?: "approve" | "reject";
  started_at?: number;
  ended_at?: number;
  /** 直接归并到本节点的宏观 span */
  spanIds: string[];
  ref: { draft_no?: number; review_id?: string; task_id?: string; request_id?: string; deliberation_id?: string; span_id?: string };
  tokens: number;
  cost: number;
  calls: number;
  /** 本节点下全部 span（含轮次/工具/消息） */
  allSpans: string[];
}

export type EdgeKind = "flow" | "reject" | "redraft" | "message" | "service" | "causes";
export interface MacroEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
}

export interface MacroGraph {
  nodes: MacroNode[];
  edges: MacroEdge[];
  nodeById: Map<string, MacroNode>;
  /** span_id → 宏观节点 id */
  spanNode: Map<string, string>;
  spanById: Map<string, Span>;
  critical: { nodes: Set<string>; edges: Set<string> };
  rootId: string;
  totalTokens: number;
  totalCost: number;
  /** turn_id → 用量 */
  turnUsage: Map<string, { tokens: number; cost: number; calls: number }>;
  /** 原始追踪连线（span 级） */
  links: TraceGraph["links"];
}

const MACRO_SPAN_KINDS = new Set(["deliberation", "draft", "review", "remonstrance", "dispatch", "task", "service", "report", "notification", "schedule"]);
export const TERMINAL_TASK: TaskState[] = ["done", "cancelled", "failed"];

export function deptOfAddr(a?: string): string | undefined {
  if (!a) return undefined;
  if (a === "emperor") return "emperor";
  const [k, rest] = a.includes(":") ? [a.slice(0, a.indexOf(":")), a.slice(a.indexOf(":") + 1)] : ["post", a];
  if (k === "post") return rest.split(".")[0];
  if (k === "dept") return rest;
  if (k === "system") return "system";
  return undefined;
}

function taskStatus(s: TaskState): NodeStatus {
  switch (s) {
    case "done":
      return "ok";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "blocked";
    case "returned":
      return "rejected";
    case "pending":
    case "assigned":
      return "pending";
    default:
      return "running";
  }
}

function spanStatus(s: Span["status"]): NodeStatus {
  return s;
}

function attr<T = unknown>(s: Span, k: string): T | undefined {
  return (s.attrs?.[k] as T) ?? undefined;
}

export function buildMacroGraph(id: string, detail: EdictDetail | undefined, trace: TraceGraph | undefined, usage: LedgerTraceUsage | undefined, now = Date.now()): MacroGraph {
  const nodes = new Map<string, MacroNode>();
  const edges: MacroEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (source: string, target: string, kind: EdgeKind, label?: string) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const key = `${source}>${target}>${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: `e${edges.length}:${key}`, source, target, kind, label });
  };
  const add = (n: Omit<MacroNode, "spanIds" | "tokens" | "cost" | "calls" | "allSpans" | "ref"> & { ref?: MacroNode["ref"] }): MacroNode => {
    const ex = nodes.get(n.id);
    if (ex) return ex;
    const x: MacroNode = { spanIds: [], tokens: 0, cost: 0, calls: 0, allSpans: [], ref: {}, ...n };
    nodes.set(x.id, x);
    return x;
  };

  const e = detail?.edict;
  const spans = trace?.spans ?? [];
  const spanById = new Map(spans.map((s) => [s.span_id, s]));
  if (trace?.root && !spanById.has(trace.root.span_id)) spanById.set(trace.root.span_id, trace.root);
  const rootSpan = trace?.root ?? spans.find((s) => s.kind === "edict" && !s.parent_span_id);

  // ── 根：圣旨
  const ROOT = "n:edict";
  const rootStatus: NodeStatus = e
    ? e.state === "completed"
      ? "ok"
      : e.state === "failed"
        ? "error"
        : e.state === "withdrawn"
          ? "cancelled"
          : e.state === "escalated" || e.state === "blocked_budget" || e.state === "remonstrated"
            ? "blocked"
            : "running"
    : rootSpan
      ? spanStatus(rootSpan.status)
      : "running";
  // 非诏令追踪（定时、服务、来信、议事……）：根节点按根 span 的种类标注，经办人取根 span 的 actor
  const ROOT_LABEL: Record<string, string> = { edict: "圣旨", schedule: "定时", service: "服务调用", message: "来信", deliberation: "议事", notification: "待办", task: "任务", turn: "轮次" };
  const rootActor = e || !rootSpan ? "emperor" : rootSpan.actor;
  add({
    id: ROOT,
    kind: "edict",
    label: e || !rootSpan ? "圣旨" : (ROOT_LABEL[rootSpan.kind] ?? rootSpan.kind),
    title: e?.title ?? rootSpan?.name ?? id,
    actor: rootActor,
    dept: deptOfAddr(rootActor) ?? "emperor",
    status: rootStatus,
    started_at: e?.created_at ?? rootSpan?.started_at,
    ended_at: e && ["completed", "failed", "withdrawn"].includes(e.state) ? e.state_entered_at : rootSpan?.ended_at,
  });
  if (rootSpan) nodes.get(ROOT)!.spanIds.push(rootSpan.span_id);

  // ── 议事
  const delibSpan = spans.find((s) => s.kind === "deliberation");
  if (e?.deliberation_id || delibSpan) {
    add({
      id: "n:delib",
      kind: "deliberation",
      label: "政事堂议事",
      title: delibSpan?.name ?? "政事堂议事",
      actor: delibSpan?.actor,
      dept: "zhengshitang",
      status: delibSpan ? spanStatus(delibSpan.status) : "ok",
      started_at: delibSpan?.started_at,
      ended_at: delibSpan?.ended_at,
      ref: { deliberation_id: e?.deliberation_id ?? attr<string>(delibSpan!, "deliberation_id") },
    });
  }

  // ── 草稿与审核
  const drafts = [...(detail?.drafts ?? [])].sort((a, b) => a.no - b.no);
  const reviews = [...(detail?.reviews ?? [])].sort((a, b) => a.created_at - b.created_at);
  const draftNos = new Set(drafts.map((d) => d.no));
  // spans 中出现但详情里没有的草稿号
  for (const s of spans) {
    const no = attr<number>(s, "draft_no");
    if (s.kind === "draft" && typeof no === "number") draftNos.add(no);
  }
  const sortedNos = [...draftNos].sort((a, b) => a - b);
  for (const no of sortedNos) {
    const d = drafts.find((x) => x.no === no);
    const rs = reviews.filter((r) => r.draft_no === no);
    const rejected = rs.some((r) => r.decision === "reject");
    const approved = rs.some((r) => r.decision === "approve");
    const latest = no === Math.max(...sortedNos);
    const sp = spans.find((s) => s.kind === "draft" && attr<number>(s, "draft_no") === no);
    add({
      id: `n:draft:${no}`,
      kind: "draft",
      label: `草稿 v${no}`,
      title: d?.objective || d?.title || sp?.name || `草稿 ${no} 号`,
      actor: d ? `post:${d.author_post}` : sp?.actor,
      dept: "zhongshu",
      status: rejected ? "rejected" : approved || !latest ? "ok" : e && (e.state === "drafting" || e.state === "issued") ? "running" : sp ? spanStatus(sp.status) : "ok",
      started_at: sp?.started_at ?? d?.created_at,
      ended_at: sp?.ended_at ?? d?.created_at,
      ref: { draft_no: no },
    });
  }
  // 尚无草稿但在起草 → 占位
  if (sortedNos.length === 0 && e && (e.state === "drafting" || e.state === "issued")) {
    add({ id: "n:draft:1", kind: "draft", label: "草稿 v1", title: "起草中", actor: e.drafter_post ? `post:${e.drafter_post}` : undefined, dept: "zhongshu", status: "running", started_at: e.state_entered_at, ref: { draft_no: 1 } });
    sortedNos.push(1);
  }
  for (const r of reviews) {
    const sp = spans.find((s) => s.kind === "review" && (attr<string>(s, "review_id") === r.id || (attr<string>(s, "review_id") === undefined && attr<number>(s, "draft_no") === r.draft_no)));
    add({
      id: `n:review:${r.id}`,
      kind: "review",
      label: `门下审核 · v${r.draft_no}`,
      title: r.decision === "reject" ? `封驳：${r.issues.filter((i) => i.severity === "blocking").map((i) => i.reason).join("、") || r.opinion}` : r.opinion || "审核通过",
      actor: `post:${r.reviewer_post}`,
      dept: "menxia",
      status: r.decision === "reject" ? "rejected" : "ok",
      decision: r.decision,
      started_at: sp?.started_at ?? r.created_at,
      ended_at: sp?.ended_at ?? r.created_at,
      ref: { review_id: r.id, draft_no: r.draft_no },
    });
  }
  // 详情里没有、spans 里有的审核
  for (const s of spans) {
    if (s.kind !== "review") continue;
    const rid = attr<string>(s, "review_id");
    const no = attr<number>(s, "draft_no");
    if (rid && nodes.has(`n:review:${rid}`)) continue;
    if (!rid && no !== undefined && reviews.some((r) => r.draft_no === no)) continue;
    const decision = attr<string>(s, "decision") === "reject" || s.status === "rejected" ? "reject" : s.status === "ok" ? "approve" : undefined;
    add({
      id: `n:review:${rid ?? s.span_id}`,
      kind: "review",
      label: `门下审核${no ? ` · v${no}` : ""}`,
      title: s.name,
      actor: s.actor,
      dept: "menxia",
      status: decision === "reject" ? "rejected" : spanStatus(s.status),
      decision,
      started_at: s.started_at,
      ended_at: s.ended_at,
      ref: { review_id: rid, draft_no: no, span_id: s.span_id },
    });
  }
  // 审核中但尚无审核记录 → 占位
  if (e && e.state === "reviewing" && !reviews.some((r) => r.draft_no === e.draft_no)) {
    add({ id: `n:review:pending`, kind: "review", label: `门下审核 · v${e.draft_no}`, title: "审核中", actor: e.reviewer_post ? `post:${e.reviewer_post}` : undefined, dept: "menxia", status: "running", started_at: e.state_entered_at, ref: { draft_no: e.draft_no } });
  }

  // ── 分派、任务、复奏
  const tasks: Task[] = detail?.tasks ?? [];
  const dispatchSpan = spans.find((s) => s.kind === "dispatch");
  const hasDispatch = tasks.length > 0 || !!dispatchSpan || (e && ["executing", "reported", "completed"].includes(e.state));
  if (hasDispatch) {
    add({
      id: "n:dispatch",
      kind: "dispatch",
      label: "尚书分派",
      title: dispatchSpan?.name ?? `分派 ${new Set(tasks.filter((t) => !t.parent_id).map((t) => t.dept)).size} 部`,
      actor: dispatchSpan?.actor ?? (e?.dispatcher_post ? `post:${e.dispatcher_post}` : undefined),
      dept: "shangshu",
      status: dispatchSpan ? spanStatus(dispatchSpan.status) : "ok",
      started_at: dispatchSpan?.started_at ?? detail?.transitions.find((t) => t.to_state === "executing")?.at,
      ended_at: dispatchSpan?.ended_at ?? detail?.transitions.find((t) => t.to_state === "executing")?.at,
    });
  } else if (e?.state === "approved") {
    add({ id: "n:dispatch", kind: "dispatch", label: "尚书分派", title: "待分派", dept: "shangshu", status: "pending", started_at: e.state_entered_at });
  }
  const DEPT_LABEL: Record<string, string> = {
    zhengshitang: "政事堂", zhongshu: "中书省", menxia: "门下省", shangshu: "尚书省", libu: "吏部", hubu: "户部",
    libu_rites: "礼部", bingbu: "兵部", xingbu: "刑部", gongbu: "工部", yushitai: "御史台",
  };
  for (const t of tasks) {
    const sp = spans.find((s) => s.kind === "task" && attr<string>(s, "task_id") === t.id);
    add({
      id: `n:task:${t.id}`,
      kind: "task",
      label: `${DEPT_LABEL[t.dept] ?? t.dept}${t.parent_id ? "子任务" : "任务"}`,
      title: t.title,
      actor: t.assignee_post ? `post:${t.assignee_post}` : `dept:${t.dept}`,
      dept: t.dept,
      status: taskStatus(t.state),
      started_at: sp?.started_at ?? t.created_at,
      ended_at: TERMINAL_TASK.includes(t.state) ? (sp?.ended_at ?? t.state_entered_at) : undefined,
      ref: { task_id: t.id },
    });
  }
  for (const s of spans) {
    if (s.kind !== "task") continue;
    const tid = attr<string>(s, "task_id");
    if (tid && nodes.has(`n:task:${tid}`)) continue;
    const dept = attr<string>(s, "dept") ?? deptOfAddr(s.actor);
    add({
      id: `n:task:${tid ?? s.span_id}`,
      kind: "task",
      label: `${DEPT_LABEL[dept ?? ""] ?? dept ?? ""}任务`,
      title: s.name,
      actor: s.actor,
      dept,
      status: attr<boolean>(s, "blocked") ? "blocked" : spanStatus(s.status),
      started_at: s.started_at,
      ended_at: s.ended_at,
      ref: { task_id: tid, span_id: s.span_id },
    });
  }
  const reportSpan = spans.find((s) => s.kind === "report");
  if (e?.report || reportSpan || (e && ["reported", "completed"].includes(e.state))) {
    add({
      id: "n:report",
      kind: "report",
      label: "复奏",
      title: e?.report?.summary ?? reportSpan?.name ?? "复奏",
      actor: e?.report?.by ?? reportSpan?.actor,
      dept: "shangshu",
      status: e?.state === "completed" ? "ok" : e?.state === "reported" ? "running" : reportSpan ? spanStatus(reportSpan.status) : "ok",
      started_at: reportSpan?.started_at ?? e?.report?.at,
      ended_at: reportSpan?.ended_at ?? e?.report?.at,
    });
  }

  // ── span → 节点归并
  const spanNode = new Map<string, string>();
  if (rootSpan) spanNode.set(rootSpan.span_id, ROOT);
  const mapMacro = (s: Span): string | undefined => {
    switch (s.kind) {
      case "edict":
        return ROOT;
      case "deliberation":
        return nodes.has("n:delib") ? "n:delib" : undefined;
      case "draft": {
        const no = attr<number>(s, "draft_no");
        return no !== undefined && nodes.has(`n:draft:${no}`) ? `n:draft:${no}` : undefined;
      }
      case "review": {
        const rid = attr<string>(s, "review_id");
        if (rid && nodes.has(`n:review:${rid}`)) return `n:review:${rid}`;
        if (nodes.has(`n:review:${s.span_id}`)) return `n:review:${s.span_id}`;
        const no = attr<number>(s, "draft_no");
        const r = reviews.find((x) => x.draft_no === no);
        return r ? `n:review:${r.id}` : undefined;
      }
      case "dispatch":
        return nodes.has("n:dispatch") ? "n:dispatch" : undefined;
      case "task": {
        const tid = attr<string>(s, "task_id");
        if (tid && nodes.has(`n:task:${tid}`)) return `n:task:${tid}`;
        return nodes.has(`n:task:${s.span_id}`) ? `n:task:${s.span_id}` : undefined;
      }
      case "report":
        return nodes.has("n:report") ? "n:report" : undefined;
      default:
        return undefined;
    }
  };
  for (const s of spans) {
    if (!MACRO_SPAN_KINDS.has(s.kind) && s.kind !== "edict") continue;
    const nid = mapMacro(s);
    if (nid) {
      spanNode.set(s.span_id, nid);
      const n = nodes.get(nid)!;
      if (!n.spanIds.includes(s.span_id)) n.spanIds.push(s.span_id);
    }
  }
  // 最近的已归并宏观祖先
  const macroAncestor = (s: Span): string | undefined => {
    let p = s.parent_span_id ? spanById.get(s.parent_span_id) : undefined;
    let guard = 0;
    while (p && guard++ < 64) {
      const n = spanNode.get(p.span_id);
      if (n) return n;
      p = p.parent_span_id ? spanById.get(p.parent_span_id) : undefined;
    }
    return undefined;
  };
  // 未归并的宏观 span（服务、谏诤、待办、定时……）→ 独立节点，挂到宏观祖先下
  const extraParent = new Map<string, string>();
  const pendingMacro = spans.filter((s) => MACRO_SPAN_KINDS.has(s.kind) && !spanNode.has(s.span_id)).sort((a, b) => a.started_at - b.started_at);
  for (const s of pendingMacro) {
    const nid = `n:span:${s.span_id}`;
    const kindLabel: Record<string, string> = { service: "服务调用", remonstrance: "谏诤", notification: "待办", schedule: "定时", deliberation: "议事", draft: "草稿", review: "审核", dispatch: "分派", task: "任务", report: "复奏" };
    add({
      id: nid,
      kind: s.kind as MacroKind,
      label: kindLabel[s.kind] ?? s.kind,
      title: s.name,
      actor: s.actor,
      dept: deptOfAddr(s.actor),
      status: spanStatus(s.status),
      started_at: s.started_at,
      ended_at: s.ended_at,
      ref: { span_id: s.span_id, request_id: attr<string>(s, "request_id") },
    });
    nodes.get(nid)!.spanIds.push(s.span_id);
    spanNode.set(s.span_id, nid);
    extraParent.set(nid, macroAncestor(s) ?? ROOT);
  }
  // hub 在草稿/审核/分派/复奏等宏观 span 上记下产生它的轮次（attrs.by_span）→ 该轮次就归到这个节点（最准）
  const producedBy = new Map<string, string>();
  for (const s of spans) {
    const by = attr<string>(s, "by_span");
    const nid = spanNode.get(s.span_id);
    if (by && nid && !producedBy.has(by)) producedBy.set(by, nid);
  }
  // 轮次 span 带 attrs.task_id（部门运行时标注）→ 直接归到该任务节点
  const byAttrs = (s: Span): string | undefined => {
    const tid = attr<string>(s, "task_id");
    return tid && nodes.has(`n:task:${tid}`) ? `n:task:${tid}` : undefined;
  };
  // 回退：父链对不上（父 span 不在本 trace、或只追到根）→ 按「同一官员 + 时间窗」挂到其经办的宏观节点
  const byActorTime = (s: Span): string | undefined => {
    if (!s.actor?.startsWith("post:")) return undefined;
    let best: MacroNode | undefined;
    for (const n of nodes.values()) {
      if (n.id === ROOT || n.actor !== s.actor || n.started_at === undefined) continue;
      if (n.started_at > s.started_at + 5_000) continue;
      if (n.ended_at !== undefined && n.ended_at + 60_000 < s.started_at) continue;
      if (!best || (best.started_at ?? 0) < n.started_at) best = n;
    }
    return best?.id;
  };
  // 其余 span（轮次/工具/消息）→ 先看是否产生了宏观 span，再按父链找宏观祖先（按开始时间，保证父先于子归并）；
  // 父链只追到根（如来信本身无父）或断开时，才用 attrs / 时间窗启发式
  for (const s of [...spans].sort((a, b) => a.started_at - b.started_at)) {
    if (spanNode.has(s.span_id)) continue;
    const anc = macroAncestor(s);
    spanNode.set(s.span_id, producedBy.get(s.span_id) ?? (anc && anc !== ROOT ? anc : undefined) ?? byAttrs(s) ?? byActorTime(s) ?? anc ?? ROOT);
  }
  for (const [sid, nid] of spanNode) nodes.get(nid)?.allSpans.push(sid);

  // ── 结构边
  if (nodes.has("n:delib")) addEdge("n:delib", ROOT, "flow");
  let prevDraftTail: string | undefined;
  for (const no of sortedNos) {
    const did = `n:draft:${no}`;
    if (!prevDraftTail) addEdge(ROOT, did, "flow");
    else addEdge(prevDraftTail, did, "redraft", "重拟");
    const rs = [...nodes.values()].filter((n) => n.kind === "review" && n.ref.draft_no === no);
    for (const r of rs) {
      addEdge(did, r.id, "flow");
      if (r.decision === "reject") addEdge(r.id, did, "reject", "封驳");
    }
    prevDraftTail = rs.length ? rs[rs.length - 1].id : did;
  }
  // 无草稿号的审核
  for (const n of nodes.values()) if (n.kind === "review" && n.ref.draft_no === undefined) addEdge(prevDraftTail ?? ROOT, n.id, "flow");
  if (nodes.has("n:dispatch")) {
    addEdge(prevDraftTail ?? ROOT, "n:dispatch", "flow");
  }
  for (const n of nodes.values()) {
    if (n.kind !== "task") continue;
    const t = tasks.find((x) => x.id === n.ref.task_id);
    if (t?.parent_id && nodes.has(`n:task:${t.parent_id}`)) addEdge(`n:task:${t.parent_id}`, n.id, "flow");
    else if (!t && n.ref.span_id) {
      const sp = spanById.get(n.ref.span_id)!;
      const anc = macroAncestor(sp);
      addEdge(anc && anc !== ROOT ? anc : nodes.has("n:dispatch") ? "n:dispatch" : ROOT, n.id, "flow");
    } else addEdge(nodes.has("n:dispatch") ? "n:dispatch" : ROOT, n.id, "flow");
  }
  if (nodes.has("n:report")) {
    const tops = [...nodes.values()].filter((n) => n.kind === "task" && !tasks.find((t) => t.id === n.ref.task_id)?.parent_id);
    if (tops.length) for (const t of tops) addEdge(t.id, "n:report", "flow");
    else addEdge(nodes.has("n:dispatch") ? "n:dispatch" : (prevDraftTail ?? ROOT), "n:report", "flow");
  }
  for (const [nid, parent] of extraParent) addEdge(parent, nid, "flow");

  // ── 追踪中的额外连线（消息、服务、因果）
  for (const l of trace?.links ?? []) {
    const a = spanNode.get(l.from_span);
    const b = spanNode.get(l.to_span);
    if (!a || !b || a === b) continue;
    // 结构边已表达的就不重复
    if (edgeKeys.has(`${a}>${b}>flow`) || edgeKeys.has(`${a}>${b}>reject`) || edgeKeys.has(`${a}>${b}>redraft`)) continue;
    addEdge(a, b, l.kind, l.label);
  }

  // ── 用量归集
  const turnSpanByTurnId = new Map<string, string>();
  for (const s of spans) {
    if (s.kind !== "turn") continue;
    const tid = attr<string>(s, "turn_id");
    if (tid) turnSpanByTurnId.set(tid, s.span_id);
    turnSpanByTurnId.set(s.span_id, s.span_id);
  }
  const turnUsage = new Map<string, { tokens: number; cost: number; calls: number }>();
  const totalTokens = usage?.total_tokens ?? 0;
  const totalCost = usage?.cost ?? 0;
  const nodeList = [...nodes.values()];
  for (const u of usage?.by_turn ?? []) {
    if (u.turn_id) {
      const t = turnUsage.get(u.turn_id) ?? { tokens: 0, cost: 0, calls: 0 };
      t.tokens += u.total_tokens;
      t.cost += u.cost;
      t.calls += u.calls;
      turnUsage.set(u.turn_id, t);
    }
    let nid: string | undefined;
    const sid = u.turn_id ? turnSpanByTurnId.get(u.turn_id) : undefined;
    if (sid) nid = spanNode.get(sid);
    if (!nid) {
      // 回退：同一官员、时间窗口内的节点（取最晚开始者）
      const dept = u.post_id.split(".")[0];
      const cands = nodeList
        .filter((n) => n.actor === `post:${u.post_id}` && n.started_at !== undefined && n.started_at <= u.first_ts && (n.ended_at === undefined || n.ended_at + 60_000 >= u.first_ts))
        .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
      nid = cands[0]?.id ?? nodeList.find((n) => n.kind === "task" && n.dept === dept && n.status !== "pending")?.id ?? ROOT;
    }
    const n = nodes.get(nid)!;
    n.tokens += u.total_tokens;
    n.cost += u.cost;
    n.calls += u.calls;
  }

  // ── 关键路径：结构边（flow/redraft）上「耗时」最长链
  const dur = (n: MacroNode) => (n.started_at ? (n.ended_at ?? now) - n.started_at : 0);
  const out = new Map<string, MacroEdge[]>();
  for (const ed of edges) if (ed.kind === "flow" || ed.kind === "redraft") (out.get(ed.source) ?? out.set(ed.source, []).get(ed.source)!).push(ed);
  const memo = new Map<string, { len: number; next?: MacroEdge }>();
  const visiting = new Set<string>();
  const best = (nid: string): { len: number; next?: MacroEdge } => {
    const m = memo.get(nid);
    if (m) return m;
    if (visiting.has(nid)) return { len: 0 };
    visiting.add(nid);
    const self = nid === ROOT ? 0 : dur(nodes.get(nid)!);
    let r: { len: number; next?: MacroEdge } = { len: self };
    for (const ed of out.get(nid) ?? []) {
      const b = best(ed.target);
      if (self + b.len > r.len) r = { len: self + b.len, next: ed };
    }
    visiting.delete(nid);
    memo.set(nid, r);
    return r;
  };
  const start = nodes.has("n:delib") ? "n:delib" : ROOT;
  const critical = { nodes: new Set<string>([start]), edges: new Set<string>() };
  let cur = best(start);
  let guard = 0;
  while (cur.next && guard++ < 200) {
    critical.edges.add(cur.next.id);
    critical.nodes.add(cur.next.target);
    cur = best(cur.next.target);
  }
  if (critical.nodes.size < 2) critical.nodes.clear();

  return { nodes: nodeList, edges, nodeById: nodes, spanNode, spanById, critical, rootId: ROOT, totalTokens, totalCost, turnUsage, links: trace?.links ?? [] };
}

export function nodeDuration(n: { started_at?: number; ended_at?: number }, now = Date.now()): number | undefined {
  if (!n.started_at) return undefined;
  return (n.ended_at ?? now) - n.started_at;
}

/** 状态 → 印文与色调 */
export function statusSeal(n: Pick<MacroNode, "status" | "kind" | "decision">): { text: string; tone: "red" | "jade" | "azure" | "gold" | "plum" | "ink" } {
  if (n.kind === "remonstrance") return { text: "谏", tone: "plum" };
  if (n.kind === "review" && n.decision === "approve") return { text: "准", tone: "jade" };
  switch (n.status) {
    case "ok":
      return { text: "成", tone: "jade" };
    case "rejected":
      return { text: "驳", tone: "red" };
    case "error":
      return { text: "误", tone: "red" };
    case "blocked":
      return { text: "阻", tone: "red" };
    case "cancelled":
      return { text: "撤", tone: "ink" };
    case "pending":
      return { text: "待", tone: "gold" };
    default:
      return { text: "办", tone: "azure" };
  }
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  running: "进行中",
  ok: "已成",
  error: "出错",
  rejected: "被驳",
  cancelled: "已撤",
  blocked: "受阻",
  pending: "待办",
};

export function isErrorEvent(e: CourtEvent): boolean {
  return /error|fail/i.test(e.type) || e.data?.ok === false;
}
