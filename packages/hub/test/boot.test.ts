import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHub, raw, expectStatus, type TestHub } from "./helpers.ts";
import { seedOfficialId } from "../src/seed.ts";
import { resolvePrincipal } from "../src/auth.ts";

describe("启动与播种", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("播种部门、职位、官员、任命、模型、预算、默认定时任务", async () => {
    const reg = await hub.emperor.registry();
    expect(reg.depts).toHaveLength(11);
    expect(reg.posts.length).toBe(hub.ctx.court.posts.length);
    expect(reg.appointments.length).toBe(reg.posts.length);
    expect(reg.officials.every((o) => o.status === "active" && o.config_version === 1)).toBe(true);
    const o = hub.ctx.registry.officialOf("menxia.jishizhong_a")!;
    expect(o.official_id).toBe(seedOfficialId("menxia.jishizhong_a"));
    expect(o.name).toBe("薛中立");
    expect(o.model).toBe(hub.ctx.modelsCfg.default_model);
    expect(reg.models.length).toBe(hub.ctx.modelsCfg.models.length);
    expect(reg.halted).toBe(false);
    expect(JSON.stringify(reg)).not.toContain("dk_"); // 名册不泄露 token

    const budget = await hub.emperor.budgetStatus();
    expect(budget.budgets.find((b) => b.scope === "global")?.daily_tokens).toBe(30_000_000);
    expect(budget.budgets.find((b) => b.scope === "post:menxia.shilang")?.daily_tokens).toBe(3_000_000);

    const schedules = await hub.emperor.schedules();
    const titles = schedules.map((s) => `${s.owner}|${s.title}`);
    expect(titles).toContain("post:zhengshitang.zhongshuling|早朝汇总");
    expect(schedules.every((s) => s.status === "active" && s.next_run_at! > hub.clock.t && s.jitter_seconds === 120)).toBe(true);
  });

  it("写出 tokens.json（0600）", () => {
    const f = join(hub.dataDir, "shared", "tokens.json");
    const t = JSON.parse(readFileSync(f, "utf8"));
    expect(Object.keys(t.depts)).toHaveLength(11);
    expect(t.gateway).toBe(hub.tokens.gateway);
    expect(t.control).toBe(hub.tokens.control);
    expect(t.sandbox).toBeTruthy();
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("健康检查", async () => {
    const h = await hub.emperor.health();
    expect(h.ok).toBe(true);
    expect(h.role).toBe("hub");
    expect(h.details).toHaveProperty("delivery_lag");
    expect(h.details).toHaveProperty("tokens_last_hour", 0);
  });

  it("未知接口 404 JSON；非 /api 路径 SPA 回退", async () => {
    const r = await raw(hub, "GET", "/api/nope");
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe("not_found");
    const r2 = await raw(hub, "GET", "/court/some/page");
    expect(r2.status).toBe(200);
  });

  it("鉴权：未知 token 401；冒用他部职位 403；网关取 tokens", async () => {
    expect((await raw(hub, "GET", "/api/registry", { token: "nope" })).status).toBe(401);
    const tok = hub.ctx.registry.deptToken("zhongshu")!;
    expect((await raw(hub, "GET", "/api/registry", { token: tok, post: "menxia.shilang" })).status).toBe(403);
    expect((await raw(hub, "GET", "/api/registry", { token: tok, post: "zhongshu.shilang" })).status).toBe(200);
    expect(resolvePrincipal(hub.ctx, `Bearer ${tok}`, "zhongshu.sheren_a")).toEqual({ kind: "dept", dept: "zhongshu", post: "zhongshu.sheren_a" });
    await expectStatus(hub.emperor.internalTokens(), 403);
    const map = await hub.gateway.internalTokens();
    expect(map[tok]).toBe("zhongshu");
  });

  it("重启幂等：token、官员不变，不重复播种定时任务", async () => {
    const before = hub.ctx.registry.snapshot();
    const tokBefore = hub.ctx.registry.deptToken("hubu");
    const nSched = hub.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schedules")!.n;
    await hub.close();
    const again = await startHub({ dataDir: hub.dataDir });
    try {
      expect(again.ctx.registry.deptToken("hubu")).toBe(tokBefore);
      expect(again.tokens.gateway).toBe(hub.tokens.gateway);
      expect(again.ctx.registry.snapshot().officials.map((o) => o.official_id)).toEqual(before.officials.map((o) => o.official_id));
      expect(again.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schedules")!.n).toBe(nSched);
      expect(again.ctx.registry.version()).toBe(before.version);
    } finally {
      await again.close();
    }
    hub = await startHub({ dataDir: hub.dataDir });
  });
});
