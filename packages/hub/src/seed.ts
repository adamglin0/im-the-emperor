// 播种（每次启动、幂等）：部门 token、职位定义、首任官员与任命、模型池、默认预算、默认定时任务、题库、令牌文件。
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry, Official, PostDef } from "@court/shared";
import type { Db } from "./db.ts";
import type { HubCtx } from "./ctx.ts";

export interface HubTokens {
  gateway: string;
  control: string;
  sandbox: string;
  /** MCP 中转站（broker）令牌：只写 hub/tokens.json，部门不可见 */
  mcp: string;
}

const genToken = (prefix: string) => `${prefix}_${randomBytes(24).toString("hex")}`;

function meta(db: Db, k: string): string | undefined {
  return db.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v;
}
function setMeta(db: Db, k: string, v: string): void {
  db.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
}

/** 网关/控制面/沙箱令牌：环境变量优先，否则首次生成并存 meta */
export function ensureTokens(db: Db, env: Record<string, string | undefined> = process.env): HubTokens {
  const pick = (name: "gateway" | "control" | "sandbox" | "mcp", envName: string, prefix: string): string => {
    const fromEnv = env[envName]?.trim();
    const key = `token_${name}`;
    if (fromEnv) {
      if (meta(db, key) !== fromEnv) setMeta(db, key, fromEnv);
      return fromEnv;
    }
    let t = meta(db, key);
    if (!t) {
      t = genToken(prefix);
      setMeta(db, key, t);
    }
    return t;
  };
  return db.tx(() => ({
    gateway: pick("gateway", "GATEWAY_TOKEN", "gw"),
    control: pick("control", "CONTROL_TOKEN", "ct"),
    sandbox: pick("sandbox", "SANDBOX_TOKEN", "sb"),
    mcp: pick("mcp", "MCP_TOKEN", "mc"),
  }));
}

/** 职位 id → 稳定官员 id */
export const seedOfficialId = (postId: string) => `of_${postId.replace(/[^a-zA-Z0-9]+/g, "_")}`;

/** 默认预算 */
export const DEFAULT_BUDGETS = { global_tokens: 30_000_000, global_cost: 30, post_tokens: 3_000_000 };

