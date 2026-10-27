// 门铃与部门控制面：提交后异步通知部门 runtime 拉取；失败忽略（部门每 30s 兜底拉取）。
import type { DeptDef } from "@court/shared";
import type { DoorbellService, HubCtx } from "../ctx.ts";

/** 部门健康：最近心跳在此时间内视为在线 */
export const DEPT_HEALTH_OK_MS = 20_000;
const DOORBELL_TIMEOUT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 10_000;

let overrideRaw: string | undefined;
let overrideMap: Record<string, string> = {};

/** 部门 API 基址：默认 http://<host>:<port>，可由环境变量 DEPT_URL_OVERRIDES（JSON {deptId: url}）覆盖 */
export function deptUrl(dept: Pick<DeptDef, "id" | "host" | "port">): string {
  const raw = process.env.DEPT_URL_OVERRIDES ?? "";
  if (raw !== overrideRaw) {
    overrideRaw = raw;
    try {
      overrideMap = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      console.error("[hub] DEPT_URL_OVERRIDES 不是合法 JSON，已忽略");
      overrideMap = {};
    }
  }
  const o = overrideMap[dept.id];
  if (o) return o.replace(/\/+$/, "");
  return `http://${dept.host}:${dept.port}`;
}

export function createDoorbell(ctx: HubCtx): DoorbellService {
  // 同一 tick 内的多次 ring 合并成每部门一次请求
  let pending = new Map<string, Set<string>>();
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    const batch = pending;
    pending = new Map();
    for (const [deptId, posts] of batch) {
      const d = ctx.registry.dept(deptId);
      if (!d) continue;
      void fetch(`${deptUrl(d)}/control/doorbell`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ctx.controlToken}` },
        body: JSON.stringify({ posts: [...posts] }),
        signal: AbortSignal.timeout(DOORBELL_TIMEOUT_MS),
      })
        .then((r) => r.body?.cancel().catch(() => {}))
        .catch(() => {
          /* 门铃丢失无害 */
        });
    }
  }

  const self: DoorbellService = {
    ring(posts: string[]): void {
      for (const p of posts) {
        const def = ctx.registry.post(p);
        if (!def) continue;
        let set = pending.get(def.dept);
        if (!set) pending.set(def.dept, (set = new Set()));
        set.add(p);
      }
      if (!scheduled && pending.size) {
        scheduled = true;
        // 事务是同步的：setImmediate 时必已提交
        setImmediate(flush);
      }
    },

    async control(dept: string, path: string, body: unknown): Promise<void> {
      const d = ctx.registry.dept(dept);
      if (!d) throw new Error(`部门 ${dept} 不存在`);
      const res = await fetch(`${deptUrl(d)}${path.startsWith("/") ? path : "/" + path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ctx.controlToken}` },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`部门 ${dept} 控制面 ${path} 返回 ${res.status}：${text.slice(0, 200)}`);
    },

    deptHealth(): Record<string, { ok: boolean; last_seen: number }> {
      const now = ctx.now();
      const out: Record<string, { ok: boolean; last_seen: number }> = {};
      for (const d of ctx.registry.depts()) out[d.id] = { ok: false, last_seen: 0 };
      for (const r of ctx.db.all<{ dept: string; last_seen: number }>("SELECT dept, last_seen FROM dept_health LIMIT 100")) {
        out[r.dept] = { ok: now - r.last_seen < DEPT_HEALTH_OK_MS, last_seen: r.last_seen };
      }
      return out;
    },

    markSeen(dept: string): void {
      ctx.db.run(
        "INSERT INTO dept_health (dept, last_seen) VALUES (?, ?) ON CONFLICT(dept) DO UPDATE SET last_seen = excluded.last_seen",
        dept,
        ctx.now(),
      );
    },
  };
  return self;
}

/** 对所有部门发控制命令（失败只记事件，不抛出） */
export function controlAll(ctx: HubCtx, path: string, body: unknown = {}): void {
  for (const d of ctx.registry.depts()) {
    ctx.doorbell.control(d.id, path, body).catch((e: Error) => {
      ctx.events.emit({ type: "dept.control_failed", actor: "system:hub", dept: d.id, summary: `控制命令 ${path} 未送达 ${d.name}：${e.message}`.slice(0, 300) });
    });
  }
}

/** 对某部门发控制命令，失败吞掉（下一次同步会补齐） */
export function controlQuiet(ctx: HubCtx, dept: string, path: string, body: unknown = {}): void {
  ctx.doorbell.control(dept, path, body).catch(() => {});
}
