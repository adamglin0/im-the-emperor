// 任务状态机：pending → assigned → in_progress ⇄ blocked → submitted → (returned | done) | cancelled | failed
import { LIMITS, SLA, newId, type Address, type Asset, type DeptId, type DispatchTaskSpec, type TaskActionReq, type TaskDetail, type TaskListQuery, type TaskState } from "@court/shared";
import { bad, forbidden, invalidState, versionConflict } from "../ctx.ts";
import { checkVersion, clip, postAddress, postOfAddress } from "./flow-util.ts";
import type { FlowEnv } from "./workflow-env.ts";
import { isTaskTerminal, type TaskRow } from "./workflow-store.ts";
import type { AssetServiceExt } from "./assets.ts";

/** 调用方身份：addr 为地址；post 为经校验的职位（皇帝为空） */
export interface FlowActor {
  addr: Address;
  post?: string;
  /** 调用方当前 span（部门官员的轮次 span，取自请求 parent_span_id）；hub 记入其产生的公文 span（attrs.by_span） */
  span?: string;
}
export const isEmperorActor = (a: FlowActor) => a.addr === "emperor" && !a.post;

export interface CreateTaskInput {
  creator: FlowActor;
  dept: DeptId;
  parent_id?: string;
  assignee_post?: string;
  title: string;
  instructions: string;
  acceptance: string;
  deadline_minutes?: number;
  verify_by?: "self" | "superior" | "xingbu";
  trace_id?: string;
  parent_span_id?: string;
}

/** 转派超限：需在事务外上报后再报错 */
class ReassignLimitError extends Error {
  constructor(public task: TaskRow) {
    super("reassign limit");
  }
}

export const taskSpanId = (taskId: string) => `sp_${taskId}`;

const TASK_STATE_LABEL: Record<TaskState, string> = {
  pending: "待指派",
  assigned: "已指派",
  in_progress: "办理中",
  blocked: "受阻",
  submitted: "待核验",
  returned: "退回重办",
  done: "已办结",
  cancelled: "已取消",
  failed: "失败",
};

/** 某任务状态的 SLA（秒） */
export function taskSlaSeconds(state: TaskState): number | undefined {
  switch (state) {
    case "pending":
    case "assigned":
      return SLA.task_assigned;
    case "in_progress":
    case "blocked":
    case "returned":
      return SLA.task_in_progress;
    case "submitted":
      return SLA.task_submitted;
    default:
      return undefined;
  }
}

