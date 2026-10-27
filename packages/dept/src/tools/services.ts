// 通用·服务工具（部门/官员对外能力的调用与应答）
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ServiceDef, ServiceRequest } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { ToolError, defineTool, fmtTime, focusRequest, ok, rememberTrace, resolveAddress, resolveDept, selfAddr, snip, writeMeta } from "./_util.ts";

function reqRow(r: ServiceRequest) {
  return {
    request_id: r.id,
    service: r.service,
    caller: r.caller,
    target: r.target,
    routed_to: r.routed_to,
    state: r.state,
    input: typeof r.input === "string" ? snip(r.input, 1500) : r.input,
    output: r.output,
    trace_id: r.trace_id,
    created: fmtTime(r.created_at),
    sla: fmtTime(r.sla_at),
    done: fmtTime(r.done_at),
  };
}

/** 某地址声明的服务 */
function servicesOf(ctx: ToolContext, target: string): ServiceDef[] {
  const reg = ctx.registry();
  if (target.startsWith("dept:")) return reg.depts.find((d) => d.id === target.slice(5))?.services ?? [];
  if (target.startsWith("post:")) return reg.posts.find((p) => p.post_id === target.slice(5))?.services ?? [];
  return [];
}

export function servicesTools(ctx: ToolContext): AgentTool<any>[] {
  const self = selfAddr(ctx);
  return [
    defineTool({
      name: "list_services",
      label: "服务目录",
      description:
        "列出可调用的服务（部门/个人）：目标地址、服务名、说明、输入格式、SLA。",
      parameters: Type.Object({
        dept: Type.Optional(Type.String({ description: "只看某部门（ID 或中文名）；不填列全部" })),
      }),
      async run(p) {
        const reg = ctx.registry();
        const dept = p.dept ? resolveDept(ctx, p.dept) : undefined;
        const rows: Record<string, unknown>[] = [];
        for (const d of reg.depts) {
          if (dept && d.id !== dept.id) continue;
          for (const s of d.services) rows.push({ target: `dept:${d.id}`, owner: d.name, service: s.name, description: s.description, input_schema: s.input_schema, sla_seconds: s.sla_seconds });
          for (const post of reg.posts.filter((x) => x.dept === d.id))
            for (const s of post.services ?? [])
              rows.push({ target: `post:${post.post_id}`, owner: `${d.name}·${post.title}`, service: s.name, description: s.description, input_schema: s.input_schema, sla_seconds: s.sla_seconds });
        }
        return ok(`共 ${rows.length} 项服务`, rows);
      },
    }),

    defineTool({
      name: "call_service",
      label: "调用服务",
      description:
        "异步调用部门/官员的服务（如礼部 polish/translate、刑部 verify/test、兵部 run/fetch、户部 budget_query），返回 request_id；服务名与输入格式见 list_services。" +
        "默认不等待，结果到达会唤醒你（也可 get_service_result 查）；wait=true 则【结束本轮】等结果（timeout_seconds 默认按 SLA），须是本轮最后一个工具调用。",
      parameters: Type.Object({
        target: Type.String({ description: "dept:<部门ID> 或 post:<职位ID>（或中文名/职衔）" }),
        service: Type.String({ description: "服务名，如 polish、verify、run" }),
        input: Type.Unknown({ description: "字符串，或符合 input_schema 的 JSON 对象" }),
        wait: Type.Optional(Type.Boolean({ description: "结束本轮等结果，默认 false" })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 86400, description: "wait=true 时最多等多少秒" })),
      }),
      async run(p, call) {
        const target = resolveAddress(ctx, p.target, ["post", "dept"]);
        const declared = servicesOf(ctx, target);
        const def = declared.find((s) => s.name === p.service);
        if (!def) {
          throw new ToolError(
            `${target} 没有名为「${p.service}」的服务`,
            declared.length ? `可用服务：${declared.map((s) => s.name).join("、")}` : "该目标未声明任何服务，请用 list_services 查找，或改用 send_message。",
          );
        }
        const req = await ctx.invokeService({ ...writeMeta(ctx, call.toolCallId), caller: self, target, service: p.service, input: p.input ?? "" });
        rememberTrace(ctx, `req:${req.id}`, req.trace_id);
        ctx.log("service_call", { request_id: req.id, target, service: p.service, wait: !!p.wait });
        if (p.wait) {
          const timeout = p.timeout_seconds ?? Math.min(86400, Math.max(60, def.sla_seconds));
          // 结果信 kind=service_result、reply_to=请求信；无请求信 ID 时退回按 trace 等
          ctx.waitFor(req.request_message_id ? { kinds: ["service_result"], reply_to: req.request_message_id } : { kinds: ["service_result"], trace_id: req.trace_id }, timeout);
          return ok(`已调用 ${target} 的 ${p.service}（${req.id}），本轮结束，等待结果（最长 ${timeout} 秒）`, reqRow(req), { terminate: true });
        }
        return ok(`已调用 ${target} 的 ${p.service}（${req.id}），状态 ${req.state}；结果到达时会通知你`, reqRow(req), {
          hint: `查询结果：get_service_result {request_id: "${req.id}"}`,
        });
      },
    }),

    defineTool({
      name: "get_service_result",
      label: "查询服务结果",
      description: "查询服务请求的状态（pending/done/failed/expired）、受理人、输入与输出。",
      parameters: Type.Object({ request_id: Type.String({ description: "服务请求 ID（call_service 返回的 request_id）" }) }),
      async run(p) {
        const r = await ctx.hub.serviceRequest(p.request_id);
        rememberTrace(ctx, `req:${r.id}`, r.trace_id);
        return ok(`服务请求 ${r.id}（${r.service}）状态：${r.state}`, reqRow(r));
      },
    }),

    defineTool({
      name: "service_respond",
      label: "答复服务请求",
      description:
        "答复发给你（或本部门）的服务请求，结果回传并唤醒请求者；每请求只答一次。output 须是完整可用的结果（大产物先 asset_write 再给 asset_id）；ok=false 时写明原因与建议。",
      parameters: Type.Object({
        request_id: Type.String({ description: "服务请求 ID" }),
        ok: Type.Boolean({ description: "是否成功完成" }),
        output: Type.String({ description: "结果内容或失败原因" }),
      }),
      async run(p, call) {
        await focusRequest(ctx, p.request_id);
        const r = await ctx.hub.serviceResult(p.request_id, { ...writeMeta(ctx, call.toolCallId), post: ctx.post.post_id, ok: p.ok, output: p.output });
        return ok(`已答复服务请求 ${r.id}（${r.service} → ${r.caller}），状态 ${r.state}`, { request_id: r.id, state: r.state });
      },
    }),
  ];
}
