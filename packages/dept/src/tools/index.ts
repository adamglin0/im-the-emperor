// 工具装配：按官员有效工具组返回工具实例
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { effectiveToolGroups, toolsForGroups } from "@court/shared";
import type { ToolContext, ToolFactory } from "../tool-context.ts";
import { assetsTools } from "./assets.ts";
import { censorTools } from "./censor.ts";
import { configTools } from "./config.ts";
import { councilTools } from "./council.ts";
import { dispatchTools } from "./dispatch.ts";
import { docsTools } from "./docs.ts";
import { draftingTools } from "./drafting.ts";
import { emperorTools } from "./emperor.ts";
import { withEndGuard } from "./end-guard.ts";
import { examTools } from "./exam.ts";
import { financeTools } from "./finance.ts";
import { justiceTools } from "./justice.ts";
import { mcpAdminTools } from "./mcp.ts";
import { messagingTools } from "./messaging.ts";
import { personnelTools } from "./personnel.ts";
import { reviewTools } from "./review.ts";
import { ritesTools } from "./rites.ts";
import { rosterTools } from "./roster.ts";
import { scheduleTools } from "./schedule.ts";
import { selfTools } from "./self.ts";
import { servicesTools } from "./services.ts";
import { workshopTools } from "./workshop.ts";

/** 全部工具工厂（同名工具以先出现者为准：edict_diff 在 drafting，task_* 管理类在 dispatch） */
export const TOOL_FACTORIES: ToolFactory[] = [
  messagingTools,
  rosterTools,
  servicesTools,
  docsTools,
  emperorTools,
  assetsTools,
  scheduleTools,
  selfTools,
  councilTools,
  draftingTools,
  reviewTools,
  dispatchTools,
  configTools,
  examTools,
  financeTools,
  personnelTools,
  workshopTools,
  justiceTools,
  ritesTools,
  censorTools,
  mcpAdminTools,
];

/** 构建全部已实现工具（name → tool），不按权限过滤 */
export function buildAllTools(ctx: ToolContext): Map<string, AgentTool<any>> {
  const map = new Map<string, AgentTool<any>>();
  for (const f of TOOL_FACTORIES) for (const t of f(ctx)) if (!map.has(t.name)) map.set(t.name, withEndGuard(ctx, t));
  return map;
}

/** 按 effectiveToolGroups(post, official) 返回该官员可用的工具 */
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
  const all = buildAllTools(ctx);
  const names = toolsForGroups(effectiveToolGroups(ctx.post, ctx.official));
  const out: AgentTool<any>[] = [];
  for (const n of names) {
    const t = all.get(n);
    if (t) out.push(t);
    else ctx.log("error", { message: `工具 ${n} 未实现`, tool: n });
  }
  return out;
}
