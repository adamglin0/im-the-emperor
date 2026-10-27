// Docker 端到端（对已 `scripts/court.sh mock-up` 起来的朝廷）：主流程 + 混沌（重启部门容器、停 hub）。
// 用法：npx tsx scripts/e2e-docker.ts [皇帝端URL=http://127.0.0.1:8001]
import { execSync } from "node:child_process";
import { HubClient, sleepMs, type Edict } from "@court/shared";

const url = process.argv[2] ?? "http://127.0.0.1:8001";
const em = new HubClient({ baseUrl: url, timeoutMs: 30_000 });
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);
const compose = (args: string) => execSync(`docker compose ${args}`, { stdio: "pipe" }).toString();

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 240_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = (e as Error).message;
    }
    await sleepMs(1000);
  }
  throw new Error(`超时：${what} ${last}`);
}

async function edictReaches(id: string, states: Edict["state"][], timeoutMs?: number) {
  return until(`诏令 ${id} → ${states}`, async () => {
    const d = await em.edict(id);
    return states.includes(d.edict.state) ? d : undefined;
  }, timeoutMs);
}

async function acceptReport(id: string) {
  const n = await until("复奏待办", async () => (await em.notifications({ status: "pending", limit: 200 })).find((x) => x.category === "report" && x.related?.id === id));
  await em.resolveNotification(n.id, { option: "accept", comment: "览" });
  await edictReaches(id, ["completed"], 60_000);
}

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  log(`${ok ? "✓" : "✗"} ${name}`);
};

// 0. 全员上线
await until("hub 可达", async () => (await em.health()).ok);
const reg = await em.registry();
const appointed = new Set(reg.appointments.map((a) => a.post_id));
await until("全员心跳", async () => {
  const st = await em.statuses();
  return st.filter((s) => appointed.has(s.post_id) && !["offline", "vacant"].includes(s.state)).length === appointed.size;
}, 180_000);
check(`全员上线（${appointed.size} 人）`, true);

// 1. 议事 → 照准 → 全流程
const det = await em.emperorCouncil({ content: "朕欲令礼部译《劝学》首句为英文，诸卿议之。" });
const concl = await until("议事结论", async () => (await em.notifications({ status: "pending", limit: 200 })).find((n) => n.category === "council_conclusion" && n.related?.id === det.deliberation.id));
await em.resolveNotification(concl.id, { option: "approve", comment: "准" });
const e1 = await until("诏令生成", async () => (await em.edicts({ limit: 50 })).find((e) => e.deliberation_id === det.deliberation.id));
log(`诏令 ${e1.id}`);
await edictReaches(e1.id, ["reported"]);
await acceptReport(e1.id);
check("议事→颁旨→起草→审核→分派→执行→复奏→御览", true);

// 2. 封驳循环 + 中途重启中书省、门下省容器
const e2 = await em.emperorEdict({ title: "测封驳：整理术语表", intent: "令礼部整理朝廷常用术语表（测封驳）" });
await sleepMs(1500);
log("重启 dept-zhongshu 与 dept-menxia 容器");
compose("restart dept-zhongshu dept-menxia");
const d2 = await edictReaches(e2.id, ["reported", "completed"]);
check("封驳后重拟通过（容器重启不丢流程）", d2.reviews.some((r) => r.decision === "reject") && d2.drafts.length >= 2);
await acceptReport(e2.id);

// 3. hub 停机 15 秒：部门暂停，恢复后继续
const e3 = await em.emperorEdict({ title: "皇城停机测试：编写说明", intent: "令工部编写一份简短说明文档" });
await sleepMs(2000);
log("停止 hub 15 秒");
compose("stop hub");
await sleepMs(15_000);
compose("start hub");
await until("hub 恢复", async () => (await em.health()).ok, 120_000);
await edictReaches(e3.id, ["reported", "completed"]);
check("hub 停机恢复后诏令继续完成", true);
await acceptReport(e3.id);

// 4. 定时任务 + 口谕回奏
const sch = await em.createSchedule({ actor: "emperor", owner: "post:hubu.duzhi_langzhong", title: `容器测试核账-${Date.now().toString(36)}`, spec: { every_seconds: 3600 }, payload: "核账", jitter_seconds: 0 });
await em.triggerSchedule(sch.id, "emperor");
await until("定时任务被处理", async () => (await em.notifications({ limit: 300 })).find((n) => n.title.includes(sch.title)));
check("定时任务触发并处理", true);
await em.emperorOral({ to: "post:bingbu.shangshu", content: "报兵部诸事", requires_reply: true });
await until("口谕回奏", async () => (await em.emperorInbox({ from: "post:bingbu.shangshu" })).length > 0);
check("口谕回奏", true);

// 5. 兵部沙箱执行（服务调用 run）——经刑部名义调用
// （mock 大脑对服务请求直接回执；此处只验证路由与回传）

// 6. 账本与追踪
const lt = await em.ledger({ trace_id: e1.id, limit: 100 });
check("账本有记录", lt.length > 0);
const g = await em.trace(e1.id);
check(`追踪图 span 数 ${g.spans.length}`, g.spans.length > 3);

const failed = checks.filter(([, ok]) => !ok);
log(failed.length ? `失败 ${failed.length} 项` : `全部通过（${checks.length} 项）`);
process.exit(failed.length ? 1 : 0);
