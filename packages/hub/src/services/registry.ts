// 名册：部门、职位、官员、任命、模型池、罢朝开关、系统提示词渲染、服务端 ACL。
import {
  effectiveToolGroups,
  toolsForGroups,
  type Address,
  type Appointment,
  type DeptDef,
  type DeptId,
  type ModelEntry,
  type Official,
  type OfficialStatus,
  type PostDef,
  type Registry,
  type ServiceDef,
} from "@court/shared";
import type { HubCtx, RegistryService } from "../ctx.ts";

type DeptFull = DeptDef & { countersign?: boolean };

/** 不健康状态：挑人时尽量避开 */
const UNHEALTHY = new Set(["offline", "sick", "suspended", "paused", "vacant"]);
/** 心跳超过此时长视为离线 */
export const STATUS_STALE_MS = 30_000;

export function getMeta(ctx: HubCtx, k: string): string | undefined {
  return ctx.db.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v;
}
export function setMeta(ctx: HubCtx, k: string, v: string): void {
  ctx.db.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
}

function renderServices(title: string, list: ServiceDef[]): string[] {
  if (!list.length) return [];
  return [title, ...list.map((s) => `- ${s.name}：${s.description}（时限 ${Math.round(s.sla_seconds / 60)} 分钟）`)];
}

