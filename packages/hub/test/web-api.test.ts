// Web 补充接口：trace 用量合计、模型池元数据、状态变化 SSE（不入库）、服务事件 from/to、SPA 回退。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CourtEvent, LedgerEntry, OfficialStatus } from "@court/shared";
import { createHub } from "../src/main.ts";
import { CONFIG_DIR, deadDeptOverrides, startHub, type TestHub } from "./helpers.ts";

function entry(hub: TestHub, k: string, post: string, tokens: number, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "",
    idem_key: k,
    ts: hub.clock.t,
    post_id: post,
    official_id: "",
    dept: hub.ctx.registry.post(post)?.dept ?? "",
    purpose: "turn",
    provider: "p",
    model: "m",
    input: tokens - 1,
    output: 1,
    cache_read: 0,
    cache_write: 0,
    total_tokens: tokens,
    cost: tokens / 1e6,
    duration_ms: 1,
    ok: true,
    ...extra,
  };
}

/** 读 SSE 直到条件满足，返回事件与每帧是否带 id */
async function readSse(res: Response, until: (evs: CourtEvent[]) => boolean, timeoutMs = 4000) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: { ev: CourtEvent; id?: string }[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !until(frames.map((f) => f.ev))) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), deadline - Date.now()))]);
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let id: string | undefined;
        let data: string | undefined;
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) id = line.slice(4);
          if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (data) frames.push({ ev: JSON.parse(data), id });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

