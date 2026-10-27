// 吏部·官员配置工具
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ALL_TOOL_GROUPS, type ConfigProposeReq, type ConfigProposeRes } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { READ_CHUNK } from "./assets.ts";
import { ToolError, defineTool, fmtTime, ok, resolvePost, selfAddr, sliceByBytes, snip, writeMeta } from "./_util.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function proposeResult(r: ConfigProposeRes, what: string) {
  return r.status === "applied"
    ? ok(`${what}已生效（下一轮起）`, { status: r.status, config_version: r.official?.config_version })
    : ok(`${what}涉及敏感事项，已提交皇帝审批（approval_id ${r.approval_id}）`, { status: r.status, approval_id: r.approval_id }, { hint: "审批结果会通知你；无需重复提交。" });
}

export function configTools(ctx: ToolContext): AgentTool<any>[] {
  const self = selfAddr(ctx);
  const target = (raw: string) => {
    const p = resolvePost(ctx, raw);
    return p.post_id;
  };
  return [
    defineTool({
      name: "config_get",
      label: "查看配置",
      description: "查看某官员的当前配置：模型、思考强度、个人提示词附加段、职位默认工具组、额外授予/禁用的工具组、有效工具组、配置版本。",
      parameters: Type.Object({ post: Type.String({ description: "职位 ID（或职衔/姓名）" }) }),
      async run(p) {
        const c = await ctx.hub.officialConfig(target(p.post));
        return ok(`${c.post.title}（${c.post.post_id}）${c.official.name} 的配置（v${c.official.config_version}）`, {
          post: c.post.post_id,
          official_id: c.official.official_id,
          name: c.official.name,
          model: c.official.model,
          thinking: c.official.thinking,
          status: c.official.status,
          config_version: c.official.config_version,
          post_tool_groups: c.post.tool_groups,
          extra_tool_groups: c.official.extra_tool_groups,
          disabled_tool_groups: c.official.disabled_tool_groups,
          effective_tool_groups: c.effective_tool_groups,
          approval_sensitive: c.post.approval_sensitive || undefined,
          prompt_overrides: snip(c.official.prompt_overrides, 1500),
          system_prompt_chars: c.system_prompt.length,
        });
      },
    }),

    defineTool({
      name: "config_preview_prompt",
      label: "预览提示词",
      description: `预览某官员完整的系统提示词（通则→部门→职位→个人附加→工具清单）。较长时分段返回（每段约 ${READ_CHUNK} 字节），用 next_offset 继续读。`,
      parameters: Type.Object({
        post: Type.String({ description: "职位 ID（或职衔/姓名）" }),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几个字符开始，默认 0" })),
      }),
      async run(p) {
        const c = await ctx.hub.officialConfig(target(p.post));
        const part = sliceByBytes(c.system_prompt, p.offset ?? 0, READ_CHUNK);
        return ok(`${c.post.post_id} 系统提示词 字符 ${p.offset ?? 0}–${part.next ?? part.total}/${part.total}\n----\n${part.text}\n----`, undefined, part.next !== undefined ? { hint: `继续：config_preview_prompt {post: "${c.post.post_id}", offset: ${part.next}}` } : undefined);
      },
    }),

    defineTool({
      name: "config_propose",
      label: "调整配置",
      description:
        "调整某官员的配置：个人提示词附加段、思考强度、额外授予/禁用工具组。下一轮生效；若出现错误率/轮次飙升会自动回滚。" +
        "规则：不得改自己的配置；授予职位默认之外的工具组、或改动御史台/门下/政事堂/吏部官员（敏感职位）须皇帝批准（返回 pending_approval）。" +
        "只填需要改的字段；工具组列表为整体替换。须写明理由。",
      parameters: Type.Object({
        post: Type.String({ description: "目标职位 ID（或职衔/姓名）" }),
        prompt_overrides: Type.Optional(Type.String({ description: "新的个人提示词附加段（整体替换；空串表示清空）" })),
        thinking: Type.Optional(StringEnum(THINKING, { description: "思考强度" })),
        extra_tool_groups: Type.Optional(Type.Array(StringEnum(ALL_TOOL_GROUPS, { description: "工具组" }), { description: "额外授予的工具组（整体替换）" })),
        disabled_tool_groups: Type.Optional(Type.Array(StringEnum(ALL_TOOL_GROUPS, { description: "工具组" }), { description: "禁用的工具组（整体替换；common 不可禁用）" })),
        reason: Type.String({ description: "调整理由（依据考课/稽查/任务表现）" }),
      }),
      async run(p, call) {
        const post = target(p.post);
        if (post === ctx.post.post_id) throw new ToolError("官员不得修改自己的配置", "如确有需要，请 call_service 吏部 request_config_change 由同僚办理。");
        const changes: ConfigProposeReq["changes"] = {};
        if (p.prompt_overrides !== undefined) changes.prompt_overrides = p.prompt_overrides;
        if (p.thinking !== undefined) changes.thinking = p.thinking;
        if (p.extra_tool_groups !== undefined) changes.extra_tool_groups = [...p.extra_tool_groups];
        if (p.disabled_tool_groups !== undefined) changes.disabled_tool_groups = p.disabled_tool_groups.filter((g) => g !== "common");
        if (!Object.keys(changes).length) throw new ToolError("没有任何要修改的字段");
        const r = await ctx.hub.proposeConfig({ ...writeMeta(ctx, call.toolCallId), actor: self, target_post: post, changes, reason: p.reason });
        return proposeResult(r, `${post} 的配置调整`);
      },
    }),

    defineTool({
      name: "config_history",
      label: "配置沿革",
      description: "查看配置变更历史（版本号、时间、操作者、理由、当时配置），最新在后。回滚需其中的版本号。",
      parameters: Type.Object({
        post: Type.Optional(Type.String({ description: "职位 ID（或职衔/姓名）；不填看全部" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "最多条数，默认 20" })),
      }),
      async run(p) {
        // hub 返回顺序不作约定：按 id 升序后取最近 limit 条（最新在后）
        const rows = [...(await ctx.hub.configHistory(p.post ? target(p.post) : undefined))].sort((a, b) => a.id - b.id);
        const list = rows.slice(-(p.limit ?? 20)).map((r) => ({
          version: r.version,
          post: r.post_id,
          official_id: r.official_id,
          at: fmtTime(r.at),
          actor: r.actor,
          reason: snip(r.reason, 200),
          model: r.snapshot.model,
          thinking: r.snapshot.thinking,
          extra: r.snapshot.extra_tool_groups,
          disabled: r.snapshot.disabled_tool_groups,
          prompt_overrides: snip(r.snapshot.prompt_overrides, 120),
        }));
        return ok(`配置变更 ${rows.length} 条，显示最近 ${list.length} 条`, list);
      },
    }),

    defineTool({
      name: "config_rollback",
      label: "配置回滚",
      description: "把某官员的配置回滚到历史版本（先用 config_history 查版本号）。敏感职位须皇帝批准。不得回滚自己的配置。",
      parameters: Type.Object({
        post: Type.String({ description: "职位 ID（或职衔/姓名）" }),
        version: Type.Integer({ minimum: 1, description: "目标配置版本号" }),
        reason: Type.String({ description: "回滚理由" }),
      }),
      async run(p, call) {
        const post = target(p.post);
        if (post === ctx.post.post_id) throw new ToolError("官员不得回滚自己的配置");
        const r = await ctx.hub.configRollback({ ...writeMeta(ctx, call.toolCallId), actor: self, post, version: p.version, reason: p.reason });
        return proposeResult(r, `${post} 回滚到 v${p.version}`);
      },
    }),
  ];
}
