// 真实模型浸泡测试（对已运行的朝廷，皇帝端 HTTP）：多部门协作圣旨 + 科举 + 观察空转与成本。
// 用法：npx tsx scripts/soak-real.ts [URL=http://127.0.0.1:8001] [分钟=30]
import { HubClient, sleepMs } from "@court/shared";

const url = process.argv[2] ?? "http://127.0.0.1:8001";
const minutes = Number(process.argv[3] ?? 30);
const em = new HubClient({ baseUrl: url, timeoutMs: 30_000 });
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${s}`);

const edict = await em.emperorEdict({
  title: "算素数并成文",
  intent:
    "令兵部在沙箱中用 Python 实际运行程序，统计 1 到 1000 之间素数的个数并给出最大的五个；令工部据此写一篇简短说明文档（Markdown，含程序代码与结果），发布为资产；令刑部核验结果是否正确。务求真实运行，不得臆测。",
  budget_tokens: 5_000_000,
  deadline_minutes: 90,
});
log(`颁旨 ${edict.id}`);

// 科举：考一个候选模型
const models = await em.models();
const cand = models.find((m) => m.status === "candidate");
if (cand) {
  const s = await em.startExam({ model_key: cand.key, actor: "emperor" });
  log(`科举开考 ${cand.key} 会话 ${s.id}`);
}

let lastState = "";
let lastEv = 0;
let reported = false;
const seenNotif = new Set<string>();
while (Date.now() - t0 < minutes * 60_000) {
  const d = await em.edict(edict.id).catch(() => undefined);
  if (d && d.edict.state !== lastState) {
    lastState = d.edict.state;
    log(`诏令 → ${lastState}（草稿 ${d.drafts.length}，审议 ${d.reviews.length}，任务 ${d.tasks.map((t) => `${t.dept}:${t.state}`).join(" ")}）`);
  }
  const evs = await em.events({ since_id: lastEv, limit: 300 }).catch(() => []);
  for (const e of evs) {
    lastEv = Math.max(lastEv, e.id);
    if (/^(tool\.error|error|gateway\.|budget_block|turn\.capped|acl\.denied|task\.state|exam\.)/.test(e.type)) log(`  · ${e.type} ${e.actor} ${e.summary.slice(0, 160)}`);
  }
  for (const n of await em.notifications({ status: "pending", limit: 100 }).catch(() => [])) {
    if (seenNotif.has(n.id)) continue;
    seenNotif.add(n.id);
    log(`  ◆ 待办 [${n.category}/${n.kind}] ${n.title.slice(0, 80)} ← ${n.from}`);
    if (n.category === "report" && n.related?.id === edict.id) {
      log(`复奏：\n${n.body.slice(0, 1500)}`);
      await em.resolveNotification(n.id, { option: "accept", comment: "览" });
      reported = true;
    }
  }
  if (reported && Date.now() - t0 > 10 * 60_000) break;
  await sleepMs(5000);
}

const d = await em.edict(edict.id);
log(`最终 ${d.edict.state}`);
for (const t of d.tasks) log(`  任务 ${t.dept} ${t.state}「${t.title}」\n      ${(t.result ?? "").slice(0, 600).replace(/\n/g, "\n      ")}`);
const tr = await em.ledgerTrace(edict.id).catch(() => undefined);
if (tr) log(`本诏用量：calls=${tr.calls} tokens=${tr.total_tokens} cost=$${tr.cost.toFixed(4)}`);
const all = await em.ledgerSummary({ group: "post", since: t0 });
log(`期间总用量（按职位，前 15）：`);
for (const r of all.sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 15)) log(`  ${r.key.padEnd(32)} calls=${r.calls} tokens=${r.total_tokens} $${r.cost.toFixed(4)}`);
const sessions = await em.examSessions();
for (const s of sessions.slice(0, 3)) log(`科举 ${s.model_key} ${s.state} total=${s.total ?? "-"} ${JSON.stringify(s.scores ?? {})}`);