describe("Web 补充接口", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("GET /api/ledger/trace/:id：合计不受 1000 条上限影响，按职位、按轮次", async () => {
    const rows: LedgerEntry[] = [];
    for (let i = 0; i < 1200; i++) rows.push(entry(hub, `tr1:${i}`, i % 3 ? "zhongshu.sheren_a" : "menxia.shilang", 10, { trace_id: "tr_big", turn_id: `tn_${i % 4}` }));
    rows.push(entry(hub, "other", "zhongshu.sheren_a", 999, { trace_id: "tr_other" }));
    rows.push(entry(hub, "noturn", "zhongshu.sheren_a", 5, { trace_id: "tr_big" }));
    await hub.gateway.ledgerAppend(rows.slice(0, 1000));
    await hub.gateway.ledgerAppend(rows.slice(1000));
    const u = await hub.emperor.ledgerTrace("tr_big");
    expect(u).toMatchObject({ trace_id: "tr_big", calls: 1201, total_tokens: 12005, output: 1201 });
    expect(u.cost).toBeCloseTo(12005 / 1e6, 9);
    expect(u.by_post.map((p) => p.post_id).sort()).toEqual(["menxia.shilang", "zhongshu.sheren_a"]);
    expect(u.by_post.reduce((s, p) => s + p.calls, 0)).toBe(1201);
    expect(u.by_post.find((p) => p.post_id === "menxia.shilang")!.dept).toBe("menxia");
    const turns = new Set(u.by_turn.map((t) => t.turn_id));
    expect(turns).toEqual(new Set(["tn_0", "tn_1", "tn_2", "tn_3", ""]));
    expect(u.by_turn.reduce((s, t) => s + t.total_tokens, 0)).toBe(12005);
    const empty = await hub.emperor.ledgerTrace("tr_none");
    expect(empty).toMatchObject({ calls: 0, total_tokens: 0, cost: 0, by_post: [], by_turn: [] });
  });

  it("状态里的今日俸禄以账本为准（部门重启后内存计数归零也不丢）", async () => {
    const st: OfficialStatus = { post_id: "menxia.shilang", dept: "menxia", state: "idle", last_progress_at: hub.clock.t, turns_last_hour: 0, tokens_today: 0, updated_at: 0 };
    await hub.as("menxia.shilang").heartbeat([st]);
    const s = (await hub.emperor.statuses()).find((x) => x.post_id === "menxia.shilang")!;
    expect(s.tokens_today).toBe(400 * 10); // 上一用例：1200 条中 i%3==0 的 400 条记在 menxia.shilang
  });

  it("GET /api/models/meta：任命门槛与权重", async () => {
    const m = await hub.emperor.modelsMeta();
    expect(m.fitness_threshold).toBe(hub.ctx.modelsCfg.fitness_threshold);
    expect(m.default_model).toBe(hub.ctx.modelsCfg.default_model);
    expect(m.grader_model).toBeTruthy();
    expect(Object.keys(m.fitness_weights).length).toBeGreaterThan(0);
  });

  it("心跳状态变化：推 SSE status.changed（无 id、不入库）；状态不变不推", async () => {
    const res = await fetch(`${hub.emperorUrl}/api/stream`);
    const c = hub.as("zhongshu.sheren_b");
    const st: OfficialStatus = { post_id: "zhongshu.sheren_b", dept: "zhongshu", state: "thinking", status_text: "拟稿中", last_progress_at: hub.clock.t, turns_last_hour: 0, tokens_today: 0, updated_at: 0 };
    setTimeout(() => {
      void (async () => {
        await c.heartbeat([st]);
        await c.heartbeat([st]); // 不变：不推
        await c.heartbeat([{ ...st, state: "waiting", status_text: undefined }]);
      })();
    }, 100);
    const frames = await readSse(res, (evs) => evs.filter((e) => e.type === "status.changed").length >= 2);
    const changes = frames.filter((f) => f.ev.type === "status.changed");
    expect(changes).toHaveLength(2);
    expect(changes[0].id).toBeUndefined();
    expect(changes[0].ev.id).toBeLessThan(0);
    expect(changes[0].ev).toMatchObject({ actor: "post:zhongshu.sheren_b", dept: "zhongshu", data: { from: null, to: "thinking", status_text: "拟稿中" } });
    expect(changes[1].ev.data).toMatchObject({ from: "thinking", to: "waiting" });
    expect((await hub.emperor.events({ type: "status." })).length).toBe(0);
  });

  it("服务事件带 from/to", async () => {
    const r = await hub.as("gongbu.langzhong").callService({ caller: "post:gongbu.langzhong", target: "dept:libu_rites", service: "polish", input: "文稿" });
    await hub.as(r.routed_to!).serviceResult(r.id, { post: r.routed_to!, ok: true, output: "润色稿" });
    const evs = await hub.emperor.events({ type: "service." });
    const req = evs.find((e) => e.type === "service.requested" && e.subject_id === r.id)!;
    expect(req.data).toMatchObject({ from: "post:gongbu.langzhong", to: `post:${r.routed_to}`, service: "polish", request_id: r.id });
    const done = evs.find((e) => e.type === "service.done" && e.subject_id === r.id)!;
    expect(done.data).toMatchObject({ from: `post:${r.routed_to}`, to: "post:gongbu.langzhong", ok: true });
  });
});

describe("皇帝端口 SPA 回退", () => {
  it("客户端路由回退 index.html；静态文件照常；未知 /api 仍 404 JSON", async () => {
    if (!process.env.DEPT_URL_OVERRIDES) process.env.DEPT_URL_OVERRIDES = deadDeptOverrides();
    const dataDir = mkdtempSync(join(tmpdir(), "court-spa-"));
    const webDir = join(dataDir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
    const hub = await createHub({ dataDir, configDir: CONFIG_DIR, port: 0, emperorPort: 0, hostname: "127.0.0.1", startLoops: false, webDir, gatewayUrl: "http://127.0.0.1:9" });
    try {
      for (const p of ["/", "/edicts/ed_abc123", "/officials/zhongshu.sheren_a", "/assets", "/depts/libu"]) {
        const res = await fetch(hub.emperorUrl + p);
        expect(res.status, p).toBe(200);
        expect(await res.text(), p).toContain("<div id=root>");
      }
      const js = await fetch(hub.emperorUrl + "/assets/app.js");
      expect(await js.text()).toBe("console.log(1)");
      const api = await fetch(hub.emperorUrl + "/api/nope");
      expect(api.status).toBe(404);
      expect((await api.json()).code).toBe("not_found");
    } finally {
      await hub.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
