import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "@court/shared";
import { startHub, expectStatus, type TestHub } from "./helpers.ts";

describe("上奏、审批、吏部配置、户部人事", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("上奏 → 皇帝批复 → 回写发起人（唤醒）；每小时限流", async () => {
    const a = hub.as("gongbu.shangshu");
    const n = await a.petition({ post: "gongbu.shangshu", kind: "action_required", title: "请拨木料", body: "营造需要更多资源。" });
    expect(n.status).toBe("pending");
    expect(n.options.map((o) => o.id)).toContain("approve");
    const done = await hub.emperor.resolveNotification(n.id, { option: "approve", comment: "准" });
    expect(done.status).toBe("resolved");
    await expectStatus(hub.emperor.resolveNotification(n.id, { option: "approve" }), 409);
    const box = await hub.emperor.inbox("gongbu.shangshu", 0);
    const reply = box.items.find((i) => i.message.kind === "notification_reply")!;
    expect(reply.delivery.wakes).toBe(true);
    expect(reply.message.from).toBe("emperor");
    expect(reply.message.meta).toMatchObject({ notification_id: n.id, option: "approve" });

    for (let i = 1; i < LIMITS.petitionPerHour; i++) await a.petition({ post: "gongbu.shangshu", kind: "action_required", title: `第${i}本`, body: "..." });
    const e = await expectStatus(a.petition({ post: "gongbu.shangshu", kind: "action_required", title: "又一本", body: "..." }), 429);
    expect(e.message).toContain("合并");
    // 知会另有额度
    await a.petition({ post: "gongbu.shangshu", kind: "fyi", title: "进展", body: "已完成一半。" });
    // 不能冒名上奏
    await expectStatus(a.petition({ post: "gongbu.langzhong", kind: "fyi", title: "x", body: "y" }), 403);
  });

  it("通知去重：同 dedupe_key 只有一条待办", () => {
    const a = hub.ctx.notifications.create({ kind: "action_required", category: "incident", title: "提供商故障", body: "", from: "system:hub", options: [], dedupe_key: "inc:1" });
    const b = hub.ctx.notifications.create({ kind: "action_required", category: "incident", title: "提供商故障", body: "", from: "system:hub", options: [], dedupe_key: "inc:1" });
    expect(b.id).toBe(a.id);
  });

  it("吏部配置：非敏感职位直接生效、版本+1、热加载；改自己被拒；敏感职位走审批", async () => {
    const libu = hub.as("libu.shilang");
    const before = hub.ctx.registry.officialOf("gongbu.langzhong")!;
    const res = await libu.proposeConfig({ actor: "post:libu.shilang", target_post: "gongbu.langzhong", changes: { thinking: "medium", prompt_overrides: "写代码先写测试。" }, reason: "提升代码质量" });
    expect(res.status).toBe("applied");
    expect(res.official!.config_version).toBe(before.config_version + 1);
    const cfg = await hub.emperor.officialConfig("gongbu.langzhong");
    expect(cfg.official.thinking).toBe("medium");
    expect(cfg.system_prompt).toContain("【个人】\n写代码先写测试。");
    expect(cfg.system_prompt).toContain("【本职】");
    expect(cfg.system_prompt).toContain("【同僚】");
    expect(cfg.effective_tool_groups).toContain("workshop");
    const hist = await hub.emperor.configHistory("gongbu.langzhong");
    expect(hist[0].version).toBe(before.config_version + 1);

    await expectStatus(libu.proposeConfig({ actor: "post:libu.shilang", target_post: "libu.shilang", changes: { thinking: "high" }, reason: "自升" }), 403);

    // 授予额外工具组 → 待批
    const p = await libu.proposeConfig({ actor: "post:libu.shilang", target_post: "gongbu.langzhong", changes: { extra_tool_groups: ["justice"] }, reason: "兼任测试" });
    expect(p.status).toBe("pending_approval");
    expect(hub.ctx.registry.hasTool("gongbu.langzhong", "bug_report")).toBe(false);
    const approvals = await hub.emperor.approvals("pending");
    const ap = approvals.find((x) => x.id === p.approval_id)!;
    await hub.emperor.resolveNotification(ap.notification_id, { option: "approve" });
    expect(hub.ctx.registry.hasTool("gongbu.langzhong", "bug_report")).toBe(true);
    expect((await hub.emperor.approvals("approved")).some((x) => x.id === p.approval_id)).toBe(true);

    // 门下（敏感）职位 → 待批；驳回则不生效
    const s = await libu.proposeConfig({ actor: "post:libu.shilang", target_post: "menxia.jishizhong_a", changes: { thinking: "high" }, reason: "审核更细" });
    expect(s.status).toBe("pending_approval");
    const ap2 = (await hub.emperor.approvals("pending")).find((x) => x.id === s.approval_id)!;
    await hub.emperor.resolveNotification(ap2.notification_id, { option: "reject", comment: "不必" });
    expect(hub.ctx.registry.officialOf("menxia.jishizhong_a")!.thinking).toBe("low");

    // 无 config_propose 工具 → 403 + acl.denied 事件
    await expectStatus(hub.as("gongbu.langzhong").proposeConfig({ actor: "post:gongbu.langzhong", target_post: "gongbu.shilang", changes: { thinking: "off" }, reason: "x" }), 403);
    const ev = await hub.emperor.events({ type: "acl.denied" });
    expect(ev.some((e) => e.actor === "post:gongbu.langzhong")).toBe(true);
  });

  it("配置回滚", async () => {
    const libu = hub.as("libu.shangshu");
    const r = await libu.configRollback({ actor: "post:libu.shangshu", post: "gongbu.langzhong", version: 1, reason: "恢复初始" });
    expect(r.status).toBe("applied");
    const o = hub.ctx.registry.officialOf("gongbu.langzhong")!;
    expect(o.thinking).toBe("low");
    expect(o.prompt_overrides).toBe("");
  });

  it("户部人事：皇帝调任直接生效；官员罢免须批准；空缺；新官", async () => {
    const o = hub.ctx.registry.officialOf("bingbu.kubu_langzhong")!;
    const v0 = hub.ctx.registry.version();
    // 先腾出一个空缺：皇帝罢免驾部郎中
    const jiabu = hub.ctx.registry.officialOf("bingbu.jiabu_langzhong")!;
    expect((await hub.emperor.personnel({ actor: "emperor", action: "dismiss", official_id: jiabu.official_id, reason: "裁撤" })).status).toBe("applied");
    expect((await hub.emperor.vacancies()).map((p) => p.post_id)).toContain("bingbu.jiabu_langzhong");
    expect((await hub.emperor.statuses()).find((s) => s.post_id === "bingbu.jiabu_langzhong")!.state).toBe("vacant");

    await hub.emperor.personnel({ actor: "emperor", action: "transfer", official_id: o.official_id, to_post_id: "bingbu.jiabu_langzhong", reason: "调任驿传" });
    expect(hub.ctx.registry.postOf(o.official_id)).toBe("bingbu.jiabu_langzhong");
    expect(hub.ctx.registry.version()).toBeGreaterThan(v0);

    // 户部官员办理：新增官员须批准
    const hubu = hub.as("hubu.shilang");
    const res = await hubu.personnel({ actor: "post:hubu.shilang", action: "new_official", post_id: "bingbu.kubu_langzhong", model: hub.ctx.modelsCfg.default_model, reason: "补缺" });
    expect(res.status).toBe("pending_approval");
    const ap = (await hub.emperor.approvals("pending")).find((a) => a.id === res.approval_id)!;
    expect(ap.type).toBe("new_official");
    await hub.emperor.resolveNotification(ap.notification_id, { option: "approve" });
    const newO = hub.ctx.registry.officialOf("bingbu.kubu_langzhong")!;
    expect(newO.official_id).not.toBe(o.official_id);
    expect(newO.name.length).toBeGreaterThanOrEqual(2);

    // 换模型：未考模型须批准；已考且非敏感直接生效
    const cand = hub.ctx.registry.models().find((m) => m.status === "candidate")!;
    const r2 = await hubu.personnel({ actor: "post:hubu.shilang", action: "set_model", official_id: newO.official_id, model: cand.key, reason: "试用" });
    expect(r2.status).toBe("pending_approval");
    const exam = hub.ctx.registry.model(cand.key)!;
    hub.ctx.registry.saveModel({ ...exam, status: "examined", fitness: { bingbu: 80 } });
    const r3 = await hubu.personnel({ actor: "post:hubu.shilang", action: "set_model", official_id: newO.official_id, model: cand.key, reason: "已考达标" });
    expect(r3.status).toBe("applied");
    expect(hub.ctx.registry.official(newO.official_id)!.model).toBe(cand.key);

    // 无人事工具 → 403
    await expectStatus(hub.as("hubu.duzhi_langzhong").personnel({ actor: "post:hubu.duzhi_langzhong", action: "dismiss", official_id: newO.official_id, reason: "x" }), 403);
    const hist = await hub.emperor.personnelHistory();
    expect(hist.map((h) => h.action)).toEqual(expect.arrayContaining(["dismiss", "transfer", "new_official", "set_model"]));
  });

  it("模型池：皇帝增补 → candidate", async () => {
    const m = await hub.emperor.addModel({ provider: "custom", model_id: "my-model", api: "openai-completions", base_url: "http://x/v1", name: "我的模型" });
    expect(m.key).toBe("custom/my-model");
    expect(["candidate", "examining"]).toContain(m.status);
    await expectStatus(hub.emperor.addModel({ provider: "custom", model_id: "my-model", api: "a", base_url: "b" }), 409);
    await expectStatus(hub.as("libu.shangshu").addModel({ provider: "x", model_id: "y" }), 403);
  });
});
