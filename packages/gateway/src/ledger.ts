// 记账：每次调用一行 LedgerEntry → 磁盘 outbox → hub.ledgerAppend（hub 按 idem_key 去重）。
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { newId, Outbox, type EventIn, type GatewayMeta, type HubClient, type LedgerEntry } from "@court/shared";

type LedgerItem = LedgerEntry & { uid: string };
type EventItem = EventIn;

export interface CallRecord {
  meta: GatewayMeta;
  /** 调用方部门（dept token 推导）；网关 token 调用为 "system" */
  dept: string;
  provider: string;
  model: string;
  startedAt: number;
  message?: AssistantMessage;
  ok: boolean;
  error?: string;
}

export function buildLedgerEntry(r: CallRecord, now = Date.now()): LedgerEntry {
  const u = r.message?.usage;
  const id = newId("led");
  return {
    id,
    idem_key: `${r.meta.turn_id ?? id}:${r.meta.call_idx ?? 0}:${r.meta.purpose}`,
    ts: now,
    post_id: r.meta.post_id,
    official_id: r.meta.official_id ?? "",
    dept: r.meta.dept ?? r.dept,
    trace_id: r.meta.trace_id,
    turn_id: r.meta.turn_id,
    purpose: r.meta.purpose,
    provider: r.provider,
    model: r.model,
    input: u?.input ?? 0,
    output: u?.output ?? 0,
    cache_read: u?.cacheRead ?? 0,
    cache_write: u?.cacheWrite ?? 0,
    total_tokens: u?.totalTokens ?? 0,
    cost: u?.cost?.total ?? 0,
    duration_ms: now - r.startedAt,
    ok: r.ok,
    error: r.error,
  };
}

/** 账本与事件的两个 outbox（共享 DATA_DIR/gateway/） */
export class GatewayRecorder {
  readonly ledger: Outbox<LedgerItem>;
  readonly events: Outbox<EventItem>;

  constructor(dataDir: string, hub: HubClient | undefined) {
    const dir = join(dataDir, "gateway");
    this.ledger = new Outbox<LedgerItem>(join(dir, "outbox-ledger.jsonl"), async (batch) => {
      if (!hub) throw new Error("未配置 HUB_URL");
      await hub.ledgerAppend(batch.map(({ uid: _uid, ...entry }) => entry));
    });
    this.events = new Outbox<EventItem>(join(dir, "outbox-events.jsonl"), async (batch) => {
      if (!hub) throw new Error("未配置 HUB_URL");
      await hub.postEvents(batch);
    });
  }

  start(): void {
    this.ledger.start();
    this.events.start();
  }

  async stop(): Promise<void> {
    await Promise.all([this.ledger.stop(2000), this.events.stop(2000)]);
  }

  record(r: CallRecord): LedgerEntry {
    const entry = buildLedgerEntry(r);
    this.ledger.push({ ...entry, uid: entry.id });
    // 成功调用只记账（dept 侧另有 llm.call 事件）；失败另发一条事件便于驿报与稽查
    if (!entry.ok) {
      this.events.push({
        uid: `ev_${entry.id}`,
        ts: entry.ts,
        type: "gateway.llm_error",
        actor: r.meta.post_id.startsWith("system.") ? `system:${r.meta.post_id.slice(7)}` : `post:${r.meta.post_id}`,
        dept: entry.dept,
        trace_id: entry.trace_id,
        summary: `${entry.provider}/${entry.model} 调用失败：${(entry.error ?? "").slice(0, 200)}`,
        data: { purpose: entry.purpose, turn_id: entry.turn_id, call_idx: r.meta.call_idx, duration_ms: entry.duration_ms, error: entry.error },
      });
    }
    return entry;
  }

  event(e: Omit<EventItem, "uid" | "ts">): void {
    this.events.push({ uid: newId("ev"), ts: Date.now(), ...e });
  }
}
