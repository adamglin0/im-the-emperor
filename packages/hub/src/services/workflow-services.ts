// 服务调用：caller → target(post:x | dept:y) 的异步请求；结果回传请求者（唤醒）。
import { SLA, newId, parseAddress, type Address, type PostDef, type ServiceDef, type ServiceRequest } from "@court/shared";
import { HubError, bad, forbidden, invalidState } from "../ctx.ts";
import { clip, postOfAddress } from "./flow-util.ts";
import type { FlowEnv } from "./workflow-env.ts";

export const serviceSpanId = (id: string) => `sp_${id}`;

export interface CallServiceInput {
  caller: Address;
  target: Address;
  service: string;
  input: unknown;
  trace_id?: string;
  parent_span_id?: string;
}

export function createServiceFlow(env: FlowEnv) {
  const { ctx, store } = env;
  const reg = () => ctx.registry;

  /** 职位可提供的服务：职位自有 + 本部门中其路由角色能承办的部门服务 */
  function servicesOfPost(p: PostDef): ServiceDef[] {
    const own = p.services ?? [];
    const dept = reg().dept(p.dept);
    const deptSvcs = (dept?.services ?? []).filter((s) => {
      const roles = s.route_roles ?? dept?.routing[s.name] ?? [];
      return roles.some((r) => p.roles.includes(r));
    });
    const seen = new Set<string>();
    return [...own, ...deptSvcs].filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
  }

  function resolveTarget(target: Address, service: string, exclude: string[]): { post: string; def: ServiceDef } {
    let addr: ReturnType<typeof parseAddress>;
    try {
      addr = parseAddress(target);
    } catch {
      throw bad(`target 地址非法：${target}；应为 post:<职位id> 或 dept:<部门id>`);
    }
    if (addr.type === "post") {
      const p = reg().post(addr.id);
      if (!p) throw bad(`职位 ${addr.id} 不存在，请用 list_officials 查询`);
      const svcs = servicesOfPost(p);
      const def = svcs.find((s) => s.name === service);
      if (!def) {
        throw new HubError(404, "not_found", `${addr.id} 不提供服务「${service}」。该职位可提供：${svcs.map((s) => s.name).join(", ") || "（无）"}；也可用 list_services 查看各部门服务`);
      }
      return { post: addr.id, def };
    }
    if (addr.type === "dept") {
      const d = reg().dept(addr.id);
      if (!d) throw bad(`部门 ${addr.id} 不存在；可选：${reg().depts().map((x) => x.id).join(", ")}`);
      const def = d.services.find((s) => s.name === service);
      if (!def) throw new HubError(404, "not_found", `${d.name}（${d.id}）不提供服务「${service}」。可用服务：${d.services.map((s) => s.name).join(", ") || "（无）"}`);
      const roles = def.route_roles ?? d.routing[service] ?? d.routing["*"] ?? ["head"];
      const post = reg().pickPost(d.id, roles, { exclude }) ?? reg().routeDept(d.id, service, { exclude });
      if (!post) throw new HubError(503, "unavailable", `${d.name} 当前无人可承办服务「${service}」，请稍后再试或改用其他部门`);
      return { post, def };
    }
    throw bad(`服务只能调用职位或部门：target 应为 post:<职位id> 或 dept:<部门id>，收到 ${target}`);
  }

  function sendToCaller(r: ServiceRequest, subject: string, body: string, ok: boolean): void {
    const meta = { request_id: r.id, ok, service: r.service };
    const callerPost = postOfAddress(r.caller);
    if (callerPost) {
      ctx.messages.send({
        from: r.routed_to ? `post:${r.routed_to}` : "system:workflow",
        to: r.caller,
        kind: "service_result",
        subject,
        body,
        reply_to: r.request_message_id,
        trace_id: r.trace_id,
        meta,
      });
    } else if (r.caller === "emperor") {
      ctx.messages.send({ from: r.routed_to ? `post:${r.routed_to}` : "system:workflow", to: "emperor", kind: "service_result", subject, body, reply_to: r.request_message_id, trace_id: r.trace_id, meta });
    }
  }

  const flow = {
    servicesOfPost,

    getServiceRequestOrNull(id: string): ServiceRequest | undefined {
      return store.getServiceRequestOrNull(id);
    },

    call(input: CallServiceInput): ServiceRequest {
      if (!input.service?.trim()) throw bad("缺少服务名 service");
      return ctx.db.tx(() => {
        const callerPost = postOfAddress(input.caller);
        const { post, def } = resolveTarget(input.target, input.service.trim(), callerPost ? [callerPost] : []);
        if (callerPost && post === callerPost) throw bad(`不能调用自己提供的服务（${post}）`);
        const now = env.now();
        const r: ServiceRequest = {
          id: newId("svc"),
          trace_id: input.trace_id ?? newId("tr"),
          caller: input.caller,
          target: input.target,
          routed_to: post,
          service: def.name,
          input: input.input ?? null,
          state: "pending",
          created_at: now,
          sla_at: now + (def.sla_seconds || SLA.service_default) * 1000,
        };
        const inputText = typeof r.input === "string" ? r.input : JSON.stringify(r.input, null, 2);
        const res = ctx.messages.send({
          from: input.caller,
          to: `post:${post}`,
          kind: "service_request",
          subject: `服务请求：${def.name}`,
          body: `${input.caller} 请求服务「${def.name}」（${def.description}）。\n请求编号：${r.id}\n时限：${Math.round((r.sla_at - now) / 60_000)} 分钟\n\n输入：\n${clip(inputText ?? "", 6000)}\n\n办完后用 service_respond（request_id=${r.id}）回报结果。`,
          trace_id: r.trace_id,
          parent_span_id: input.parent_span_id,
          meta: { request_id: r.id, service: def.name },
        });
        r.request_message_id = res.message.id;
        store.createServiceRequest(r);
        ctx.events.span({
          span_id: serviceSpanId(r.id),
          trace_id: r.trace_id,
          parent_span_id: input.parent_span_id,
          kind: "service",
          name: `服务 ${def.name} → ${post}`,
          actor: input.caller,
          status: "running",
          started_at: now,
          attrs: { request_id: r.id, service: def.name, target: input.target, routed_to: post },
        });
        if (res.message.span_id) ctx.events.link(serviceSpanId(r.id), res.message.span_id, "service", r.trace_id, def.name);
        env.emit("service.requested", input.caller, `请求服务 ${def.name} → ${post}`, {
          trace_id: r.trace_id,
          span_id: serviceSpanId(r.id),
          subject_type: "service",
          subject_id: r.id,
          data: { from: input.caller, to: `post:${post}`, target: input.target, service: def.name, request_id: r.id },
        });
        return r;
      });
    },

    respond(id: string, post: string | undefined, ok: boolean, output: string): ServiceRequest {
      return ctx.db.tx(() => {
        const r = store.getServiceRequest(id);
        if (post && r.routed_to !== post) throw forbidden(`服务请求 ${id} 由 ${r.routed_to} 承办，你（${post}）不能回报结果`);
        if (r.state !== "pending") throw invalidState(`服务请求 ${id} 已是 ${r.state} 状态，不能再回报结果`);
        const now = env.now();
        r.state = ok ? "done" : "failed";
        r.output = output;
        r.done_at = now;
        store.updateServiceRequest(r);
        ctx.events.endSpan(serviceSpanId(id), ok ? "ok" : "error", { output: clip(output, 500) });
        env.emit(ok ? "service.done" : "service.failed", post ? `post:${post}` : "emperor", `服务 ${r.service} ${ok ? "办结" : "失败"}`, {
          trace_id: r.trace_id,
          span_id: serviceSpanId(id),
          subject_type: "service",
          subject_id: id,
          data: { from: `post:${r.routed_to}`, to: r.caller, service: r.service, request_id: id, ok },
        });
        sendToCaller(r, `服务${ok ? "结果" : "失败"}：${r.service}`, `服务请求 ${r.id}（${r.service}）${ok ? "已办结" : "失败"}。\n\n${output}`, ok);
        return r;
      });
    },

    /** 看门狗：超时 → expired 并知会请求者 */
    expire(id: string, now: number): boolean {
      return ctx.db.tx(() => {
        const r = store.getServiceRequest(id);
        if (r.state !== "pending" || r.sla_at > now) return false;
        r.state = "expired";
        r.done_at = now;
        store.updateServiceRequest(r);
        ctx.events.endSpan(serviceSpanId(id), "error", { expired: true });
        env.emit("service.expired", "system:watchdog", `服务 ${r.service} 超时未办（${r.routed_to}）`, { trace_id: r.trace_id, span_id: serviceSpanId(id), subject_type: "service", subject_id: id, data: { from: `post:${r.routed_to}`, to: r.caller, service: r.service, request_id: id, ok: false } });
        sendToCaller(r, `服务超时：${r.service}`, `服务请求 ${r.id}（${r.service}，承办 ${r.routed_to}）超过时限未办结，已作废。可改派他人重新调用，或向其部门长官催办。`, false);
        env.notify(r.routed_to, "fyi", `服务请求已超时作废：${r.service}`, `你承办的服务请求 ${r.id} 已超时作废，无需再回报。`, { trace_id: r.trace_id, wakes: false });
        return true;
      });
    },
  };
  return flow;
}

export type ServiceFlow = ReturnType<typeof createServiceFlow>;
