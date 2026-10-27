// 通用·名册工具
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { OfficialStatus } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { defineTool, fmtTime, ok, officialOfPost, postsByRole, resolveDept, resolvePost, snip } from "./_util.ts";

function statusRow(s: OfficialStatus) {
  return {
    post: s.post_id,
    state: s.state,
    status_text: s.status_text,
    trace: s.current_trace_id,
    next_wake: fmtTime(s.next_wake_at),
    waiting_for: s.wait_filter,
    last_progress: fmtTime(s.last_progress_at),
    turns_last_hour: s.turns_last_hour,
    tokens_today: s.tokens_today,
  };
}

async function statusesOrEmpty(ctx: ToolContext): Promise<OfficialStatus[]> {
  try {
    return await ctx.hub.statuses();
  } catch {
    return [];
  }
}

export function rosterTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    defineTool({
      name: "list_departments",
      label: "部门一览",
      description: "列出全部部门：ID、名称、职掌、长官、员额、服务名。判断某事该找哪个部门时用。",
      parameters: Type.Object({}),
      async run() {
        const reg = ctx.registry();
        const rows = reg.depts.map((d) => ({
          id: d.id,
          name: d.name,
          brief: d.brief,
          head: postsByRole(reg, d.id, "head").map((p) => p.post_id),
          posts: reg.posts.filter((p) => p.dept === d.id).length,
          services: d.services.map((s) => s.name),
        }));
        return ok(`共 ${rows.length} 个部门`, rows, { hint: "部门地址写作 dept:<id>；部门服务用 call_service 调用。" });
      },
    }),

    defineTool({
      name: "list_officials",
      label: "官员名册",
      description: "列出官员：职位 ID、职衔、品阶、路由角色、在任者姓名与 official_id、运行状态；按部门过滤时另列模型。",
      parameters: Type.Object({
        dept: Type.Optional(Type.String({ description: "部门 ID 或中文名；不填列全部" })),
      }),
      async run(p) {
        const reg = ctx.registry();
        const dept = p.dept ? resolveDept(ctx, p.dept) : undefined;
        const statuses = await statusesOrEmpty(ctx);
        // 每职位一行（全朝 40+ 职位用 JSON 会超出输出上限而被截掉中段）
        const posts = reg.posts.filter((x) => !dept || x.dept === dept.id);
        const lines: string[] = [];
        let lastDept = "";
        for (const x of posts) {
          if (x.dept !== lastDept) {
            lastDept = x.dept;
            lines.push(`【${reg.depts.find((d) => d.id === x.dept)?.name ?? x.dept} dept:${x.dept}】`);
          }
          const o = officialOfPost(reg, x.post_id);
          const st = statuses.find((s) => s.post_id === x.post_id);
          const who = o ? `${o.name} ${o.official_id}${o.status !== "active" ? `（${o.status}）` : ""}${dept ? ` ${o.model}` : ""}` : "缺员";
          lines.push(`post:${x.post_id} ${x.title}${x.benguan ? `（${x.benguan}）` : ""} ${x.rank} [${x.roles.join(",")}] ${who}${st ? ` ·${st.state}` : ""}`);
        }
        return ok(`${dept ? dept.name : "全朝"}共 ${posts.length} 个职位`, lines.join("\n"));
      },
    }),

    defineTool({
      name: "get_official_profile",
      label: "官员履历",
      description: "查看职位/官员档案：职衔、品阶、职掌、路由角色、工具组、服务、在任者（姓名、模型、思考强度、任职起始）。",
      parameters: Type.Object({
        post: Type.String({ description: "职位 ID、post:地址、职衔或姓名" }),
      }),
      async run(p) {
        const reg = ctx.registry();
        const post = resolvePost(ctx, p.post);
        const o = officialOfPost(reg, post.post_id);
        const ap = reg.appointments.find((a) => a.post_id === post.post_id);
        const dept = reg.depts.find((d) => d.id === post.dept);
        return ok(`${dept?.name ?? post.dept}·${post.title}（post:${post.post_id}）`, {
          post: post.post_id,
          dept: post.dept,
          title: post.title,
          rank: post.rank,
          benguan: post.benguan,
          duties: snip(post.duties, 800),
          roles: post.roles,
          tool_groups: post.tool_groups,
          services: (post.services ?? []).map((s) => ({ name: s.name, description: s.description })),
          activity: post.activity,
          approval_sensitive: post.approval_sensitive || undefined,
          official: o
            ? {
                official_id: o.official_id,
                name: o.name,
                model: o.model,
                thinking: o.thinking,
                status: o.status,
                config_version: o.config_version,
                since: fmtTime(ap?.since),
              }
            : "缺员",
        });
      },
    }),

    defineTool({
      name: "get_official_status",
      label: "官员动态",
      description: "查看官员此刻状态：空闲/思考/睡眠/等待（等谁、何时醒）、状态说明、当前 trace、近 1 小时轮次、今日 token。判断对方是否卡住时用。",
      parameters: Type.Object({
        post: Type.String({ description: "职位 ID、post:地址、职衔或姓名" }),
      }),
      async run(p) {
        const post = resolvePost(ctx, p.post);
        let st: OfficialStatus | undefined;
        let source = "部门实时";
        try {
          st = await ctx.deptClient(post.dept).officialStatus(post.post_id);
        } catch {
          source = "hub 心跳（部门 API 不可达）";
          st = (await ctx.hub.statuses()).find((s) => s.post_id === post.post_id);
        }
        if (!st) return ok(`暂无 ${post.post_id} 的状态记录（可能离线或缺员）`);
        return ok(`${post.title}（${post.post_id}）状态：${st.state}（来源：${source}）`, statusRow(st));
      },
    }),

    defineTool({
      name: "get_department_status",
      label: "部门动态",
      description: "查看某部门全体官员的运行状态与未结任务数。",
      parameters: Type.Object({
        dept: Type.String({ description: "部门 ID 或中文名" }),
      }),
      async run(p) {
        const d = resolveDept(ctx, p.dept);
        let officials: OfficialStatus[];
        let source = "部门实时";
        try {
          officials = (await ctx.deptClient(d.id).info()).officials;
        } catch {
          source = "hub 心跳（部门 API 不可达）";
          officials = (await ctx.hub.statuses()).filter((s) => s.dept === d.id);
        }
        let openTasks: number | undefined;
        try {
          openTasks = (await ctx.hub.tasks({ dept: d.id, state: "open", limit: 200 })).length;
        } catch {
          openTasks = undefined;
        }
        return ok(`${d.name}：${officials.length} 人在册状态，未结任务 ${openTasks ?? "未知"}（来源：${source}）`, {
          dept: d.id,
          open_tasks: openTasks,
          officials: officials.map(statusRow),
        });
      },
    }),
  ];
}
