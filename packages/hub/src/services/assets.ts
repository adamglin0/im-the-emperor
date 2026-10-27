// 资产：版本化文件（DATA_DIR/hub/assets/<id>/<version>）+ 元数据 + 可见性 + 访问审计。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  newId,
  sha256,
  type Address,
  type Asset,
  type AssetContent,
  type AssetListQuery,
  type AssetVersion,
  type PutAssetReq,
  type Visibility,
} from "@court/shared";
import { bad, forbidden, notFound, type AssetService, type HubCtx } from "../ctx.ts";

const VISIBILITIES: Visibility[] = ["private", "department", "court"];
export const ASSET_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|toml|sql))/;

const EXT_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  py: "text/x-python",
  sh: "application/x-sh",
  sql: "application/sql",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function guessMime(path: string, encoding: "utf8" | "base64"): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? (encoding === "base64" ? "application/octet-stream" : "text/plain");
}

function normalizePath(p: unknown): string {
  if (typeof p !== "string" || !p.trim()) throw bad("path 不能为空（如 notes/纪要.md）");
  const s = p.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (s.length > 512) throw bad("path 过长（上限 512 字符）");
  if (s.split("/").some((seg) => seg === ".." || seg === ".")) throw bad("path 不能包含 . 或 .. 段");
  return s;
}

export interface AssetServiceExt extends AssetService {
  get(id: string): Asset | undefined;
  versions(id: string, viewer: Address): AssetVersion[];
  share(id: string, actor: Address, withAddrs: Address[], visibility?: Visibility): Asset;
  remove(id: string, actor: Address): void;
  canWrite(asset: Pick<Asset, "owner" | "owner_official">, actor: Address): boolean;
}

