// 真实模型冒烟：进程内起整座朝廷（LLM_MODE=real），颁一道小圣旨，打印流转直到复奏或超时。
// 用法：npx tsx scripts/smoke-real.ts [数据目录] [超时分钟]
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { sleepMs } from "@court/shared";
import { startCourt } from "../tests/harness.ts";

const dataDir = resolve(process.argv[2] ?? "data-smoke");
const timeoutMin = Number(process.argv[3] ?? 20);
mkdirSync(dataDir, { recursive: true });

const court = await startCourt({ dataDir, mode: "real", keepData: true });
console.log(`朝廷已开：皇帝端 ${court.hub.emperorUrl}  数据 ${dataDir}`);
const em = court.emperor;

const edict = await em.emperorEdict({
  title: "译《劝学》首句为英文",
  intent: "令礼部将《劝学》首句「君子曰：学不可以已。」译为英文，并附一句白话释义，交付即可。",
  budget_tokens: 2_000_000,
  deadline_minutes: 60,
});
console.log(`颁旨 ${edict.id}`);

const t0 = Date.now();
let lastState = "";
let lastEvent = 0;
while (Date.now() - t0 < timeoutMin * 60_000) {
  const d = await em.edict(edict.id);
  if (d.edict.state !== lastState) {
    lastState = d.edict.state;
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] 诏令状态 → ${lastState}  草稿${d.drafts.length} 审议${d.reviews.length} 任务${d.tasks.length}`);
  }
  const evs = await em.events({ trace_id: edict.id, since_id: lastEvent, limit: 200 });
  for (const e of evs) {
    lastEvent = Math.max(lastEvent, e.id);
    if (/^(turn\.end|edict\.|task\.|message\.sent|tool\.error|llm\.error)/.test(e.type)) console.log(`   · ${e.type} ${e.actor} ${e.summary.slice(0, 120)}`);
  }
  const pend = await em.notifications({ status: "pending", limit: 50 });
  const rep = pend.find((n) => n.category === "report" && n.related?.id === edict.id);
  if (rep) {
    console.log(`复奏到达：${rep.title}\n${rep.body.slice(0, 800)}`);
    await em.resolveNotification(rep.id, { option: "accept", comment: "览" });
    break;
  }
  for (const n of pend.filter((n) => ["escalation", "remonstrance", "clarification"].includes(n.category) && n.trace_id === edict.id)) {
    console.log(`待办：${n.category} ${n.title} → ${n.options.map((o) => o.id).join("/")}`);
  }
  await sleepMs(3000);
}

const d = await em.edict(edict.id);
console.log(`最终状态 ${d.edict.state}`);
for (const t of d.tasks) console.log(`  任务 ${t.dept} ${t.state} ${t.title}\n    结果：${(t.result ?? "").slice(0, 400)}`);
const sum = await em.ledgerSummary({ group: "post", since: t0 });
console.log("用量（按职位）：");
for (const r of sum) console.log(`  ${r.key} calls=${r.calls} tokens=${r.total_tokens} cost=$${r.cost.toFixed(5)}`);
await court.close();
process.exit(0);