export function seed(ctx: HubCtx, tokens: HubTokens): void {
  const { db } = ctx;
  const now = ctx.now();
  let changed = false;

  db.tx(() => {
    // 部门：保留已有 token，定义随 yaml 更新
    for (const d of ctx.court.depts) {
      const row = db.get<{ def_json: string }>("SELECT def_json FROM depts WHERE id = ?", d.id);
      const json = JSON.stringify(d);
      if (!row) {
        db.run("INSERT INTO depts (id, def_json, token) VALUES (?, ?, ?)", d.id, json, genToken("dk"));
        changed = true;
      } else if (row.def_json !== json) {
        db.run("UPDATE depts SET def_json = ? WHERE id = ?", json, d.id);
        changed = true;
      }
    }

    // 职位：定义每次启动以 yaml 为准（persona 字段不入职位定义）
    for (const p of ctx.court.posts) {
      const { name: _n, model: _m, thinking: _t, ...def } = p;
      const json = JSON.stringify(def satisfies PostDef);
      const row = db.get<{ def_json: string }>("SELECT def_json FROM posts WHERE post_id = ?", p.post_id);
      if (!row) {
        db.run("INSERT INTO posts (post_id, dept, def_json) VALUES (?, ?, ?)", p.post_id, p.dept, json);
        // 名册新增职位（非首次启动）：补默认职位预算
        if (db.get("SELECT 1 FROM budgets LIMIT 1") && !db.get("SELECT 1 FROM budgets WHERE scope = ?", `post:${p.post_id}`)) {
          db.run(
            "INSERT INTO budgets (scope, data_json) VALUES (?, ?)",
            `post:${p.post_id}`,
            JSON.stringify({ scope: `post:${p.post_id}`, daily_tokens: DEFAULT_BUDGETS.post_tokens, updated_by: "system:seed", updated_at: now }),
          );
        }
        changed = true;
      } else if (row.def_json !== json) {
        db.run("UPDATE posts SET dept = ?, def_json = ? WHERE post_id = ?", p.dept, json, p.post_id);
        changed = true;
      }
    }

    // 首任官员：仅对从未任命过的职位
    for (const p of ctx.court.posts) {
      const everAppointed =
        db.get("SELECT 1 FROM appointments WHERE post_id = ?", p.post_id) ?? db.get("SELECT 1 FROM appointment_history WHERE post_id = ? LIMIT 1", p.post_id);
      if (everAppointed) continue;
      const official_id = seedOfficialId(p.post_id);
      if (db.get("SELECT 1 FROM officials WHERE official_id = ?", official_id)) continue;
      const o: Official = {
        official_id,
        name: p.name,
        model: p.model ?? ctx.modelsCfg.default_model,
        thinking: p.thinking ?? "low",
        prompt_overrides: "",
        extra_tool_groups: [],
        disabled_tool_groups: [],
        status: "active",
        config_version: 1,
        created_at: now,
      };
      db.run("INSERT INTO officials (official_id, data_json) VALUES (?, ?)", official_id, JSON.stringify(o));
      db.run("INSERT INTO appointments (post_id, official_id, since) VALUES (?, ?, ?)", p.post_id, official_id, now);
      db.run(
        "INSERT INTO appointment_history (at, actor, action, official_id, post_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
        now,
        "system:seed",
        "appoint",
        official_id,
        p.post_id,
        `首任：${o.name} 任 ${p.title}（模型 ${o.model}）`,
      );
      db.run(
        "INSERT INTO config_history (official_id, post_id, version, snapshot_json, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        official_id,
        p.post_id,
        1,
        JSON.stringify(o),
        "system:seed",
        "首任",
        now,
      );
      changed = true;
    }

    // 模型池：补齐缺失
    for (const m of ctx.modelsCfg.models) {
      const key = `${m.provider}/${m.model_id}`;
      if (db.get("SELECT 1 FROM models WHERE key = ?", key)) continue;
      const status = (["candidate", "examining", "examined", "failed", "retired"].includes(m.status ?? "") ? m.status : "candidate") as ModelEntry["status"];
      const e: ModelEntry = { key, provider: m.provider, model_id: m.model_id, name: m.name ?? m.model_id, status, added_at: now };
      if (m.api) e.api = m.api;
      if (m.base_url) e.base_url = m.base_url;
      if (m.context_window) e.context_window = m.context_window;
      db.run("INSERT INTO models (key, status, data_json) VALUES (?, ?, ?)", key, status, JSON.stringify(e));
      changed = true;
    }

    // 默认预算：仅在一条预算都没有时
    if (!db.get("SELECT 1 FROM budgets LIMIT 1")) {
      const put = (scope: string, daily_tokens?: number, daily_cost?: number) => {
        const b: Record<string, unknown> = { scope, updated_by: "system:seed", updated_at: now };
        if (daily_tokens != null) b.daily_tokens = daily_tokens;
        if (daily_cost != null) b.daily_cost = daily_cost;
        db.run("INSERT INTO budgets (scope, data_json) VALUES (?, ?)", scope, JSON.stringify(b));
      };
      put("global", DEFAULT_BUDGETS.global_tokens, DEFAULT_BUDGETS.global_cost);
      for (const p of ctx.court.posts) put(`post:${p.post_id}`, DEFAULT_BUDGETS.post_tokens);
    }

    if (!meta(db, "registry_version")) setMeta(db, "registry_version", "1");
    if (!meta(db, "halted")) setMeta(db, "halted", "0");
  });

  if (changed && meta(db, "seeded_at")) ctx.registry.bump("启动同步名册");
  if (!meta(db, "seeded_at")) setMeta(db, "seeded_at", String(now));

  ctx.schedules.seedDefaults();
  try {
    ctx.exams?.seedQuestions?.();
  } catch (e) {
    console.error("[hub] 题库播种失败：", (e as Error).message);
  }

  writeTokenFiles(ctx, tokens);
}

/**
 * 令牌文件：DATA_DIR/shared/tokens.json（部门/网关/沙箱容器读取）与 DATA_DIR/hub/tokens.json。
 * MCP broker 令牌只写 hub 份（部门可读 shared，拿到它就能取全部 MCP 密钥）。
 */
export function writeTokenFiles(ctx: HubCtx, tokens: HubTokens): void {
  const depts: Record<string, string> = {};
  for (const r of ctx.db.all<{ id: string; token: string }>("SELECT id, token FROM depts ORDER BY rowid LIMIT 100")) depts[r.id] = r.token;
  const shared = { depts, gateway: tokens.gateway, control: tokens.control, sandbox: tokens.sandbox };
  const files: [string, object][] = [
    [join(ctx.dataDir, "shared"), shared],
    [join(ctx.dataDir, "hub"), { ...shared, mcp: tokens.mcp }],
  ];
  for (const [dir, obj] of files) {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "tokens.json");
    writeFileSync(f, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(f, 0o600);
    } catch {
      /* 某些文件系统不支持 */
    }
  }
}