export function createRegistry(ctx: HubCtx): RegistryService {
  // 部门与职位定义仅在播种时变化：缓存，bump 时清空
  let deptCache: DeptFull[] | undefined;
  let postCache: PostDef[] | undefined;

  const loadDepts = (): DeptFull[] => (deptCache ??= ctx.db.all<{ def_json: string }>("SELECT def_json FROM depts ORDER BY rowid").map((r) => JSON.parse(r.def_json) as DeptFull));
  const loadPosts = (): PostDef[] => (postCache ??= ctx.db.all<{ def_json: string }>("SELECT def_json FROM posts ORDER BY rowid").map((r) => JSON.parse(r.def_json) as PostDef));

  // 职位排序与名册 yaml 一致（rowid 即插入顺序）
  function deptOrder(): Map<string, number> {
    return new Map(loadDepts().map((d, i) => [d.id, i]));
  }

  const self: RegistryService = {
    snapshot(): Registry {
      const officials = ctx.db.allJson<Official>("SELECT data_json FROM officials ORDER BY rowid LIMIT 5000");
      const appointments = ctx.db.all<Appointment>("SELECT post_id, official_id, since FROM appointments LIMIT 5000");
      return {
        version: self.version(),
        depts: loadDepts(),
        posts: loadPosts(),
        officials,
        appointments,
        models: self.models(),
        court_preamble: ctx.court.court_preamble,
        halted: self.isHalted(),
      };
    },

    version(): number {
      return Number(getMeta(ctx, "registry_version") ?? "1");
    },

    bump(reason: string): void {
      deptCache = undefined;
      postCache = undefined;
      const v = self.version() + 1;
      setMeta(ctx, "registry_version", String(v));
      ctx.events.emit({ type: "registry.bump", actor: "system:hub", summary: `名册更新 v${v}：${reason}`, data: { version: v, reason } });
    },

    dept(id: string): DeptFull | undefined {
      return loadDepts().find((d) => d.id === id);
    },
    depts(): DeptFull[] {
      return loadDepts();
    },
    post(postId: string): PostDef | undefined {
      return loadPosts().find((p) => p.post_id === postId);
    },
    posts(dept?: string): PostDef[] {
      const all = loadPosts();
      if (dept) return all.filter((p) => p.dept === dept);
      const order = deptOrder();
      return [...all].sort((a, b) => (order.get(a.dept) ?? 99) - (order.get(b.dept) ?? 99));
    },

    officialOf(postId: string): Official | undefined {
      return ctx.db.getJson<Official>(
        "SELECT o.data_json FROM appointments a JOIN officials o ON o.official_id = a.official_id WHERE a.post_id = ?",
        postId,
      );
    },
    official(officialId: string): Official | undefined {
      return ctx.db.getJson<Official>("SELECT data_json FROM officials WHERE official_id = ?", officialId);
    },
    postOf(officialId: string): string | undefined {
      return ctx.db.get<{ post_id: string }>("SELECT post_id FROM appointments WHERE official_id = ?", officialId)?.post_id;
    },

    saveOfficial(o: Official, actor: Address, reason: string): Official {
      return ctx.db.tx(() => {
        const prev = self.official(o.official_id);
        const saved: Official = { ...o, config_version: prev ? prev.config_version + 1 : Math.max(1, o.config_version || 1) };
        ctx.db.run(
          "INSERT INTO officials (official_id, data_json) VALUES (?, ?) ON CONFLICT(official_id) DO UPDATE SET data_json = excluded.data_json",
          saved.official_id,
          JSON.stringify(saved),
        );
        ctx.db.run(
          "INSERT INTO config_history (official_id, post_id, version, snapshot_json, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          saved.official_id,
          self.postOf(saved.official_id) ?? "",
          saved.config_version,
          JSON.stringify(saved),
          actor,
          reason,
          ctx.now(),
        );
        self.bump(`官员 ${saved.name} 配置 v${saved.config_version}`);
        return saved;
      });
    },

    pickPost(dept: string, roles: string[], opts?: { exclude?: string[] }): string | undefined {
      const exclude = new Set(opts?.exclude ?? []);
      const posts = self.posts(dept);
      const statusOf = new Map<string, OfficialStatus>();
      for (const s of ctx.statuses()) statusOf.set(s.post_id, s);
      for (const role of roles) {
        const cands = posts.filter((p) => p.roles.includes(role) && !exclude.has(p.post_id)).filter((p) => self.officialOf(p.post_id)?.status === "active");
        if (!cands.length) continue;
        const healthy = cands.filter((p) => !UNHEALTHY.has(statusOf.get(p.post_id)?.state ?? "offline"));
        const pool = healthy.length ? healthy : cands;
        const load = (postId: string): number => {
          try {
            return ctx.workflow?.openTaskCount?.(postId) ?? 0;
          } catch {
            return 0;
          }
        };
        let best = pool[0];
        let bestLoad = load(best.post_id);
        for (const p of pool.slice(1)) {
          const l = load(p.post_id);
          if (l < bestLoad) {
            best = p;
            bestLoad = l;
          }
        }
        return best.post_id;
      }
      return undefined;
    },

    routeDept(dept: string, key: string, opts?: { exclude?: string[] }): string | undefined {
      const d = self.dept(dept);
      if (!d) return undefined;
      const svc = d.services.find((s) => s.name === key);
      const roles = d.routing[key] ?? svc?.route_roles ?? d.routing["*"] ?? ["head"];
      // 指定角色都没人时，退回默认路由，再退回部门长官，保证有人收件
      return (
        self.pickPost(dept, roles, opts) ??
        self.pickPost(dept, d.routing["*"] ?? [], opts) ??
        self.pickPost(dept, ["head", "deputy"], opts)
      );
    },

    toolsOf(postId: string): Set<string> {
      const p = self.post(postId);
      if (!p) return new Set();
      const o = self.officialOf(postId);
      return new Set(toolsForGroups(effectiveToolGroups(p, o)));
    },
    hasTool(postId: string, tool: string): boolean {
      return self.toolsOf(postId).has(tool);
    },

    deptToken(dept: string): string | undefined {
      return ctx.db.get<{ token: string }>("SELECT token FROM depts WHERE id = ?", dept)?.token;
    },
    deptByToken(token: string): DeptId | undefined {
      if (!token) return undefined;
      return ctx.db.get<{ id: DeptId }>("SELECT id FROM depts WHERE token = ?", token)?.id;
    },

    isHalted(): boolean {
      return getMeta(ctx, "halted") === "1";
    },
    setHalted(v: boolean): void {
      setMeta(ctx, "halted", v ? "1" : "0");
      ctx.events.emit({ type: "court.halt", actor: "emperor", summary: v ? "罢朝：全体暂停" : "复朝：恢复运行", data: { halted: v } });
    },

    systemPrompt(postId: string): string {
      const p = self.post(postId);
      if (!p) return "";
      const d = self.dept(p.dept);
      const o = self.officialOf(postId);
      const parts: string[] = [];
      parts.push(ctx.court.court_preamble.trim());
      if (d) parts.push(["【部门】" + d.name + (d.brief ? `（${d.brief}）` : ""), d.duties.trim()].join("\n"));
      const ben = [
        `【本职】${p.title}（${p.post_id}）${p.rank ? "，" + p.rank : ""}${p.benguan ? "，本官" + p.benguan : ""}`,
        `职掌：${p.duties.trim()}`,
      ];
      if (p.prompt) ben.push(p.prompt.trim());
      parts.push(ben.join("\n"));
      if (o?.prompt_overrides?.trim()) parts.push("【个人】\n" + o.prompt_overrides.trim());
      const svc = [...renderServices("本部门服务：", d?.services ?? []), ...renderServices("本职服务：", p.services ?? [])];
      if (svc.length) parts.push(["【可调用的服务】", ...svc].join("\n"));
      const peers = self
        .posts(p.dept)
        .map((x) => `- ${x.title}（post:${x.post_id}）${x.post_id === p.post_id ? "（即你本人）" : ""}${x.roles.length ? "，角色：" + x.roles.join("/") : ""}`);
      parts.push(["【同僚】", ...peers].join("\n"));
      return parts.join("\n\n");
    },

    model(key: string): ModelEntry | undefined {
      return ctx.db.getJson<ModelEntry>("SELECT data_json FROM models WHERE key = ?", key);
    },
    models(): ModelEntry[] {
      return ctx.db.allJson<ModelEntry>("SELECT data_json FROM models ORDER BY rowid LIMIT 1000");
    },
    saveModel(m: ModelEntry): void {
      ctx.db.run(
        "INSERT INTO models (key, status, data_json) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, data_json = excluded.data_json",
        m.key,
        m.status,
        JSON.stringify(m),
      );
      ctx.events.emit({ type: "model.updated", actor: "system:hub", subject_type: "model", subject_id: m.key, summary: `模型 ${m.name}（${m.key}）状态 ${m.status}` });
    },
  };
  return self;
}
