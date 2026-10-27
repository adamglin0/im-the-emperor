import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "@court/shared";
import { startHub, expectStatus, raw, type TestHub } from "./helpers.ts";

describe("消息投递", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("官员发信：to 唤醒、cc 不唤醒，seq 单调；收件箱与 ack", async () => {
    const a = hub.as("zhongshu.sheren_a");
    const res = await a.sendMessage({
      from: "post:zhongshu.sheren_a",
      to: "post:menxia.jishizhong_a",
      cc: ["post:menxia.shilang"],
      kind: "chat",
      subject: "请教封驳理由",
      body: "第二条的期限写法是否可行？",
      requires_reply: true,
    });
    expect(res.routed_to).toEqual(["menxia.jishizhong_a", "menxia.shilang"]);
    expect(res.message.hop_count).toBe(1);
    expect(res.message.trace_id).toMatch(/^tr_/);
    expect(res.message.thread_id).toMatch(/^th_/);

    const m = hub.as("menxia.jishizhong_a");
    const inbox = await m.inbox("menxia.jishizhong_a", 0);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].delivery).toMatchObject({ seq: 1, wakes: true, role: "to" });
    const cc = await m.inbox("menxia.shilang", 0);
    expect(cc.items[0].delivery).toMatchObject({ wakes: false, role: "cc" });

    // 回复：继承线程与 trace，hop+1
    const r2 = await m.sendMessage({
      from: "post:menxia.jishizhong_a",
      to: "post:zhongshu.sheren_a",
      kind: "chat",
      subject: "回复",
      body: "可行，但需写明具体日期。",
      reply_to: res.message.id,
    });
    expect(r2.message.thread_id).toBe(res.message.thread_id);
    expect(r2.message.trace_id).toBe(res.message.trace_id);
    expect(r2.message.hop_count).toBe(2);
    expect((await hub.emperor.thread(res.message.thread_id)).map((x) => x.id)).toEqual([res.message.id, r2.message.id]);

    await m.ackInbox("menxia.jishizhong_a", 99);
    expect(await m.inboxCursor("menxia.jishizhong_a")).toEqual({ acked_seq: 1, latest_seq: 1 });

    // 部门不能读他部收件箱
    await expectStatus(m.inbox("zhongshu.sheren_a", 0), 403);
    // 发信人必须是 acting post
    await expectStatus(m.sendMessage({ from: "post:menxia.shilang", to: "post:zhongshu.shilang", kind: "chat", subject: "x", body: "冒名" }), 403);

    const found = await hub.emperor.searchMessages({ post: "zhongshu.sheren_a", q: "期限" });
    expect(found.map((x) => x.id)).toContain(res.message.id);
  });

  it("fyi 与 no_wake 不唤醒；部门地址按路由分派", async () => {
    const a = hub.as("shangshu.youpuye");
    const fyi = await a.sendMessage({ from: "post:shangshu.youpuye", to: "post:bingbu.shangshu", kind: "fyi", subject: "知会", body: "下周有演练任务。" });
    const box = await hub.emperor.inbox("bingbu.shangshu", 0);
    expect(box.items.find((i) => i.message.id === fyi.message.id)!.delivery.wakes).toBe(false);

    const dep = await a.sendMessage({ from: "post:shangshu.youpuye", to: "dept:libu_rites", kind: "service_request", subject: "润色", body: "请润色此稿。" });
    expect(dep.routed_to).toHaveLength(1);
    expect(hub.ctx.registry.post(dep.routed_to[0])!.dept).toBe("libu_rites");
    expect(dep.message.to).toBe(`post:${dep.routed_to[0]}`);
  });

  it("给皇帝的信：不投递，产生 message.to_emperor 事件，出现在皇帝来信", async () => {
    const a = hub.as("hubu.duzhi_langzhong");
    const r = await a.sendMessage({ from: "post:hubu.duzhi_langzhong", to: "emperor", kind: "chat", subject: "奏", body: "臣启陛下：今日用量正常。" });
    expect(r.routed_to).toEqual([]);
    const ev = await hub.emperor.events({ type: "message.to_emperor" });
    expect(ev.some((e) => e.subject_id === r.message.id)).toBe(true);
    expect((await hub.emperor.emperorInbox()).some((m) => m.id === r.message.id)).toBe(true);
  });

  it("客套短信不投递", async () => {
    const r = await hub.as("gongbu.langzhong").sendMessage({ from: "post:gongbu.langzhong", to: "post:gongbu.shangshu", kind: "chat", subject: "re", body: "收到，谢谢！" });
    expect(r.routed_to).toEqual([]);
    expect(r.message.meta?.dropped).toBe("courtesy");
  });

  it("风暴防护：跳数、同线程来回、抄送人数", async () => {
    const a = hub.as("xingbu.langzhong");
    const e = await expectStatus(
      a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shangshu", kind: "chat", subject: "x", body: "转来转去的信", parent_hop: LIMITS.maxHopCount }),
      429,
    );
    expect(e.code).toBe("rate_limited");

    const first = await a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shilang", kind: "chat", subject: "讨论", body: "第 1 封：关于测试用例的覆盖范围" });
    for (let i = 2; i <= LIMITS.pairThreadMaxPer10Min; i++) {
      await a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shilang", kind: "chat", subject: "讨论", body: `第 ${i} 封：继续讨论覆盖范围`, thread_id: first.message.thread_id });
    }
    await expectStatus(
      a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shilang", kind: "chat", subject: "讨论", body: "再来一封长一些的讨论信", thread_id: first.message.thread_id }),
      429,
    );
    // 10 分钟后恢复
    hub.clock.t += 11 * 60_000;
    await a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shilang", kind: "chat", subject: "讨论", body: "隔了一阵再讨论覆盖范围", thread_id: first.message.thread_id });

    const many = hub.ctx.registry.posts().slice(0, LIMITS.broadcastMaxRecipients + 1).map((p) => `post:${p.post_id}`);
    await expectStatus(a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shangshu", cc: many, kind: "chat", subject: "群发", body: "群发通知内容" }), 400);
  });

  it("地址校验：不存在的职位、system 地址、给自己发信", async () => {
    const a = hub.as("bingbu.shilang");
    await expectStatus(a.sendMessage({ from: "post:bingbu.shilang", to: "post:nope.x", kind: "chat", subject: "x", body: "hello there" }), 400);
    await expectStatus(a.sendMessage({ from: "post:bingbu.shilang", to: "system:hub", kind: "chat", subject: "x", body: "hello there" }), 400);
    await expectStatus(a.sendMessage({ from: "post:bingbu.shilang", to: "post:bingbu.shilang", kind: "chat", subject: "x", body: "hello there" }), 400);
    await expectStatus(a.sendMessage({ from: "post:bingbu.shilang", to: "post:bingbu.shangshu", kind: "weird" as never, subject: "x", body: "hello there" }), 400);
    const r = await raw(hub, "POST", "/api/messages", { body: "{bad json" as unknown });
    expect(r.status).toBe(400);
  });

  it("幂等：同 idem_key 重放返回同一消息，不重复投递", async () => {
    const a = hub.as("libu.shilang");
    const req = { from: "post:libu.shilang", to: "post:libu.shangshu", kind: "chat" as const, subject: "x", body: "请示配置调整事宜", idem_key: "libu.shilang:t1:c1" };
    const r1 = await a.sendMessage(req);
    const r2 = await a.sendMessage(req);
    expect(r2.message.id).toBe(r1.message.id);
    const box = await hub.emperor.inbox("libu.shangshu", 0);
    expect(box.items.filter((i) => i.message.id === r1.message.id)).toHaveLength(1);
  });

  it("notifyPost：系统通知可投递到职位，wakes=false 时不唤醒", () => {
    const m = hub.ctx.messages.notifyPost("yushitai.jiancha", "audit", "稽查发现", "发现空转", { wakes: false });
    expect(m.from).toBe("system:hub");
    const box = hub.ctx.messages.inbox("yushitai.jiancha", 0, 10);
    expect(box.items.find((i) => i.message.id === m.id)!.delivery.wakes).toBe(false);
  });
});
