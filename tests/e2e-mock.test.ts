// 端到端（mock 大脑，零成本）：整座朝廷进程内运行，验证主流程、定时任务、服务调用、预算熔断、罢朝、部门重启。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edict, Notification } from "@court/shared";
import { startCourt, until, type Court } from "./harness.ts";

let court: Court;

beforeAll(async () => {
  court = await startCourt({ fast: true });
}, 120_000);

afterAll(async () => {
  await court?.close();
}, 60_000);

async function pendingNotification(pred: (n: Notification) => boolean, what: string, timeoutMs = 120_000) {
  return until(what, async () => (await court.emperor.notifications({ status: "pending", limit: 200 })).find(pred), timeoutMs);
}

async function edictState(id: string, states: Edict["state"][], timeoutMs = 180_000) {
  return until(`诏令 ${id} 进入 ${states.join("/")}`, async () => {
    const d = await court.emperor.edict(id);
    return states.includes(d.edict.state) ? d : undefined;
  }, timeoutMs);
}

describe("朝廷端到端（mock）", () => {
  it("全员上线：所有在任官员都有心跳", async () => {
    const reg = await court.emperor.registry();
    const appointed = new Set(reg.appointments.map((a) => a.post_id));
    await until("全员心跳", async () => {
      const st = await court.emperor.statuses();
      const online = st.filter((s) => appointed.has(s.post_id) && !["offline", "vacant"].includes(s.state));
      return online.length === appointed.size ? online : undefined;
    }, 60_000);
  }, 90_000);

  it("政事堂议事 → 结论 → 照准颁旨 → 起草 → 审核 → 分派 → 执行 → 复奏 → 御览", async () => {
    const det = await court.emperor.emperorCouncil({ content: "朕欲令礼部将《劝学》首段译为英文，诸卿以为如何？" });
    const delibId = det.deliberation.id;
    const concl = await pendingNotification((n) => n.category === "council_conclusion" && n.related?.id === delibId, "议事结论");
    expect(concl.options.map((o) => o.id)).toContain("approve");
    const d2 = await court.emperor.deliberation(delibId);
    // 每位成员都发过言
    const speakers = new Set(d2.entries.filter((e) => e.author !== "emperor").map((e) => e.author));
    expect(speakers.size).toBeGreaterThanOrEqual(d2.deliberation.members.length);

    await court.emperor.resolveNotification(concl.id, { option: "approve", comment: "准" });
    const edicts = await until("由议事产生的诏令", async () => (await court.emperor.edicts({ limit: 20 })).find((e) => e.deliberation_id === delibId));
    const reported = await edictState(edicts.id, ["reported"]);
    expect(reported.drafts.length).toBeGreaterThanOrEqual(1);
    expect(reported.reviews.some((r) => r.decision === "approve")).toBe(true);
    expect(reported.tasks.length).toBeGreaterThanOrEqual(1);
    expect(reported.tasks.every((t) => ["done", "cancelled", "failed"].includes(t.state))).toBe(true);

    const rep = await pendingNotification((n) => n.category === "report" && n.related?.id === edicts.id, "复奏待御览");
    await court.emperor.resolveNotification(rep.id, { option: "accept", comment: "览" });
    await edictState(edicts.id, ["completed"], 30_000);

    // 追踪图、账本、日志
    const graph = await court.emperor.trace(edicts.id);
    expect(graph.spans.length).toBeGreaterThan(3);
    const ledger = await court.emperor.ledger({ trace_id: edicts.id, limit: 500 });
    expect(ledger.length).toBeGreaterThan(0);
    const offDir = join(court.dataDir, "officials");
    expect(existsSync(offDir)).toBe(true);
    const anyLogs = readdirSync(offDir).some((o) => existsSync(join(offDir, o, "logs")) && readdirSync(join(offDir, o, "logs")).length > 0);
    expect(anyLogs).toBe(true);
  }, 300_000);

  it("门下封驳：草稿被驳回后重拟再审通过", async () => {
    const e = await court.emperor.emperorEdict({ title: "测封驳：整理术语表", intent: "令礼部整理朝廷常用术语表（测封驳）", skip_review: false });
    const d = await edictState(e.id, ["executing", "reported", "completed"]);
    expect(d.reviews.some((r) => r.decision === "reject")).toBe(true);
    expect(d.drafts.length).toBeGreaterThanOrEqual(2);
    expect(d.edict.reject_count).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("定时任务：为官员建定时任务并立即触发，官员醒来处理", async () => {
    const sch = await court.emperor.createSchedule({ actor: "emperor", owner: "post:hubu.duzhi_langzhong", title: "测试核账", spec: { every_seconds: 3600 }, payload: "核对今日账目", jitter_seconds: 0 });
    expect(sch.status).toBe("active");
    const run = await court.emperor.triggerSchedule(sch.id, "emperor");
    expect(run.message_id).toBeTruthy();
    await until("官员处理定时任务（上报进展）", async () =>
      (await court.emperor.notifications({ limit: 200 })).find((n) => n.from === "post:hubu.duzhi_langzhong" && n.title.includes("测试核账")),
    );
    const runs = await court.emperor.scheduleRuns(sch.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("服务调用：吏部官员请礼部润色，结果回传", async () => {
    const caller = court.as("libu.shilang");
    const req = await caller.callService({ caller: "post:libu.shilang", target: "dept:libu_rites", service: "polish", input: "臣某某谨奏：今岁吏部考课已毕。", idem_key: "e2e-polish-1" });
    const done = await until("服务完成", async () => {
      const r = await court.emperor.serviceRequest(req.id);
      return r.state === "done" ? r : undefined;
    });
    expect(done.output).toBeTruthy();
  }, 120_000);

  it("口谕：皇帝对官员下口谕（需回奏），官员回信至御前", async () => {
    await court.emperor.emperorOral({ to: "post:bingbu.shangshu", content: "兵部尚书，报一报今日兵部诸事。", requires_reply: true });
    await until("兵部尚书回奏", async () => (await court.emperor.emperorInbox({ from: "post:bingbu.shangshu" })).length > 0 || undefined);
  }, 120_000);

  it("部门重启：重启中书省后诏令仍能完成", async () => {
    const e = await court.emperor.emperorEdict({ title: "重启测试：编写说明文档", intent: "令工部编写一份系统使用说明" });
    await court.restartDept("zhongshu");
    await edictState(e.id, ["executing", "reported", "completed"]);
  }, 300_000);

  it("预算熔断：某官员预算为 0 时进入停俸，恢复后继续", async () => {
    await court.emperor.setBudget({ actor: "emperor", scope: "post:libu_rites.zhuke_langzhong", daily_tokens: 1 });
    await court.emperor.emperorOral({ to: "post:libu_rites.zhuke_langzhong", content: "将 hello 译为中文", requires_reply: true });
    await until("停俸", async () => (await court.emperor.statuses()).find((s) => s.post_id === "libu_rites.zhuke_langzhong" && s.state === "suspended"), 60_000);
    await court.emperor.setBudget({ actor: "emperor", scope: "post:libu_rites.zhuke_langzhong", daily_tokens: 3_000_000 });
  }, 120_000);

  it("罢朝：全体暂停，复朝后恢复", async () => {
    await court.emperor.halt(true);
    await until("全体暂停", async () => {
      const st = await court.emperor.statuses();
      const active = st.filter((s) => ["thinking", "tool"].includes(s.state));
      return active.length === 0 ? true : undefined;
    }, 60_000);
    const ov = await court.emperor.overview();
    expect(ov.halted).toBe(true);
    await court.emperor.halt(false);
    expect((await court.emperor.overview()).halted).toBe(false);
  }, 120_000);
});

describe("设置：模型提供商（经 hub 转网关）", () => {
  it("列出/自定义/登录/入池校验；部门不可访问", async () => {
    const list = await court.emperor.providers();
    expect(list.find((p) => p.id === "anthropic")?.login_methods).toContain("oauth");

    const info = await court.emperor.saveCustomProvider({ id: "e2e-llm", api: "openai-completions", base_url: "http://127.0.0.1:9/v1", keyless: true, models: [{ id: "m1" }] });
    expect(info).toMatchObject({ kind: "custom", configured: true });
    const evs = await until("provider.saved 事件", async () => {
      const xs = await court.emperor.events({ type: "provider.saved", limit: 10 });
      return xs.length ? xs : undefined;
    }, 10_000);
    expect(evs[0].subject_id).toBe("e2e-llm");

    // 登录会话：作答后完成，hub 记 provider.configured
    const s = await court.emperor.startProviderLogin("mistral", "api_key");
    const waiting = await until("待作答", async () => {
      const x = await court.emperor.providerLogin(s.id);
      return x.state === "awaiting_input" ? x : undefined;
    }, 10_000, 50);
    await court.emperor.answerProviderLogin(s.id, waiting.prompt!.seq, "sk-mistral-e2e-000000000000");
    await until("登录完成", async () => ((await court.emperor.providerLogin(s.id)).state === "done" ? true : undefined), 10_000, 50);
    expect((await court.emperor.providers()).find((p) => p.id === "mistral")).toMatchObject({ configured: true, credential: { key_hint: "…0000" } });
    await court.emperor.logoutProvider("mistral");

    // 入池：网关不认得的拒绝；自定义提供商的目录外模型可入
    await expect(court.emperor.addModel({ provider: "no-such", model_id: "x" })).rejects.toMatchObject({ status: 400 });
    const m = await court.emperor.addModel({ provider: "e2e-llm", model_id: "m2" });
    expect(m.key).toBe("e2e-llm/m2");
    expect(m.context_window).toBe(128_000);

    // 部门身份不可访问
    await expect(court.as("libu.shangshu").providers()).rejects.toMatchObject({ status: 403 });

    await court.emperor.deleteCustomProvider("e2e-llm");
    expect((await court.emperor.providers()).some((p) => p.id === "e2e-llm")).toBe(false);
  }, 60_000);
});

describe("网关管理接口隔离", () => {
  it("部门可读到的网关 token 不能调用管理接口", async () => {
    const { GatewayClient } = await import("@court/shared");
    const { readFileSync } = await import("node:fs");
    const shared = JSON.parse(readFileSync(join(court.dataDir, "shared", "tokens.json"), "utf8"));
    const viaGatewayToken = new GatewayClient({ baseUrl: court.gateway.url, token: shared.gateway, timeoutMs: 5000 });
    await expect(viaGatewayToken.adminProviders()).rejects.toMatchObject({ status: 403 });
  });
});
