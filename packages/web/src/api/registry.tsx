// 名册上下文：部门/职位/官员查找与地址的中文显示。名册变更（人事/配置事件）时自动重取。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Address, DeptDef, Official, PostDef, Registry } from "@court/shared/types";
import { hub } from "./client.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { DEPT_NAMES, DEPT_ORDER } from "../lib/labels.ts";

export interface RegistryApi {
  registry: Registry | undefined;
  loading: boolean;
  error: unknown;
  reload: () => void;
  depts: DeptDef[];
  posts: PostDef[];
  dept: (id: string) => DeptDef | undefined;
  deptName: (id: string | undefined) => string;
  post: (postId: string) => PostDef | undefined;
  /** 某职位现任官员 */
  officialOf: (postId: string) => Official | undefined;
  officialById: (officialId: string) => Official | undefined;
  /** 官员现任职位 */
  postOfOfficial: (officialId: string) => string | undefined;
  postsOfDept: (deptId: string) => PostDef[];
  /** 「给事中 薛中立」 */
  postLabel: (postId: string, withName?: boolean) => string;
  /** 地址 → 中文：emperor→朕；post:x→职衔+姓名；dept:x→部门；system:x→系统 */
  addrLabel: (addr: Address | undefined, withName?: boolean) => string;
  /** 地址 → 路由（职位页/部门页），无则 undefined */
  addrHref: (addr: Address | undefined) => string | undefined;
}

const SYSTEM_NAMES: Record<string, string> = {
  watchdog: "看门狗",
  scheduler: "司辰",
  audit: "稽查规则",
  kaochang: "考场",
  hub: "皇城",
  gateway: "网关",
};

const Ctx = createContext<RegistryApi | null>(null);

export function RegistryProvider({ children }: { children: ReactNode }) {
  const q = useQuery(() => hub.registry(), [], {
    watch: ["registry.", "personnel.", "config.", "model.", "exam.published"],
    interval: 120_000,
  });
  const api = useMemo<RegistryApi>(() => {
    const r = q.data;
    const deptMap = new Map((r?.depts ?? []).map((d) => [d.id as string, d]));
    const postMap = new Map((r?.posts ?? []).map((p) => [p.post_id, p]));
    const offMap = new Map((r?.officials ?? []).map((o) => [o.official_id, o]));
    const apptByPost = new Map<string, string>();
    const apptByOfficial = new Map<string, string>();
    for (const a of r?.appointments ?? []) {
      apptByPost.set(a.post_id, a.official_id);
      apptByOfficial.set(a.official_id, a.post_id);
    }
    const depts = [...(r?.depts ?? [])].sort((a, b) => DEPT_ORDER.indexOf(a.id) - DEPT_ORDER.indexOf(b.id));
    const deptName = (id: string | undefined) => (id ? (deptMap.get(id)?.name ?? DEPT_NAMES[id] ?? id) : "—");
    const officialOf = (postId: string) => {
      const oid = apptByPost.get(postId);
      return oid ? offMap.get(oid) : undefined;
    };
    const postLabel = (postId: string, withName = true) => {
      const p = postMap.get(postId);
      if (!p) return postId;
      const o = withName ? officialOf(postId) : undefined;
      const sameTitle = [...postMap.values()].filter((x) => x.title === p.title).length > 1;
      const title = sameTitle && !o ? `${deptName(p.dept)}${p.title}` : p.title;
      return o ? `${title} ${o.name}` : title;
    };
    const addrLabel = (addr: Address | undefined, withName = true) => {
      if (!addr) return "—";
      if (addr === "emperor") return "朕";
      if (addr === "court") return "朝廷";
      const [kind, ...rest] = addr.split(":");
      const id = rest.join(":");
      if (kind === "post") return postLabel(id, withName);
      if (kind === "dept") return deptName(id);
      if (kind === "system") return `系统·${SYSTEM_NAMES[id] ?? id}`;
      if (postMap.has(addr)) return postLabel(addr, withName);
      return addr;
    };
    const addrHref = (addr: Address | undefined) => {
      if (!addr) return undefined;
      const [kind, ...rest] = addr.split(":");
      const id = rest.join(":");
      if (kind === "post") return `/officials/${id}`;
      if (kind === "dept") return `/depts/${id}`;
      if (postMap.has(addr)) return `/officials/${addr}`;
      return undefined;
    };
    return {
      registry: r,
      loading: q.loading,
      error: q.error,
      reload: q.reload,
      depts,
      posts: r?.posts ?? [],
      dept: (id) => deptMap.get(id),
      deptName,
      post: (id) => postMap.get(id),
      officialOf,
      officialById: (id) => offMap.get(id),
      postOfOfficial: (id) => apptByOfficial.get(id),
      postsOfDept: (d) => (r?.posts ?? []).filter((p) => p.dept === d),
      postLabel,
      addrLabel,
      addrHref,
    };
  }, [q.data, q.loading, q.error, q.reload]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useRegistry(): RegistryApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRegistry 须在 RegistryProvider 内使用");
  return v;
}
