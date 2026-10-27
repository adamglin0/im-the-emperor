// B 组流程服务入口：议事、诏令、任务、服务调用、看门狗，以及皇帝批复处理器的注册。
// 实现分布在 workflow-*.ts；本文件只做装配与批复路由。
import type { Address, Deliberation, Notification, ServiceRequest, Task } from "@court/shared";
import type { HubCtx, WorkflowService } from "../ctx.ts";
import { createFlowEnv } from "./workflow-env.ts";
import { createCouncilFlow } from "./workflow-council.ts";
import { createEdictFlow, type IssueEdictInput } from "./workflow-edicts.ts";
import { createServiceFlow } from "./workflow-services.ts";
import { createTaskFlow } from "./workflow-tasks.ts";
import { createWatchdog } from "./workflow-watchdog.ts";
import type { EdictRow } from "./workflow-store.ts";

type Payload = { type?: string; [k: string]: unknown };

export function createWorkflow(ctx: HubCtx) {
  const env = createFlowEnv(ctx);
  const tasks = createTaskFlow(env);
  const edicts = createEdictFlow(env, tasks);
  const council = createCouncilFlow(env, edicts);
  const services = createServiceFlow(env);
  const watchdog = createWatchdog(env, { council, edicts, tasks, services });

  const payloadOf = (n: Notification): Payload => env.store.getPayloadOrNull<Payload>(n.id) ?? {};
  const relatedId = (n: Notification, p: Payload, key: string): string => String(p[key] ?? n.related?.id ?? "");

  /** SLA 上报的皇帝批复：严旨督办 / 撤回（取消）/ 知道了 */
  function resolveSla(n: Notification, p: Payload, option: string, comment: string): void {
    const type = String(p.subject_type ?? n.related?.type);
    const id = String(p.subject_id ?? n.related?.id);
    if (option === "ignore") return;
    if (type === "edict") {
      if (option === "withdraw") {
        edicts.applyAction(id, "withdraw", comment || "超期，陛下撤回", "emperor", n.id);
        return;
      }
      const e = env.store.getEdict(id);
      const owner = watchdog.edictOwner(e);
      for (const p2 of new Set([owner, env.headOf(e.state === "reviewing" ? "menxia" : e.state === "drafting" ? "zhongshu" : "shangshu", owner ? [owner] : undefined)])) {
        env.notify(p2, "edict_notice", `【严旨督办】${e.title}`, `陛下严旨督办诏令 ${e.id}「${e.title}」，须即刻办理。${comment ? "\n朱批：" + comment : ""}\n\n${edicts.stageBrief(e)}`, {
          trace_id: e.id,
          priority: "urgent",
          from: "emperor",
          meta: { edict_id: e.id },
        });
      }
      return;
    }
    if (type === "task") {
      if (option === "cancel") {
        tasks.taskAction(id, { action: "cancel", post: "", reason: comment || "超期，陛下取消" }, { addr: "emperor" });
        return;
      }
      const t = env.store.getTask(id);
      const owner = watchdog.taskOwner(t);
      for (const p2 of new Set([owner, env.headOf(t.dept, owner ? [owner] : undefined)])) {
        env.notify(p2, "task_notice", `【严旨督办】${t.title}`, `陛下严旨督办任务 ${t.id}「${t.title}」，须即刻办理。${comment ? "\n朱批：" + comment : ""}\n\n${tasks.taskBrief(t)}`, {
          trace_id: t.trace_id,
          priority: "urgent",
          from: "emperor",
          meta: { task_id: t.id },
        });
      }
    }
  }

  function registerHandlers(): void {
    env.onResolve("council_conclusion", (n, option, comment) => {
      council.resolveConclusion(relatedId(n, payloadOf(n), "deliberation_id"), option, comment ?? "");
    });

    env.onResolve("edict_proposal", (n, option, comment) => {
      const p = payloadOf(n);
      const deliberationId = typeof p.deliberation_id === "string" ? p.deliberation_id : undefined;
      if (option === "approve") {
        const intent = comment?.trim() ? `${String(p.intent ?? "")}\n【朕批】${comment.trim()}` : String(p.intent ?? "");
        edicts.issueEdict({ title: String(p.title ?? n.title), intent, deliberation_id: deliberationId, actor: "emperor" });
      } else if (option === "revise" && deliberationId) {
        council.emperorSpeaks(comment?.trim() || "所拟旨意发回再议，请诸卿再议", deliberationId);
      }
      // reject：不准；批复由待办服务回写给奏请人
    });

    env.onResolve("remonstrance", (n, option, comment) => {
      const id = relatedId(n, payloadOf(n), "edict_id");
      if (!["insist", "revise", "withdraw"].includes(option)) throw new Error(`未知选项 ${option}`);
      edicts.applyAction(id, option as "insist" | "revise" | "withdraw", comment ?? "", "emperor", n.id);
    });

    env.onResolve("escalation", (n, option, comment) => {
      const p = payloadOf(n);
      if (p.type === "sla") return resolveSla(n, p, option, comment ?? "");
      if (n.related?.type === "edict" || p.type === "reject_overflow") {
        const id = relatedId(n, p, "edict_id");
        if (!["force_approve", "withdraw", "revise"].includes(option)) throw new Error(`未知选项 ${option}`);
        edicts.applyAction(id, option as "force_approve" | "withdraw" | "revise", comment ?? "", "emperor", n.id);
      }
    });

    env.onResolve("report", (n, option, comment) => {
      const p = payloadOf(n);
      const id = relatedId(n, p, "edict_id");
      if (p.type === "final_sign") {
        edicts.applyAction(id, option === "sign" ? "sign" : "withdraw", comment ?? "", "emperor", n.id);
        return;
      }
      if (n.related?.type !== "edict" && p.type !== "report") return;
      edicts.applyAction(id, option === "accept" ? "accept_report" : "reopen", comment ?? "", "emperor", n.id);
    });
  }
  registerHandlers();

  const service = {
    // ── 契约（WorkflowService） ──
    emperorSpeaks(content: string, deliberationId?: string): Deliberation {
      return council.emperorSpeaks(content, deliberationId);
    },
    issueEdict(input: IssueEdictInput): EdictRow {
      return edicts.issueEdict(input);
    },
    getEdict(id: string): EdictRow | undefined {
      return env.store.getEdictOrNull(id);
    },
    getTask(id: string): Task | undefined {
      return env.store.getTaskOrNull(id);
    },
    openTaskCount(postId: string): number {
      return env.store.countOpenTasks(postId);
    },
    getServiceRequest(id: string): ServiceRequest | undefined {
      return env.store.getServiceRequestOrNull(id);
    },
    watchdogTick(now: number): void {
      watchdog.tick(now);
    },

    // ── 路由所需的扩展 ──
    env,
    council,
    edicts,
    tasks,
    services,
    watchdog,
    /** 皇帝对诏令的动作 */
    emperorEdictAction(id: string, action: Parameters<typeof edicts.applyAction>[1], comment: string, actor: Address = "emperor") {
      return edicts.applyAction(id, action, comment, actor);
    },
  } satisfies WorkflowService & Record<string, unknown>;
  return service;
}

export type Workflow = ReturnType<typeof createWorkflow>;

/** 路由取完整流程服务（HubCtx 上的类型只含契约部分） */
export function workflowOf(ctx: HubCtx): Workflow {
  return ctx.workflow as Workflow;
}