export function createAssets(ctx: HubCtx): AssetServiceExt {
  const root = join(ctx.dataDir, "hub", "assets");

  function getAsset(id: string): Asset | undefined {
    return ctx.db.getJson<Asset>("SELECT data_json FROM assets WHERE id = ?", id);
  }
  function saveAsset(a: Asset): void {
    ctx.db.run(
      `INSERT INTO assets (id, owner, owner_official, path, visibility, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET visibility = excluded.visibility, updated_at = excluded.updated_at, data_json = excluded.data_json`,
      a.id,
      a.owner,
      a.owner_official ?? null,
      a.path,
      a.visibility,
      a.updated_at,
      JSON.stringify(a),
    );
  }
  function audit(assetId: string, viewer: Address, action: "read" | "write" | "share" | "delete"): void {
    ctx.db.run("INSERT INTO asset_access (asset_id, viewer, action, at) VALUES (?, ?, ?, ?)", assetId, viewer, action, ctx.now());
  }

  const deptOfPost = (p: string) => ctx.registry.post(p)?.dept;
  const officialIdOfPost = (p: string) => ctx.registry.officialOf(p)?.official_id;

  function validateOwner(owner: unknown): Address {
    if (owner === "court") return "court";
    if (typeof owner !== "string") throw bad("owner 必须是 post:<职位> / dept:<部门> / court");
    if (owner.startsWith("post:") && ctx.registry.post(owner.slice(5))) return owner;
    if (owner.startsWith("dept:") && ctx.registry.dept(owner.slice(5))) return owner;
    throw bad(`owner「${owner}」无效，应为 post:<职位> / dept:<部门> / court`);
  }

  /** 个人资产属于 persona：比对官员 ID；dept 资产属于部门成员 */
  function isOwnerSide(asset: Pick<Asset, "owner" | "owner_official">, actor: Address): boolean {
    if (!actor.startsWith("post:")) return false;
    const p = actor.slice(5);
    if (asset.owner.startsWith("post:")) {
      if (asset.owner_official) return officialIdOfPost(p) === asset.owner_official;
      return asset.owner === actor;
    }
    if (asset.owner.startsWith("dept:")) return deptOfPost(p) === asset.owner.slice(5);
    return false;
  }

  function canWrite(asset: Pick<Asset, "owner" | "owner_official">, actor: Address): boolean {
    if (actor === "emperor" || actor.startsWith("system:")) return true;
    return isOwnerSide(asset, actor);
  }

  function canRead(asset: Asset, viewer: Address): boolean {
    if (viewer === "emperor" || viewer.startsWith("system:")) return true;
    if (asset.visibility === "court" || asset.owner === "court") return true;
    let viewerDept: string | undefined;
    if (viewer.startsWith("post:")) {
      if (isOwnerSide(asset, viewer)) return true;
      viewerDept = deptOfPost(viewer.slice(5));
    } else if (viewer.startsWith("dept:")) {
      viewerDept = viewer.slice(5);
      if (asset.owner === viewer) return true;
    }
    if (asset.visibility === "department" && viewerDept) {
      // 个人资产的「部门」以官员现任职位为准（跟人走）
      const curPost = asset.owner_official ? ctx.registry.postOf(asset.owner_official) : undefined;
      const ownerDept = asset.owner.startsWith("post:")
        ? deptOfPost(curPost ?? asset.owner.slice(5))
        : asset.owner.startsWith("dept:")
          ? asset.owner.slice(5)
          : undefined;
      if (ownerDept === viewerDept) return true;
    }
    const shared = asset.shared_with ?? [];
    if (shared.includes(viewer)) return true;
    if (viewerDept && shared.includes(`dept:${viewerDept}`)) return true;
    return false;
  }

  const denyRead = () => forbidden("无权查看该资产：私产仅本人与陛下可见，部门资产仅本部门可见。如确需查看，请请所有者 asset_share，御史须奏请陛下批准");

  const self: AssetServiceExt = {
    put(req: PutAssetReq): Asset {
      if (!req || typeof req !== "object") throw bad("请求体缺失");
      const actor = req.actor;
      if (typeof actor !== "string" || !actor) throw bad("actor 不能为空");
      const owner = validateOwner(req.owner);
      const path = normalizePath(req.path);
      const encoding = req.encoding ?? "utf8";
      if (encoding !== "utf8" && encoding !== "base64") throw bad("encoding 只能是 utf8 或 base64");
      if (typeof req.content !== "string") throw bad("content 必须是字符串");
      if (req.visibility !== undefined && !VISIBILITIES.includes(req.visibility)) throw bad(`visibility 只能是 ${VISIBILITIES.join("/")}`);
      const buf = Buffer.from(req.content, encoding);
      if (buf.length > ASSET_MAX_BYTES) throw bad(`内容过大（${buf.length} 字节，上限 ${ASSET_MAX_BYTES}）`);
      const owner_official = owner.startsWith("post:") ? officialIdOfPost(owner.slice(5)) : undefined;
      if (owner.startsWith("post:") && !owner_official) throw bad(`职位 ${owner} 空缺，不能写入个人资产；请写入部门资产 dept:<部门>`);
      if (owner === "court" && actor !== "emperor" && !actor.startsWith("system:")) {
        throw forbidden("朝廷公开资产（court）只能由陛下写入；官员请写入本人或部门资产，并设 visibility=court 公开");
      }
      if (!canWrite({ owner, owner_official }, actor)) throw forbidden(`${actor} 无权写入 ${owner} 的资产（只能写本人或本部门资产）`);

      return ctx.idem.wrap(req.idem_key ? `asset:${actor}:${req.idem_key}` : undefined, () =>
        ctx.db.tx(() => {
          // 个人资产按「官员 + 路径」定位（调岗后同一路径仍是同一资产）
          const existing = owner_official
            ? ctx.db.getJson<Asset>("SELECT data_json FROM assets WHERE owner LIKE 'post:%' AND owner_official = ? AND path = ? LIMIT 1", owner_official, path)
            : ctx.db.getJson<Asset>("SELECT data_json FROM assets WHERE owner = ? AND owner_official IS NULL AND path = ? LIMIT 1", owner, path);
          const hash = sha256(buf);
          const now = ctx.now();
          if (existing && existing.sha256 === hash && (req.visibility === undefined || req.visibility === existing.visibility)) {
            return existing; // 内容未变：不产生新版本
          }
          const id = existing?.id ?? newId("as");
          const version = (existing?.latest_version ?? 0) + (existing && existing.sha256 === hash ? 0 : 1);
          const a: Asset = {
            id,
            owner,
            path,
            visibility: req.visibility ?? existing?.visibility ?? "private",
            shared_with: existing?.shared_with ?? [],
            mime: req.mime || existing?.mime || guessMime(path, encoding),
            size: buf.length,
            sha256: hash,
            latest_version: version,
            created_at: existing?.created_at ?? now,
            updated_at: now,
          };
          if (owner_official) a.owner_official = owner_official;
          const trace = req.trace_id ?? existing?.trace_id;
          if (trace) a.trace_id = trace;
          if (!existing || existing.sha256 !== hash) {
            const dir = join(root, id);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, String(version)), buf);
            const v: AssetVersion = { asset_id: id, version, sha256: hash, size: buf.length, author: actor, created_at: now };
            ctx.db.run("INSERT OR REPLACE INTO asset_versions (asset_id, version, data_json) VALUES (?, ?, ?)", id, version, JSON.stringify(v));
          }
          saveAsset(a);
          audit(id, actor, "write");
          ctx.events.emit({
            type: "asset.written",
            actor,
            trace_id: a.trace_id,
            dept: actor.startsWith("post:") ? deptOfPost(actor.slice(5)) : undefined,
            subject_type: "asset",
            subject_id: id,
            summary: `${actor} 写入资产 ${owner}/${path} v${version}`,
            data: { asset_id: id, version, sha256: hash, size: buf.length },
          });
          return a;
        }),
      );
    },

    canRead,
    canWrite,
    get: getAsset,

    read(id: string, viewer: Address, version?: number): AssetContent {
      const a = getAsset(id);
      if (!a) throw notFound(`资产 ${id}`);
      if (!canRead(a, viewer)) throw denyRead();
      const v = version === undefined || version === null || Number.isNaN(version) ? a.latest_version : Math.floor(version);
      if (v < 1 || v > a.latest_version) throw bad(`版本 ${v} 不存在（最新 v${a.latest_version}）`);
      const file = join(root, id, String(v));
      if (!existsSync(file)) throw notFound(`资产 ${id} 的 v${v} 文件`);
      const buf = readFileSync(file);
      audit(id, viewer, "read");
      const isText = TEXT_MIME.test(a.mime) || a.mime === "image/svg+xml" || a.mime === "application/x-ndjson";
      let content: string;
      let encoding: "utf8" | "base64";
      if (isText) {
        content = buf.toString("utf8");
        encoding = "utf8";
      } else {
        content = buf.toString("base64");
        encoding = "base64";
      }
      return { asset: a, version: v, content, encoding };
    },

    list(q: AssetListQuery): Asset[] {
      const viewer = q.viewer || "emperor";
      const lim = Math.max(1, Math.min(500, Math.floor(Number(q.limit)) || 100));
      const where: string[] = [];
      const params: string[] = [];
      if (q.owner) {
        if (q.owner.startsWith("post:")) {
          // 个人资产跟人走：按该职位现任官员查
          const of = officialIdOfPost(q.owner.slice(5));
          if (of) {
            where.push("(owner_official = ? OR (owner = ? AND owner_official IS NULL))");
            params.push(of, q.owner);
          } else {
            where.push("owner = ? AND owner_official IS NULL");
            params.push(q.owner);
          }
        } else {
          where.push("owner = ?");
          params.push(q.owner);
        }
      }
      if (q.q) {
        where.push("instr(path, ?) > 0");
        params.push(String(q.q));
      }
      const sql = `SELECT data_json FROM assets ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT 2000`;
      const out: Asset[] = [];
      for (const a of ctx.db.allJson<Asset>(sql, ...params)) {
        if (canRead(a, viewer)) out.push(a);
        if (out.length >= lim) break;
      }
      return out;
    },

    versions(id: string, viewer: Address): AssetVersion[] {
      const a = getAsset(id);
      if (!a) throw notFound(`资产 ${id}`);
      if (!canRead(a, viewer)) throw denyRead();
      return ctx.db.allJson<AssetVersion>("SELECT data_json FROM asset_versions WHERE asset_id = ? ORDER BY version DESC LIMIT 500", id);
    },

    share(id: string, actor: Address, withAddrs: Address[], visibility?: Visibility): Asset {
      const a = getAsset(id);
      if (!a) throw notFound(`资产 ${id}`);
      if (!canWrite(a, actor)) throw forbidden("只有资产所有者（或陛下）可以分享");
      if (!Array.isArray(withAddrs)) throw bad("with 必须是地址数组");
      if (visibility !== undefined && !VISIBILITIES.includes(visibility)) throw bad(`visibility 只能是 ${VISIBILITIES.join("/")}`);
      const add: Address[] = [];
      for (const w of withAddrs) {
        if (typeof w !== "string") throw bad("with 中的地址必须是字符串");
        const s = !w.includes(":") && ctx.registry.post(w) ? `post:${w}` : w;
        if (s.startsWith("post:") && ctx.registry.post(s.slice(5))) add.push(s);
        else if (s.startsWith("dept:") && ctx.registry.dept(s.slice(5))) add.push(s);
        else throw bad(`分享对象「${w}」无效，应为 post:<职位> 或 dept:<部门>`);
      }
      return ctx.db.tx(() => {
        const next: Asset = { ...a, shared_with: [...new Set([...(a.shared_with ?? []), ...add])].slice(0, 100), updated_at: ctx.now() };
        if (visibility) next.visibility = visibility;
        saveAsset(next);
        audit(id, actor, "share");
        ctx.events.emit({ type: "asset.shared", actor, subject_type: "asset", subject_id: id, summary: `${actor} 分享资产 ${a.path} 给 ${add.join("、") || "（无）"}${visibility ? `，可见性 ${visibility}` : ""}` });
        return next;
      });
    },

    remove(id: string, actor: Address): void {
      const a = getAsset(id);
      if (!a) throw notFound(`资产 ${id}`);
      if (!canWrite(a, actor)) throw forbidden("只有资产所有者（或陛下）可以删除");
      ctx.db.tx(() => {
        ctx.db.run("DELETE FROM assets WHERE id = ?", id);
        ctx.db.run("DELETE FROM asset_versions WHERE asset_id = ?", id);
        audit(id, actor, "delete");
        ctx.events.emit({ type: "asset.deleted", actor, subject_type: "asset", subject_id: id, summary: `${actor} 删除资产 ${a.owner}/${a.path}` });
      });
      try {
        rmSync(join(root, id), { recursive: true, force: true });
      } catch {
        /* 文件残留无害 */
      }
    },
  };
  return self;
}
