import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHub, expectStatus, type TestHub } from "./helpers.ts";
import type { ScheduleServiceExt } from "../src/services/schedules.ts";

describe("定时任务", () => {
  let hub: TestHub;
  const svc = () => hub.ctx.schedules as ScheduleServiceExt;
  beforeAll(async () => {
    // 固定在北京时间 2026-10-26 10:00:00
    hub = await startHub({ t: Date.parse("2026-10-26T02:00:00Z") });
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("校验：最小间隔、owner 权限、cron 段数", async () => {
    const a = hub.as("gongbu.langzhong");
    await expectStatus(a.createSchedule({ actor: "post:gongbu.langzhong", owner: "post:gongbu.langzhong", title: "太频繁", spec: { every_seconds: 60 }, payload: "x" }), 400);
    await expectStatus(a.createSchedule({ actor: "post:gongbu.langzhong", owner: "post:gongbu.shilang", title: "替别人建", spec: { cron: "0 9 * * *" }, payload: "x" }), 403);
    await expectStatus(a.createSchedule({ actor: "post:gongbu.langzhong", owner: "post:gongbu.langzhong", title: "六段", spec: { cron: "0 0 9 * * *" }, payload: "x" }), 400);
    await expectStatus(a.createSchedule({ actor: "post:gongbu.langzhong", owner: "post:gongbu.langzhong", title: "两种", spec: { cron: "0 9 * * *", every_seconds: 3600 }, payload: "x" }), 400);
  });

  it("官员建高频（<15 分钟）→ 待批；批准后生效", async () => {
    const a = hub.as("gongbu.langzhong");
    const s = await a.createSchedule({ actor: "post:gongbu.langzhong", owner: "dept:gongbu", title: "巡检构建", spec: { every_seconds: 600 }, payload: "检查构建" });
    expect(s.status).toBe("pending_approval");
    expect(s.next_run_at).toBeUndefined();
    const ap = (await hub.emperor.approvals("pending")).find((x) => x.type === "schedule" && x.payload.schedule_id === s.id)!;
    await hub.emperor.resolveNotification(ap.notification_id, { option: "approve" });
    const after = svc().get(s.id)!;
    expect(after.status).toBe("active");
    expect(after.next_run_at).toBe(hub.clock.t + 600_000);
  });

  it("tick：到点投递；未处理则跳过并计 missed；处理后恢复；cron 按北京时间", async () => {
    const owner = "post:hubu.zhushi";
    const s = await hub.emperor.createSchedule({ actor: "emperor", owner, title: "每日对账", spec: { cron: "30 10 * * *" }, payload: "对账" });
    expect(s.status).toBe("active");
    expect(s.next_run_at).toBe(Date.parse("2026-10-26T02:30:00Z")); // 北京 10:30

    hub.clock.t = s.next_run_at!;
    const runs = svc().tick(hub.clock.t).filter((r) => r.schedule_id === s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("fired");
    const box = hub.ctx.messages.inbox("hubu.zhushi", 0, 100);
    const msg = box.items.find((i) => i.message.id === runs[0].message_id)!;
    expect(msg.message).toMatchObject({ kind: "schedule", subject: "每日对账", body: "对账", from: "system:scheduler" });
    expect(msg.message.meta).toMatchObject({ schedule_id: s.id });
    expect(msg.delivery.wakes).toBe(true);
    const s1 = svc().get(s.id)!;
    expect(s1.run_count).toBe(1);
    expect(s1.next_run_at).toBe(Date.parse("2026-10-27T02:30:00Z"));

    // 第二天到点，昨天那条还没 ack → 跳过
    hub.clock.t = s1.next_run_at!;
    const r2 = svc().tick(hub.clock.t).find((r) => r.schedule_id === s.id)!;
    expect(r2.outcome).toBe("skipped_unhandled");
    expect(svc().get(s.id)!.missed_count).toBe(1);

    // ack 后第三天正常触发
    hub.ctx.messages.ack("hubu.zhushi", hub.ctx.messages.latestSeq("hubu.zhushi"));
    hub.clock.t = svc().get(s.id)!.next_run_at!;
    expect(svc().tick(hub.clock.t).find((r) => r.schedule_id === s.id)!.outcome).toBe("fired");
    expect((await hub.emperor.scheduleRuns(s.id)).map((r) => r.outcome)).toEqual(["fired", "skipped_unhandled", "fired"]);
  });

  it("宕机补跑只补一次（catchup）；at 触发后过期；手动触发；停用；删除", async () => {
    const owner = "post:libu_rites.zhuke_langzhong";
    const s = await hub.emperor.createSchedule({ actor: "emperor", owner, title: "整点翻译", spec: { cron: "0 * * * *" }, payload: "翻译" });
    // 停机 5 小时
    hub.clock.t = s.next_run_at! + 5 * 3600_000 + 1000;
    const runs = svc().tick(hub.clock.t).filter((r) => r.schedule_id === s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("catchup");
    expect(svc().get(s.id)!.next_run_at).toBeGreaterThan(hub.clock.t);
    expect(svc().tick(hub.clock.t).filter((r) => r.schedule_id === s.id)).toHaveLength(0);

    const at = await hub.emperor.createSchedule({ actor: "emperor", owner: "dept:bingbu", title: "一次性", spec: { at: hub.clock.t + 3600_000 }, payload: "演练" });
    hub.clock.t += 3600_000;
    const r = svc().tick(hub.clock.t).find((x) => x.schedule_id === at.id)!;
    expect(r.outcome).toBe("fired");
    expect(hub.ctx.registry.post(hub.ctx.messages.get(r.message_id!)!.to.slice(5))!.dept).toBe("bingbu");
    expect(svc().get(at.id)!.status).toBe("expired");

    const manual = await hub.emperor.triggerSchedule(s.id, "emperor");
    expect(manual.outcome).toBe("manual");

    const paused = await hub.emperor.updateSchedule(s.id, { actor: "emperor", enabled: false });
    expect(paused.status).toBe("paused");
    expect(paused.next_run_at).toBeUndefined();
    const resumed = await hub.emperor.updateSchedule(s.id, { actor: "emperor", enabled: true });
    expect(resumed.status).toBe("active");

    await expectStatus(hub.as("bingbu.shangshu").deleteSchedule(s.id, "post:bingbu.shangshu"), 403);
    await hub.emperor.deleteSchedule(s.id, "emperor");
    expect(svc().get(s.id)).toBeUndefined();
  });

  it("每 owner 上限", async () => {
    const a = hub.as("xingbu.langzhong");
    for (let i = 0; i < 10; i++) await a.createSchedule({ actor: "post:xingbu.langzhong", owner: "post:xingbu.langzhong", title: `任务${i}`, spec: { cron: `${i} 9 * * *` }, payload: "x" });
    await expectStatus(a.createSchedule({ actor: "post:xingbu.langzhong", owner: "post:xingbu.langzhong", title: "第十一", spec: { cron: "30 9 * * *" }, payload: "x" }), 400);
  });
});
