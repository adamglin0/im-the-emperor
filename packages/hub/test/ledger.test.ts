import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LedgerEntry } from "@court/shared";
import { startHub, expectStatus, type TestHub } from "./helpers.ts";

function entry(hub: TestHub, k: string, post: string, tokens: number, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "",
    idem_key: k,
    ts: hub.clock.t,
    post_id: post,
    official_id: hub.ctx.registry.officialOf(post)?.official_id ?? "",
    dept: hub.ctx.registry.post(post)?.dept ?? "",
    purpose: "turn",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    input: tokens - 10,
    output: 10,
    cache_read: 0,
    cache_write: 0,
    total_tokens: tokens,
    cost: tokens / 1e6,
    duration_ms: 100,
    ok: true,
    ...extra,
  };
}

describe("账本与预算", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("网关记账幂等；非网关被拒；汇总与查询", async () => {
    await expectStatus(hub.as("hubu.shangshu").ledgerAppend([entry(hub, "x", "hubu.shangshu", 1)]), 403);
    const r1 = await hub.gateway.ledgerAppend([entry(hub, "t1:0", "zhongshu.sheren_a", 1000), entry(hub, "t1:1", "zhongshu.sheren_b", 500)]);
    expect(r1.inserted).toBe(2);
    const r2 = await hub.gateway.ledgerAppend([entry(hub, "t1:0", "zhongshu.sheren_a", 1000)]);
    expect(r2.inserted).toBe(0);
    const sum = await hub.emperor.ledgerSummary({ group: "dept" });
    expect(sum.find((r) => r.key === "zhongshu")).toMatchObject({ calls: 2, total_tokens: 1500, input: 1480, output: 20 });
    const hours = await hub.emperor.ledgerSummary({ group: "hour" });
    expect(hours[0].key).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00$/);
    const rows = await hub.emperor.ledger({ post: "zhongshu.sheren_a" });
    expect(rows).toHaveLength(1);
    expect(hub.ctx.ledger.usageToday("dept:zhongshu").tokens).toBe(1500);
  });

  it("超预算拒绝：首次生成户部待办与来信（每日一次）", async () => {
    await hub.emperor.setBudget({ actor: "emperor", scope: "post:libu_rites.langzhong", daily_tokens: 5000 });
    await hub.gateway.ledgerAppend([entry(hub, "r1", "libu_rites.langzhong", 4500)]);
    expect((await hub.gateway.budgetCheck({ post_id: "libu_rites.langzhong", estimate_tokens: 400 })).allowed).toBe(true);
    const deny = await hub.gateway.budgetCheck({ post_id: "libu_rites.langzhong", estimate_tokens: 1000 });
    expect(deny).toMatchObject({ allowed: false, reason: "BUDGET_EXCEEDED: post:libu_rites.langzhong", scope: "post:libu_rites.langzhong" });
    await hub.gateway.budgetCheck({ post_id: "libu_rites.langzhong", estimate_tokens: 1000 });
    const ns = (await hub.emperor.notifications({ status: "pending" })).filter((n) => n.category === "budget");
    expect(ns).toHaveLength(1);
    const hubuMsgs = (await hub.emperor.searchMessages({ q: "预算熔断" })).filter((m) => m.subject.includes("libu_rites.langzhong"));
    expect(hubuMsgs).toHaveLength(1);
    expect(hub.ctx.registry.post(hubuMsgs[0].to.slice(5))!.dept).toBe("hubu");

    // 增拨：日额翻倍
    await hub.emperor.resolveNotification(ns[0].id, { option: "raise" });
    expect((await hub.emperor.budgetStatus()).budgets.find((b) => b.scope === "post:libu_rites.langzhong")!.daily_tokens).toBe(10_000);
    expect((await hub.gateway.budgetCheck({ post_id: "libu_rites.langzhong", estimate_tokens: 1000 })).allowed).toBe(true);
  });

  it("trace 预算与成本预算", async () => {
    await hub.emperor.setBudget({ actor: "emperor", scope: "trace:tr_edict1", daily_tokens: 100 });
    await hub.gateway.ledgerAppend([entry(hub, "e1", "gongbu.langzhong", 90, { trace_id: "tr_edict1" })]);
    const r = await hub.gateway.budgetCheck({ post_id: "gongbu.langzhong", trace_id: "tr_edict1", estimate_tokens: 20 });
    expect(r.reason).toBe("BUDGET_EXCEEDED: trace:tr_edict1");
    await hub.emperor.setBudget({ actor: "emperor", scope: "dept:yushitai", daily_cost: 0.001 });
    await hub.gateway.ledgerAppend([entry(hub, "c1", "yushitai.dafu", 2000)]);
    expect((await hub.gateway.budgetCheck({ post_id: "yushitai.jiancha", estimate_tokens: 1 })).reason).toBe("BUDGET_EXCEEDED: dept:yushitai");
  });

  it("罢朝：一律拒绝", async () => {
    await hub.emperor.halt(true);
    expect(await hub.gateway.budgetCheck({ post_id: "zhongshu.sheren_a", estimate_tokens: 1 })).toEqual({ allowed: false, reason: "HALTED" });
    await hub.emperor.halt(false);
    expect((await hub.gateway.budgetCheck({ post_id: "zhongshu.sheren_a", estimate_tokens: 1 })).allowed).toBe(true);
  });

  it("官员设预算：须 budget_set；上调超 50% 走审批", async () => {
    await expectStatus(hub.as("gongbu.shangshu").setBudget({ actor: "post:gongbu.shangshu", scope: "dept:gongbu", daily_tokens: 1 }), 403);
    const duzhi = hub.as("hubu.duzhi_langzhong");
    const small = await duzhi.setBudget({ actor: "post:hubu.duzhi_langzhong", scope: "post:gongbu.langzhong", daily_tokens: 4_000_000 });
    expect(small).toMatchObject({ scope: "post:gongbu.langzhong", daily_tokens: 4_000_000 });
    const big = await duzhi.setBudget({ actor: "post:hubu.duzhi_langzhong", scope: "post:gongbu.langzhong", daily_tokens: 10_000_000 });
    expect(big).toMatchObject({ status: "pending_approval" });
    const ap = (await hub.emperor.approvals("pending")).find((a) => a.id === (big as { approval_id: string }).approval_id)!;
    await hub.emperor.resolveNotification(ap.notification_id, { option: "approve" });
    expect((await hub.emperor.budgetStatus()).budgets.find((b) => b.scope === "post:gongbu.langzhong")!.daily_tokens).toBe(10_000_000);
    await expectStatus(hub.emperor.setBudget({ actor: "emperor", scope: "post:nope", daily_tokens: 1 }), 400);
  });
});
