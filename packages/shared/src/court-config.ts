import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { DefaultSchedule, DeptDef, DeptId, ExamDimension, PostDef, ServiceDef, ThinkingLevel } from "./types.ts";
import { TOOL_GROUPS } from "./tool-groups.ts";

export interface CourtConfig {
  court_preamble: string;
  depts: (DeptDef & { countersign?: boolean })[];
  posts: (PostDef & { name: string; model?: string; thinking?: ThinkingLevel })[];
}

export interface ModelsConfig {
  default_model: string;
  grader_model: string;
  summary_model: string;
  models: { provider: string; model_id: string; name?: string; status?: string; api?: string; base_url?: string; context_window?: number; key_env?: string }[];
  fitness_weights: Record<DeptId, Partial<Record<ExamDimension, number>>>;
  fitness_threshold: number;
}

const DEPT_IDS: DeptId[] = ["zhengshitang", "zhongshu", "menxia", "shangshu", "libu", "hubu", "libu_rites", "bingbu", "xingbu", "gongbu", "yushitai"];

export function loadCourtConfig(path: string): CourtConfig {
  const raw = parse(readFileSync(path, "utf8")) as any;
  const d = raw.defaults ?? {};
  const depts: CourtConfig["depts"] = (raw.depts ?? []).map((x: any) => ({
    id: x.id,
    name: x.name,
    brief: x.brief ?? "",
    duties: (x.duties ?? "").trim(),
    host: x.host ?? `dept-${String(x.id).replace(/_/g, "-")}`,
    port: x.port ?? 8080,
    routing: x.routing ?? { "*": ["head"] },
    services: (x.services ?? []) as ServiceDef[],
    default_schedules: (x.default_schedules ?? []) as DefaultSchedule[],
    countersign: !!x.countersign,
  }));
  const posts: CourtConfig["posts"] = (raw.posts ?? []).map((p: any) => ({
    post_id: p.post_id,
    dept: p.dept,
    title: p.title,
    rank: p.rank ?? "",
    benguan: p.benguan,
    duties: String(p.duties ?? "").trim(),
    tool_groups: p.tool_groups ?? ["common"],
    roles: p.roles ?? [],
    services: p.services ?? [],
    activity: p.activity ?? "always",
    interruptible_by: p.interruptible_by ?? d.interruptible_by ?? ["emperor", "edict", "urgent"],
    default_wait_seconds: p.default_wait_seconds ?? d.default_wait_seconds ?? 3600,
    approval_sensitive: p.approval_sensitive ?? ["zhengshitang", "menxia", "yushitai", "libu"].includes(p.dept),
    default_schedules: p.default_schedules ?? [],
    prompt: p.prompt,
    name: p.name ?? p.title,
    model: p.model,
    thinking: p.thinking ?? d.thinking ?? "low",
  }));
  const cfg: CourtConfig = { court_preamble: String(raw.court_preamble ?? "").trim(), depts, posts };
  validateCourtConfig(cfg);
  return cfg;
}

export function validateCourtConfig(cfg: CourtConfig): void {
  const errs: string[] = [];
  const deptIds = new Set(cfg.depts.map((d) => d.id));
  for (const id of DEPT_IDS) if (!deptIds.has(id)) errs.push(`缺少部门 ${id}`);
  const seen = new Set<string>();
  for (const p of cfg.posts) {
    if (seen.has(p.post_id)) errs.push(`重复职位 ${p.post_id}`);
    seen.add(p.post_id);
    if (!deptIds.has(p.dept)) errs.push(`职位 ${p.post_id} 的部门 ${p.dept} 不存在`);
    if (!p.post_id.startsWith(p.dept + ".")) errs.push(`职位 ${p.post_id} 应以 ${p.dept}. 开头`);
    for (const g of p.tool_groups) if (!(g in TOOL_GROUPS)) errs.push(`职位 ${p.post_id} 工具组 ${g} 不存在`);
  }
  for (const d of cfg.depts) {
    const roles = new Set(cfg.posts.filter((p) => p.dept === d.id).flatMap((p) => p.roles));
    for (const [k, rs] of Object.entries(d.routing)) if (!rs.some((r) => roles.has(r))) errs.push(`部门 ${d.id} 路由 ${k} 无可用角色`);
    for (const s of d.services) for (const r of s.route_roles ?? []) if (!roles.has(r)) errs.push(`部门 ${d.id} 服务 ${s.name} 角色 ${r} 无人`);
  }
  if (errs.length) throw new Error("court.yaml 校验失败:\n" + errs.join("\n"));
}

export function loadModelsConfig(path: string): ModelsConfig {
  const raw = parse(readFileSync(path, "utf8")) as any;
  return {
    default_model: raw.default_model,
    grader_model: raw.grader_model ?? raw.default_model,
    summary_model: raw.summary_model ?? raw.default_model,
    models: raw.models ?? [],
    fitness_weights: raw.fitness_weights ?? {},
    fitness_threshold: raw.fitness_threshold ?? 60,
  };
}