export function createTaskFlow(env: FlowEnv) {
  const { ctx, store } = env;
  const reg = () => ctx.registry;

  function setState(t: TaskRow, to: TaskState, actor: Address, reason: string): void {
    const from = t.state;
    t.state = to;
    t.state_entered_at = env.now();
    ctx.transition("task", t.id, from, to, actor, reason, t.trace_id);
    // 状态已变，旧状态的超期上报（皇帝待办）随之作废
    store.dismissPendingNotifications(t.id, ["escalation"]);
  }

  const isActive = (p: string) => reg().officialOf(p)?.status === "active";

  function edictDispatcher(t: TaskRow): string | undefined {
    return t.edict_id ? store.getEdictOrNull(t.edict_id)?.dispatcher_post : undefined;
  }

  function isDeptHead(post: string, dept: string): boolean {
    const p = reg().post(post);
    return !!p && p.dept === dept && (p.roles.includes("head") || p.roles.includes("deputy"));
  }

  function isManager(t: TaskRow, a: FlowActor): boolean {
    if (isEmperorActor(a)) return true;
    const post = a.post;
    if (!post) return false;
    return isDeptHead(post, t.dept) || t.creator === postAddress(post) || edictDispatcher(t) === post;
  }

  function managerHint(t: TaskRow): string {
    const parts = [`任务所在部门（${t.dept}）长官`, `创建者（${t.creator}）`];
    const d = edictDispatcher(t);
    if (d) parts.push(`诏令分派人（${d}）`);
    return parts.join("、");
  }

  function requireAssignee(t: TaskRow, a: FlowActor, action: string): void {
    if (isEmperorActor(a)) return;
    if (!a.post || a.post !== t.assignee_post) {
      throw forbidden(`只有承办人（${t.assignee_post ?? "尚未指派"}）可以对任务 ${t.id} 执行 ${action}；你是 ${a.post ?? a.addr}`);
    }
  }

  function requireManager(t: TaskRow, a: FlowActor, action: string): void {
    if (!isManager(t, a)) throw forbidden(`只有${managerHint(t)}可以对任务 ${t.id} 执行 ${action}；你是 ${a.post ?? a.addr}`);
  }

  function requireState(t: TaskRow, allowed: TaskState[], action: string): void {
    if (!allowed.includes(t.state)) {
      throw invalidState(`任务 ${t.id} 当前状态为「${t.state}（${TASK_STATE_LABEL[t.state]}）」，不能执行 ${action}；允许的状态：${allowed.join(" / ")}`);
    }
  }

  /** 管理者（用于知会受阻/失败）：创建者职位 → 诏令分派人 → 部门长官 */
  function managerPost(t: TaskRow): string | undefined {
    return postOfAddress(t.creator) ?? edictDispatcher(t) ?? env.headOf(t.dept, t.assignee_post ? [t.assignee_post] : undefined);
  }

  /** 选核验人（必须持有 task_verify 工具、在任，且不是承办人本人；exclude 用于看门狗改派） */
  function verifierFor(t: TaskRow, exclude: string[] = []): string | undefined {
    const ex = [...exclude, ...(t.assignee_post ? [t.assignee_post] : [])];
    const ok = (p: string | undefined): p is string => !!p && !ex.includes(p) && isActive(p) && reg().hasTool(p, "task_verify");
    if (t.verify_by === "xingbu") {
      const x = reg().routeDept("xingbu", "verify", { exclude: ex });
      if (ok(x)) return x;
    }
    const cands = [
      postOfAddress(t.creator),
      env.headOf(t.dept, ex),
      edictDispatcher(t),
      reg().routeDept("xingbu", "verify", { exclude: ex }),
    ];
    return cands.find(ok);
  }

  function checkOpenLimit(post: string): void {
    const n = store.countOpenTasks(post);
    if (n >= LIMITS.maxOpenTasksPerPost) {
      throw invalidState(`${post} 名下未结任务已有 ${n} 件（上限 ${LIMITS.maxOpenTasksPerPost}），请改派他人或待其办结后再指派`);
    }
  }

  function checkAssigneeInDept(assignee: string, dept: string): void {
    const p = reg().post(assignee);
    if (!p) throw bad(`职位 ${assignee} 不存在，请用 list_officials 查询正确的 post_id`);
    if (p.dept !== dept) throw bad(`${assignee} 不属于任务所在部门 ${dept}；只能指派给本部门职位，跨部门请新建任务（task_create_subtask，dept=${p.dept}）`);
  }

  function addComment(taskId: string, author: Address, content: string): void {
    store.createComment({ id: newId("tc"), task_id: taskId, author, content, created_at: env.now() });
  }

  function taskBrief(t: TaskRow): string {
    const lines = [
      `任务：${t.title}（${t.id}）`,
      `承办部门：${t.dept}；承办人：${t.assignee_post ?? "待指派"}；状态：${t.state}`,
      t.edict_id ? `所属诏令：${t.edict_id}` : "",
      t.parent_id ? `父任务：${t.parent_id}` : "",
      `要求：${clip(t.instructions, 1500)}`,
      `验收标准：${clip(t.acceptance, 800)}`,
      t.deadline ? `期限：${new Date(t.deadline).toISOString()}` : "",
      `核验方式：${t.verify_by}`,
    ];
    return lines.filter(Boolean).join("\n");
  }

  function notifyTask(post: string | undefined, t: TaskRow, subject: string, body: string, wakes = true): void {
    env.notify(post, "task_notice", subject, body, { trace_id: t.trace_id, wakes, meta: { task_id: t.id, edict_id: t.edict_id } });
  }

  function detail(id: string): TaskDetail {
    const task = store.getTask(id);
    return { task, comments: store.listComments(id), children: store.listChildren(id), transitions: store.listTransitions("task", id) };
  }

  /** 级联取消全部未结后代任务（父任务终结后子孙任务的工作已无意义，留着会被看门狗无限督办） */
  function cancelDescendants(t: TaskRow, actor: Address, depth = 0): number {
    if (depth > 20) return 0;
    let n = 0;
    for (const c of store.listChildren(t.id)) {
      if (!isTaskTerminal(c.state)) {
        c.lease_until = undefined;
        setState(c, "cancelled", actor, `父任务 ${t.id} ${TASK_STATE_LABEL[t.state]}，随之取消`);
        store.updateTask(c, env.now());
        ctx.events.endSpan(taskSpanId(c.id), "cancelled", { parent: t.id });
        notifyTask(c.assignee_post, c, `任务已取消：${c.title}`, `父任务 ${t.id}「${clip(t.title, 60)}」已${TASK_STATE_LABEL[t.state]}，子任务 ${c.id} 随之取消，请停止办理。`);
        n++;
      }
      n += cancelDescendants(c, actor, depth + 1);
    }
    return n;
  }

  /** 任务终结后的善后：结束 span、级联取消子孙、知会父任务承办人、诏令根任务全部终结时知会分派人 */
  function afterTerminal(t: TaskRow, actor: Address = "system:workflow"): void {
    ctx.events.endSpan(taskSpanId(t.id), t.state === "done" ? "ok" : t.state === "failed" ? "error" : "cancelled", { state: t.state });
    cancelDescendants(t, actor);
    if (t.parent_id) {
      const parent = store.getTaskOrNull(t.parent_id);
      if (parent && !isTaskTerminal(parent.state)) {
        const siblings = store.listChildren(parent.id);
        const allDone = siblings.every((s) => isTaskTerminal(s.state));
        notifyTask(
          parent.assignee_post,
          parent,
          allDone ? `子任务已全部终结：${parent.title}` : `子任务终结：${t.title}`,
          `子任务 ${t.id}「${t.title}」${TASK_STATE_LABEL[t.state]}${t.result ? `\n结果：${clip(t.result, 800)}` : ""}` +
            (allDone ? `\n父任务 ${parent.id} 的 ${siblings.length} 个子任务均已终结，请汇总后提交（task_submit）。` : ""),
          allDone,
        );
      }
    }
    if (t.edict_id && !t.parent_id) {
      const e = store.getEdictOrNull(t.edict_id);
      if (e && e.state === "executing") {
        const roots = store.listRootTasksOfEdict(e.id);
        // 同诏兄弟任务办结：知会其余未结任务的承办人（常有先后依赖，如刑部核验须待兵部结果）。
        // 用 edict_notice：可打断承办人的 wait_for（interruptible_by 含 edict）
        if (t.state === "done" || t.state === "failed") {
          const notified = new Set<string>();
          for (const r of roots) {
            if (r.id === t.id || isTaskTerminal(r.state) || !r.assignee_post || r.assignee_post === t.assignee_post || notified.has(r.assignee_post)) continue;
            notified.add(r.assignee_post);
            env.notify(
              r.assignee_post,
              "edict_notice",
              `同诏任务${TASK_STATE_LABEL[t.state]}：${t.title}`,
              `诏令 ${e.id}「${e.title}」下 ${t.dept} 的任务 ${t.id}「${t.title}」${TASK_STATE_LABEL[t.state]}。` +
                `${t.result ? `\n结果：${clip(t.result, 1200)}` : ""}${t.result_assets.length ? `\n产物资产：${t.result_assets.join("、")}` : ""}` +
                `\n如你的任务 ${r.id}「${r.title}」有赖于此，请据此继续办理。`,
              { trace_id: e.id, meta: { task_id: r.id, edict_id: e.id, sibling_task_id: t.id } },
            );
          }
        }
        if (roots.length && roots.every((r) => isTaskTerminal(r.state))) {
          const summary = roots.map((r) => `- ${r.id}「${r.title}」${r.dept}：${TASK_STATE_LABEL[r.state]}`).join("\n");
          env.notify(e.dispatcher_post, "edict_notice", `诏令任务已全部终结，请复奏：${e.title}`, `诏令 ${e.id} 的全部任务已终结：\n${summary}\n请汇总结果（含失败项）后用 edict_report 向陛下复奏。`, {
            trace_id: e.id,
            meta: { edict_id: e.id },
          });
        }
      }
    }
  }

  function createTaskRow(input: {
    creator: Address;
    dept: DeptId;
    parent?: TaskRow;
    edict_id?: string;
    trace_id: string;
    assignee?: string;
    title: string;
    instructions: string;
    acceptance: string;
    deadline_minutes?: number;
    verify_by: "self" | "superior" | "xingbu";
    parent_span_id?: string;
  }): TaskRow {
    const now = env.now();
    const t: TaskRow = {
      id: newId("tk"),
      trace_id: input.trace_id,
      edict_id: input.edict_id,
      parent_id: input.parent?.id,
      dept: input.dept,
      assignee_post: input.assignee,
      creator: input.creator,
      title: input.title,
      instructions: input.instructions,
      acceptance: input.acceptance,
      deadline: input.deadline_minutes ? now + input.deadline_minutes * 60_000 : undefined,
      verify_by: input.verify_by,
      state: input.assignee ? "assigned" : "pending",
      version: 1,
      result_assets: [],
      return_count: 0,
      reassign_count: 0,
      created_at: now,
      updated_at: now,
      state_entered_at: now,
      lease_until: input.assignee ? now + SLA.lease * 1000 : undefined,
    };
    store.createTask(t);
    ctx.transition("task", t.id, "pending", t.state, input.creator, input.assignee ? `创建并指派给 ${input.assignee}` : "创建，待指派", t.trace_id);
    ctx.events.span({
      span_id: taskSpanId(t.id),
      trace_id: t.trace_id,
      parent_span_id: input.parent ? taskSpanId(input.parent.id) : input.parent_span_id,
      kind: "task",
      name: t.title,
      actor: input.creator,
      status: "running",
      started_at: now,
      attrs: { task_id: t.id, dept: t.dept, assignee: t.assignee_post, edict_id: t.edict_id },
    });
    if (t.assignee_post) notifyTask(t.assignee_post, t, `新任务：${t.title}`, `${taskBrief(t)}\n\n请开始办理（task_start），完成后 task_submit。若需部门内转交，可用 task_assign。`);
    return t;
  }

  /**
   * 提交附件的自动分享：资产须存在且属于提交人（本人私产或本部门资产）；其余跳过并写入 warnings。
   * 分享对象：核验人、任务创建者（职位）、诏令分派人、父任务承办人。
   */
  function shareResultAssets(t: TaskRow, ids: string[], submitter: Address, verifier: string | undefined, warnings: string[]): { ok: string[]; with: Address[] } {
    const ok: string[] = [];
    const parent = t.parent_id ? store.getTaskOrNull(t.parent_id) : undefined;
    const targets = [...new Set([verifier, postOfAddress(t.creator), edictDispatcher(t), parent?.assignee_post].filter((p): p is string => !!p && p !== t.assignee_post))].map(postAddress);
    const svc = ctx.assets as Partial<AssetServiceExt> | undefined;
    for (const id of [...new Set(ids)]) {
      const a = svc?.get ? svc.get(id) : ctx.db.getJson<Asset>("SELECT data_json FROM assets WHERE id = ?", id);
      if (!a) {
        warnings.push(`资产 ${id} 不存在，已忽略（请用 asset_list 核对编号）`);
        continue;
      }
      if (!ownsAsset(a, submitter)) {
        warnings.push(`资产 ${id} 不属于你或你的部门，未自动分享，已忽略；如需附上请让其所有者 asset_share`);
        continue;
      }
      if (targets.length) {
        if (svc?.share) svc.share(id, submitter, targets);
        else {
          const next: Asset = { ...a, shared_with: [...new Set([...(a.shared_with ?? []), ...targets])].slice(0, 100), updated_at: env.now() };
          ctx.db.run("UPDATE assets SET updated_at = ?, data_json = ? WHERE id = ?", next.updated_at, JSON.stringify(next), id);
        }
      }
      ok.push(id);
    }
    return { ok, with: targets };
  }

  /** 资产归属：皇帝/系统任意；个人资产按官员（跟人走）或职位；部门资产按部门 */
  function ownsAsset(a: Asset, actor: Address): boolean {
    if (actor === "emperor" || actor.startsWith("system:")) return true;
    const svc = ctx.assets as Partial<AssetServiceExt> | undefined;
    if (svc?.canWrite) return svc.canWrite(a, actor);
    const post = postOfAddress(actor);
    if (!post) return false;
    if (a.owner.startsWith("post:")) return a.owner_official ? reg().officialOf(post)?.official_id === a.owner_official : a.owner === actor;
    if (a.owner.startsWith("dept:")) return reg().post(post)?.dept === a.owner.slice(5);
    return false;
  }

  const flow = {
    verifierFor,
    afterTerminal,
    detail,

    getTaskDetail(id: string): TaskDetail {
      return detail(id);
    },

    listTasks(q: TaskListQuery): TaskRow[] {
      return store.listTasks(q);
    },

    openTaskCount(post: string): number {
      return store.countOpenTasks(post);
    },

    /** 尚书分派：按部门路由指派，不受未结上限约束（避免整道诏令卡住） */
    createDispatchedTask(edictId: string, spec: DispatchTaskSpec, dispatcherPost: string, dispatchSpanId: string): TaskRow {
      const assignee = reg().routeDept(spec.dept, "task");
      return createTaskRow({
        creator: postAddress(dispatcherPost),
        dept: spec.dept,
        edict_id: edictId,
        trace_id: edictId,
        assignee,
        title: spec.title,
        instructions: spec.instructions,
        acceptance: spec.acceptance,
        deadline_minutes: spec.deadline_minutes,
        verify_by: spec.verify_by ?? "superior",
        parent_span_id: dispatchSpanId,
      });
    },

    createTask(input: CreateTaskInput): TaskRow {
      return ctx.db.tx(() => {
        const creatorPost = input.creator.post;
        if (!reg().dept(input.dept)) throw bad(`部门 ${input.dept} 不存在；可选：${reg().depts().map((d) => d.id).join(", ")}`);
        let parent: TaskRow | undefined;
        if (input.parent_id) {
          parent = store.getTask(input.parent_id);
          if (isTaskTerminal(parent.state)) throw invalidState(`父任务 ${parent.id} 已终结（${parent.state}），不能再建子任务`);
          if (!isEmperorActor(input.creator) && creatorPost !== parent.assignee_post && !isManager(parent, input.creator)) {
            throw forbidden(`只有父任务承办人（${parent.assignee_post}）或其管理者可以为任务 ${parent.id} 建子任务`);
          }
        }
        const creatorDept = creatorPost ? reg().post(creatorPost)?.dept : undefined;
        let assignee: string | undefined;
        let routedNote = "";
        if (input.assignee_post && creatorDept === input.dept) {
          checkAssigneeInDept(input.assignee_post, input.dept);
          checkOpenLimit(input.assignee_post);
          assignee = input.assignee_post;
        } else {
          if (input.assignee_post) {
            if (!reg().post(input.assignee_post)) throw bad(`职位 ${input.assignee_post} 不存在，请用 list_officials 查询正确的 post_id`);
            routedNote = `跨部门任务不能直接指定承办人（你指定了 ${input.assignee_post}），已按 ${input.dept} 的部门路由指派。`;
          }
          assignee = reg().routeDept(input.dept, "task", { exclude: creatorPost ? [creatorPost] : [] });
        }
        const t = createTaskRow({
          creator: input.creator.addr,
          dept: input.dept,
          parent,
          edict_id: parent?.edict_id,
          trace_id: parent?.trace_id ?? input.trace_id ?? newId("tr"),
          assignee,
          title: input.title,
          instructions: input.instructions,
          acceptance: input.acceptance,
          deadline_minutes: input.deadline_minutes,
          verify_by: input.verify_by ?? "superior",
          parent_span_id: input.parent_span_id,
        });
        if (routedNote) addComment(t.id, "system:workflow", routedNote);
        return t;
      });
    },

    taskAction(id: string, req: TaskActionReq, actor: FlowActor): TaskDetail {
      try {
        return ctx.db.tx(() => applyAction(id, req, actor));
      } catch (e) {
        if (e instanceof ReassignLimitError) {
          escalateReassignLimit(e.task, actor);
          throw invalidState(`任务 ${id} 已转派 ${e.task.reassign_count} 次（上限 ${LIMITS.maxReassign}），不能再转派；已自动上报尚书都事督办`);
        }
        throw e;
      }
    },

    /** 诏令撤回/失败时级联取消未结任务 */
    cancelOpenTasksOfEdict(edictId: string, actor: Address, reason: string): number {
      let n = 0;
      for (const t of store.listTasksOfEdict(edictId)) {
        if (isTaskTerminal(t.state)) continue;
        t.lease_until = undefined;
        setState(t, "cancelled", actor, reason);
        store.updateTask(t, env.now());
        ctx.events.endSpan(taskSpanId(t.id), "cancelled", { reason });
        notifyTask(t.assignee_post, t, `任务已取消：${t.title}`, `任务 ${t.id} 已取消：${reason}。请停止办理。`, true);
        n++;
      }
      return n;
    },

    /** 看门狗：已指派未开工且租约过期 → 部门内改派；返回是否改派 */
    reassignStale(t: TaskRow, actor: Address): boolean {
      return ctx.db.tx(() => {
        const cur = store.getTask(t.id);
        if (cur.state !== "assigned") return false;
        const now = env.now();
        if (cur.reassign_count >= LIMITS.maxReassign) {
          cur.lease_until = undefined;
          store.updateTask(cur, now);
          return false;
        }
        const old = cur.assignee_post;
        const next = reg().routeDept(cur.dept, "task", { exclude: old ? [old] : [] });
        if (!next || next === old || store.countOpenTasks(next) >= LIMITS.maxOpenTasksPerPost) {
          cur.lease_until = now + SLA.lease * 1000;
          store.updateTask(cur, now);
          return false;
        }
        cur.assignee_post = next;
        cur.reassign_count += 1;
        cur.lease_until = now + SLA.lease * 1000;
        setState(cur, "assigned", actor, `租约过期未开工，由 ${old ?? "无人"} 改派 ${next}`);
        store.updateTask(cur, now);
        notifyTask(next, cur, `改派任务：${cur.title}`, `${taskBrief(cur)}\n\n原承办人 ${old ?? "无"} 逾时未开工，现改派给你，请尽快办理（task_start）。`);
        notifyTask(old, cur, `任务已改派：${cur.title}`, `任务 ${cur.id} 因你逾时未开工，已改派给 ${next}。`, false);
        return true;
      });
    },

    /** 看门狗：待核验且租约过期 → 核验人缺位/改派他人（同样须持 task_verify）；返回是否改派 */
    reassignVerifier(t: TaskRow, actor: Address): boolean {
      return ctx.db.tx(() => {
        const cur = store.getTask(t.id);
        if (cur.state !== "submitted" || !cur.lease_until || cur.lease_until > env.now()) return false;
        const now = env.now();
        const old = cur.verifier_post;
        cur.lease_until = now + SLA.lease * 1000;
        // 原核验人仍在任 → 只续租约（催办交给 SLA 逐级上报，其长官亦可代核）；缺位才改派
        const next = old && isActive(old) ? undefined : verifierFor(cur, old ? [old] : []);
        if (!next || next === old) {
          store.updateTask(cur, now);
          return false;
        }
        cur.verifier_post = next;
        ctx.transition("task", cur.id, cur.state, cur.state, actor, `核验逾时，由 ${old ?? "无人"} 改为 ${next} 核验`, cur.trace_id);
        store.updateTask(cur, now);
        notifyTask(next, cur, `请核验任务：${cur.title}`, `${taskBrief(cur)}\n\n原核验人 ${old ?? "无"} 逾时未核验，改由你核验。承办人提交的结果：\n${clip(cur.result ?? "", 3000)}${cur.result_assets.length ? `\n附资产：${cur.result_assets.join(", ")}` : ""}\n\n请对照验收标准核验（task_verify）。`);
        notifyTask(old, cur, `任务核验已改派：${cur.title}`, `任务 ${cur.id} 因你逾时未核验，已改由 ${next} 核验。`, false);
        if (cur.result_assets.length) {
          try {
            shareResultAssets(cur, cur.result_assets, cur.assignee_post ? postAddress(cur.assignee_post) : "system:workflow", next, []);
          } catch {
            /* 分享失败不阻塞改派 */
          }
        }
        return true;
      });
    },

    /** 看门狗：待指派任务重新路由 */
    assignPending(t: TaskRow, actor: Address): boolean {
      return ctx.db.tx(() => {
        const cur = store.getTask(t.id);
        if (cur.state !== "pending") return false;
        const next = reg().routeDept(cur.dept, "task");
        if (!next) return false;
        const now = env.now();
        cur.assignee_post = next;
        cur.lease_until = now + SLA.lease * 1000;
        setState(cur, "assigned", actor, `看门狗按部门路由指派给 ${next}`);
        store.updateTask(cur, now);
        notifyTask(next, cur, `新任务：${cur.title}`, `${taskBrief(cur)}\n\n请开始办理（task_start）。`);
        return true;
      });
    },

    taskBrief,
    managerPost,
  };

  function escalateReassignLimit(t: TaskRow, actor: FlowActor): void {
    ctx.db.tx(() => {
      const key = `reassign_limit:${t.id}`;
      if (store.getMarkLevel(key) > 0) return;
      store.setMark(key, 1, env.now());
      const duty = reg().pickPost("shangshu", ["duty"]) ?? reg().pickPost("shangshu", ["head"]);
      env.notify(
        duty,
        "task_notice",
        `转派超限，请督办：${t.title}`,
        `${taskBrief(t)}\n\n该任务已转派 ${t.reassign_count} 次（上限 ${LIMITS.maxReassign}），${actor.post ?? actor.addr} 又试图转派。请督办：确定承办人或上报左右丞。`,
        { trace_id: t.trace_id, meta: { task_id: t.id }, priority: "high" },
      );
      env.emit("task.escalated", "system:workflow", `任务 ${t.id} 转派超限，上报都事 ${duty ?? "（无人）"}`, { trace_id: t.trace_id, subject_type: "task", subject_id: t.id });
    });
  }

  function applyAction(id: string, req: TaskActionReq, actor: FlowActor): TaskDetail {
    const t = store.getTask(id);
    checkVersion(req.expected_version, t.version, versionConflict);
    const now = env.now();
    const who = actor.post ? postAddress(actor.post) : actor.addr;
    const terminalBefore = isTaskTerminal(t.state);
    let note: string | undefined;
    const warnings: string[] = [];

    switch (req.action) {
      case "start": {
        requireAssignee(t, actor, "start");
        if (t.state === "in_progress") throw invalidState(`任务 ${t.id} 已在办理中，无需重复 start`);
        requireState(t, ["assigned", "returned"], "start");
        t.lease_until = undefined;
        setState(t, "in_progress", who, "开始办理");
        break;
      }
      case "update": {
        requireAssignee(t, actor, "update");
        requireState(t, ["assigned", "in_progress", "blocked", "returned"], "update");
        if (t.state === "assigned" || t.state === "returned") {
          t.lease_until = undefined;
          setState(t, "in_progress", who, "报告进展（自动开始办理）");
        }
        addComment(t.id, who, `【进展】${req.progress}`);
        ctx.events.emit({ type: "task.progress", actor: who, trace_id: t.trace_id, span_id: taskSpanId(t.id), subject_type: "task", subject_id: t.id, summary: clip(req.progress, 200) });
        break;
      }
      case "submit": {
        requireAssignee(t, actor, "submit");
        if (t.state === "blocked") throw invalidState(`任务 ${t.id} 处于受阻状态，请先 unblock（task_block action=unblock）再提交`);
        requireState(t, ["assigned", "in_progress", "returned"], "submit");
        t.result = req.result;
        t.lease_until = undefined;
        const verifier = t.verify_by === "self" ? undefined : verifierFor(t);
        // 附件资产自动分享给核验人/创建者/诏令分派人/父任务承办人，否则私产对他们不可读（403）
        const shared = shareResultAssets(t, req.asset_ids ?? [], who, verifier, warnings);
        t.result_assets = shared.ok;
        if (t.verify_by === "self") {
          setState(t, "done", who, "提交（自验）即办结");
          note = "自验任务已办结";
        } else {
          if (!verifier) {
            addComment(t.id, "system:workflow", "无可用核验人，按自验办结");
            setState(t, "done", who, "提交；无可用核验人，自动办结");
            note = "无可用核验人，已按自验办结";
          } else {
            t.verifier_post = verifier;
            // 核验也带租约：核验人逾时（缺位/掉线）看门狗改派其他核验人
            t.lease_until = now + SLA.lease * 1000;
            setState(t, "submitted", who, `提交待 ${verifier} 核验`);
            note = `已自动通知核验人 ${verifier} 核验，无需另行发信`;
            notifyTask(
              verifier,
              t,
              `请核验任务：${t.title}`,
              `${taskBrief(t)}\n\n承办人 ${t.assignee_post} 已提交结果：\n${clip(req.result, 3000)}${t.result_assets.length ? `\n附资产：${t.result_assets.join(", ")}` : ""}\n\n请对照验收标准核验（task_verify pass=true/false，并写明意见）。`,
            );
          }
        }
        if (shared.ok.length) note += `；附件 ${shared.ok.join("、")} 已自动分享给 ${shared.with.join("、") || "（无需分享）"}`;
        break;
      }
      case "verify": {
        const isVerifier = !!actor.post && actor.post === t.verifier_post;
        if (!isVerifier && !isManager(t, actor)) throw forbidden(`只有核验人（${t.verifier_post ?? "未定"}）或${managerHint(t)}可以核验任务 ${t.id}`);
        requireState(t, ["submitted"], "verify");
        t.lease_until = undefined;
        if (!req.pass && !req.comment.trim()) throw bad("核验不通过时必须在 comment 中写明问题和修改要求");
        addComment(t.id, who, `【核验${req.pass ? "通过" : "不通过"}】${req.comment}`);
        if (req.pass) {
          setState(t, "done", who, `核验通过：${clip(req.comment, 200)}`);
          notifyTask(t.assignee_post, t, `任务核验通过：${t.title}`, `任务 ${t.id} 已由 ${who} 核验通过，办结。`, false);
        } else {
          t.return_count += 1;
          if (t.return_count > LIMITS.maxReturns) {
            setState(t, "failed", who, `退回超过 ${LIMITS.maxReturns} 次，判定失败`);
            const up = edictDispatcher(t) ?? postOfAddress(t.creator) ?? env.headOf(t.dept);
            notifyTask(up, t, `任务多次退回判定失败：${t.title}`, `${taskBrief(t)}\n\n已退回 ${t.return_count} 次仍不合格，系统判定失败。最后意见：${req.comment}\n请决定是否另行分派或在复奏中如实说明。`);
            notifyTask(t.assignee_post, t, `任务失败：${t.title}`, `任务 ${t.id} 多次核验不通过，已判定失败。`, false);
          } else {
            setState(t, "returned", who, `核验不通过（第 ${t.return_count} 次退回）`);
            t.lease_until = now + SLA.lease * 1000;
            notifyTask(t.assignee_post, t, `任务被退回：${t.title}`, `任务 ${t.id} 核验不通过（第 ${t.return_count}/${LIMITS.maxReturns} 次退回）。\n意见：${req.comment}\n请按意见修改后重新提交（task_submit）。`);
          }
        }
        break;
      }
      case "block": {
        requireAssignee(t, actor, "block");
        requireState(t, ["assigned", "in_progress", "returned"], "block");
        t.block_reason = req.reason;
        t.lease_until = undefined;
        setState(t, "blocked", who, `受阻：${clip(req.reason, 200)}`);
        notifyTask(managerPost(t), t, `任务受阻：${t.title}`, `${taskBrief(t)}\n\n承办人 ${t.assignee_post} 报告受阻：${req.reason}\n请协调解决（必要时转派或取消）。`);
        break;
      }
      case "unblock": {
        if (!(actor.post && actor.post === t.assignee_post) && !isManager(t, actor)) throw forbidden(`只有承办人或${managerHint(t)}可以解除任务 ${t.id} 的受阻`);
        requireState(t, ["blocked"], "unblock");
        t.block_reason = undefined;
        setState(t, "in_progress", who, `解除受阻${req.note ? "：" + clip(req.note, 200) : ""}`);
        if (actor.post !== t.assignee_post) notifyTask(t.assignee_post, t, `任务已解除受阻：${t.title}`, `任务 ${t.id} 已解除受阻${req.note ? "：" + req.note : ""}，请继续办理。`);
        break;
      }
      case "comment": {
        addComment(t.id, who, req.content);
        const others = [t.assignee_post, t.verifier_post, postOfAddress(t.creator)].filter((p): p is string => !!p && p !== actor.post);
        // 批注即公文往来：以批注人名义投递并唤醒（等待「某人来信」的 wait_for 也能被批注唤醒）
        for (const p of new Set(others))
          env.notify(p, "task_notice", `任务批注：${t.title}`, `${who} 在任务 ${t.id} 上批注：\n${clip(req.content, 1500)}`, {
            trace_id: t.trace_id,
            wakes: true,
            from: actor.post ? `post:${actor.post}` : who,
            meta: { task_id: t.id, edict_id: t.edict_id },
          });
        break;
      }
      case "assign": {
        requireManager(t, actor, "assign");
        requireState(t, ["pending", "assigned", "returned"], "assign");
        checkAssigneeInDept(req.assignee_post, t.dept);
        if (req.assignee_post === t.assignee_post) throw invalidState(`任务 ${t.id} 已由 ${req.assignee_post} 承办，无需重复指派`);
        checkOpenLimit(req.assignee_post);
        const old = t.assignee_post;
        if (old && actor.post === old) t.delegated = true;
        t.assignee_post = req.assignee_post;
        t.lease_until = now + SLA.lease * 1000;
        setState(t, "assigned", who, `指派给 ${req.assignee_post}${req.note ? "：" + clip(req.note, 200) : ""}`);
        notifyTask(req.assignee_post, t, `新任务：${t.title}`, `${taskBrief(t)}${req.note ? `\n\n交办说明：${req.note}` : ""}\n\n请开始办理（task_start），完成后 task_submit。`);
        if (old && old !== actor.post) notifyTask(old, t, `任务已转交：${t.title}`, `任务 ${t.id} 已由 ${who} 转交 ${req.assignee_post}。`, false);
        break;
      }
      case "reassign": {
        requireManager(t, actor, "reassign");
        requireState(t, ["assigned", "in_progress", "blocked", "returned"], "reassign");
        checkAssigneeInDept(req.assignee_post, t.dept);
        if (req.assignee_post === t.assignee_post) throw invalidState(`任务 ${t.id} 已由 ${req.assignee_post} 承办，无需转派`);
        if (t.reassign_count >= LIMITS.maxReassign) throw new ReassignLimitError(t);
        checkOpenLimit(req.assignee_post);
        const old = t.assignee_post;
        t.assignee_post = req.assignee_post;
        t.reassign_count += 1;
        t.lease_until = now + SLA.lease * 1000;
        t.block_reason = undefined;
        setState(t, "assigned", who, `转派 ${old ?? "无"} → ${req.assignee_post}：${clip(req.reason, 200)}`);
        notifyTask(req.assignee_post, t, `转派任务：${t.title}`, `${taskBrief(t)}\n\n转派原因：${req.reason}\n请开始办理（task_start）。`);
        notifyTask(old, t, `任务已转派：${t.title}`, `任务 ${t.id} 已转派给 ${req.assignee_post}：${req.reason}`, false);
        break;
      }
      case "cancel": {
        requireManager(t, actor, "cancel");
        if (isTaskTerminal(t.state)) throw invalidState(`任务 ${t.id} 已终结（${t.state}），无需取消`);
        t.lease_until = undefined;
        setState(t, "cancelled", who, `取消：${clip(req.reason, 200)}`);
        // 子孙任务由 afterTerminal 级联取消
        notifyTask(t.assignee_post, t, `任务已取消：${t.title}`, `任务 ${t.id} 已由 ${who} 取消：${req.reason}。请停止办理。`);
        break;
      }
      case "fail": {
        if (!(actor.post && actor.post === t.assignee_post) && !isManager(t, actor)) throw forbidden(`只有承办人或${managerHint(t)}可以把任务 ${t.id} 标记为失败`);
        if (isTaskTerminal(t.state)) throw invalidState(`任务 ${t.id} 已终结（${t.state}）`);
        t.lease_until = undefined;
        t.result = t.result ?? `失败：${req.reason}`;
        setState(t, "failed", who, `失败：${clip(req.reason, 200)}`);
        notifyTask(managerPost(t), t, `任务失败：${t.title}`, `${taskBrief(t)}\n\n${who} 报告失败：${req.reason}`);
        break;
      }
      case "extend": {
        requireManager(t, actor, "extend");
        if (isTaskTerminal(t.state)) throw invalidState(`任务 ${t.id} 已终结（${t.state}），无需延期`);
        t.deadline = Math.max(t.deadline ?? now, now) + req.minutes * 60_000;
        addComment(t.id, who, `【延期 ${req.minutes} 分钟】${req.reason}`);
        ctx.events.emit({ type: "task.extended", actor: who, trace_id: t.trace_id, subject_type: "task", subject_id: t.id, summary: `延期 ${req.minutes} 分钟：${clip(req.reason, 100)}`, data: { deadline: t.deadline } });
        notifyTask(t.assignee_post, t, `任务延期：${t.title}`, `任务 ${t.id} 期限延长 ${req.minutes} 分钟，新期限 ${new Date(t.deadline).toISOString()}。`, false);
        break;
      }
      default: {
        const a = (req as { action?: unknown }).action;
        throw bad(`未知任务动作 ${JSON.stringify(a)}`);
      }
    }
    store.updateTask(t, now);
    if (!terminalBefore && isTaskTerminal(t.state)) afterTerminal(t, who);
    const d = detail(t.id);
    if (note) d.note = note;
    if (warnings.length) d.warnings = warnings;
    return d;
  }

  return flow;
}

export type TaskFlow = ReturnType<typeof createTaskFlow>;
