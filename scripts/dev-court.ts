// 本地演示：进程内起整座朝廷（mock 大脑，零成本），皇帝/Web 端口固定 8001，托管 packages/web/dist。
// 用法：npm run build:web && npx tsx scripts/dev-court.ts [--reseed]
//   数据目录 data-dev（保留）；首次启动（或 --reseed）时播一批朝务：议事→照准、测封驳诏令、定时任务、服务调用、口谕。
//   Ctrl-C 退朝。环境变量 EMPEROR_PORT 可改端口，DEV_DATA_DIR 可改数据目录。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Notification } from "@court/shared";
import { startCourt, until, type Court } from "../tests/harness.ts";

const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(root, process.env.DEV_DATA_DIR ?? "data-dev");
const webDir = resolve(root, "packages/web/dist");
const emperorPort = Number(process.env.EMPEROR_PORT ?? 8001);
const reseed = process.argv.includes("--reseed");

const log = (...a: unknown[]) => console.log(`[dev-court ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...a);

async function pending(court: Court, pred: (n: Notification) => boolean, what: string, timeoutMs = 180_000) {
  return until(what, async () => (await court.emperor.notifications({ status: "pending", limit: 200 })).find(pred), timeoutMs);
}

/** 播种朝务：各项并行，互不阻塞；失败只记日志 */
async function seed(court: Court): Promise<void> {
  const e = court.emperor;
  const step = (name: string, fn: () => Promise<unknown>) =>
    fn().then(
      () => log(`✔ ${name}`),
      (err) => log(`✘ ${name}：${(err as Error).message}`),
    );
  await Promise.all([
    step("政事堂议事 → 结论 → 照准颁旨", async () => {
      const d = await e.emperorCouncil({ content: "朕欲令礼部将《劝学》首段译为英文，诸卿以为如何？" });
      const concl = await pending(court, (n) => n.category === "council_conclusion" && n.related?.id === d.deliberation.id, "议事结论");
      await e.resolveNotification(concl.id, { option: "approve", comment: "准" });
    }),
    step("颁旨（测封驳）", () => e.emperorEdict({ title: "测封驳：整理术语表", intent: "令礼部整理朝廷常用术语表（测封驳）", skip_review: false })),
    step("定时任务（户部午间核账）并立即触发", async () => {
      const s = await e.createSchedule({ actor: "emperor", owner: "post:hubu.duzhi_langzhong", title: "演示：午间核账", spec: { every_seconds: 3600 }, payload: "核对今日账目，有异常上报", jitter_seconds: 0 });
      await e.triggerSchedule(s.id, "emperor");
    }),
    step("服务调用（吏部请礼部润色）", async () => {
      const r = await court.as("libu.shilang").callService({ caller: "post:libu.shilang", target: "dept:libu_rites", service: "polish", input: "臣某某谨奏：今岁吏部考课已毕。", idem_key: "dev-polish-1" });
      await until("服务办结", async () => ((await e.serviceRequest(r.id)).state === "done" ? true : undefined), 120_000);
    }),
    step("资产（礼部术语表，两版）", async () => {
      const c = court.as("libu_rites.shangshu");
      const base = { actor: "post:libu_rites.shangshu", owner: "dept:libu_rites", path: "glossary/术语表.md", mime: "text/markdown", visibility: "court" as const };
      await c.putAsset({ ...base, content: "# 朝廷常用术语\n\n- 诏令：皇帝下达的正式命令\n- 封驳：门下省驳回诏书草稿\n", idem_key: "dev-asset-1" });
      await c.putAsset({ ...base, content: "# 朝廷常用术语\n\n- 诏令：皇帝下达的正式命令\n- 封驳：门下省驳回诏书草稿，附逐条意见\n- 复奏：尚书省办结后回报\n", idem_key: "dev-asset-2" });
    }),
    step("口谕（兵部尚书回奏）", async () => {
      await e.emperorOral({ to: "post:bingbu.shangshu", content: "兵部尚书，报一报今日兵部诸事。", requires_reply: true });
      await until("兵部尚书回奏", async () => ((await e.emperorInbox({ from: "post:bingbu.shangshu" })).length > 0 ? true : undefined), 120_000);
    }),
  ]);
}

async function main() {
  if (!existsSync(webDir)) log(`警告：${webDir} 不存在，请先 npm run build:web`);
  const fresh = !existsSync(resolve(dataDir, "hub"));
  const court = await startCourt({ mode: "mock", fast: true, dataDir, keepData: true, emperorPort, webDir });
  log(`皇城已开：${court.hub.emperorUrl}（数据 ${dataDir}）`);

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    log(`${sig}：退朝中…`);
    const t = setTimeout(() => process.exit(1), 15_000);
    t.unref();
    await court.close().catch((err) => log("退朝出错", err));
    log("已退朝");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const existing = await court.emperor.edicts({ limit: 1 });
  if (fresh || reseed || existing.length === 0) {
    log("播种朝务…");
    await seed(court);
    log("播种完毕。");
  } else {
    log("已有朝务，跳过播种（--reseed 可再播一批）。");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
