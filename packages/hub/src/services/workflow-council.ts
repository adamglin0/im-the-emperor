// 政事堂议事协议：皇帝发言开场次 → 主持人先发言 → 宰相按序各发言一次 → 主持人决定再议一轮或总结 → 皇帝定夺。
import { LIMITS, newId, type Address, type CouncilConclusion, type CouncilEntry, type Deliberation, type Stance } from "@court/shared";
import type { DeliberationDetail } from "@court/shared";
import { bad, forbidden, invalidState, versionConflict } from "../ctx.ts";
import { checkVersion, clip, postAddress } from "./flow-util.ts";
import type { FlowEnv } from "./workflow-env.ts";
import type { EdictFlow } from "./workflow-edicts.ts";

export const deliberationSpanId = (id: string) => `sp_${id}`;

const STANCE_LABEL: Record<Stance, string> = { support: "赞成", oppose: "反对", reserve: "保留", pass: "弃权" };

export function createCouncilFlow(env: FlowEnv, edicts: EdictFlow) {
  const { ctx, store } = env;
  const reg = () => ctx.registry;

  function members(): { chair: string | undefined; members: string[] } {
    const posts = reg().posts("zhengshitang");
    const memberPosts = posts.filter((p) => p.roles.includes("member")).map((p) => p.post_id);
    const chair = reg().pickPost("zhengshitang", ["chair"]) ?? memberPosts[0];
    const all = chair && !memberPosts.includes(chair) ? [chair, ...memberPosts] : memberPosts;
    return { chair, members: all };
  }

  const isActive = (p: string) => reg().officialOf(p)?.status === "active";

  /** 发言顺序：主持人先，其余按名册；缺位者跳过（否则每个空缺都要等看门狗 10 分钟超时弃权） */
  function speakingOrder(d: Deliberation): string[] {
    return [d.chair_post, ...d.members.filter((m) => m !== d.chair_post)].filter(isActive);
  }

  /** 主持人缺位 → 改由在任的主持角色或首位在任宰相主持；返回是否更换 */
  function refreshChair(d: Deliberation): boolean {
    if (isActive(d.chair_post)) return false;
    const next = reg().pickPost("zhengshitang", ["chair"]) ?? d.members.find(isActive);
    if (!next || next === d.chair_post) return false;
    const old = d.chair_post;
    d.chair_post = next;
    if (!d.members.includes(next)) d.members = [next, ...d.members];
    ctx.transition("deliberation", d.id, d.state, d.state, "system:workflow", `主持人 ${old} 缺位，改由 ${next} 主持`, d.trace_id);
    return true;
  }

  function recorders(): string[] {
    return reg()
      .posts("zhengshitang")
      .filter((p) => p.roles.includes("recorder"))
      .map((p) => p.post_id);
  }

  function tokenSpent(d: Deliberation): number {
    try {
      return ctx.db.get<{ n: number | null }>("SELECT SUM(total_tokens) AS n FROM ledger WHERE trace_id = ?", d.trace_id)?.n ?? d.token_spent;
    } catch {
      return d.token_spent;
    }
  }

  function detail(id: string): DeliberationDetail {
    const d = store.getDeliberation(id);
    return { deliberation: { ...d, token_spent: tokenSpent(d) }, entries: store.listEntries(id) };
  }

  function renderSession(d: Deliberation): string {
    const entries = store.listEntries(d.id).filter((e) => e.session_no === d.session_no);
    const recent = entries.slice(-12);
    const lines = recent.map((e) => `- [第${e.round}轮] ${e.author}${e.stance ? `（${STANCE_LABEL[e.stance]}）` : ""}：${clip(e.content, 600)}`);
    return lines.join("\n");
  }

  function wakeSpeaker(d: Deliberation, post: string | undefined): void {
    if (!post) return;
    const isChair = post === d.chair_post;
    env.notify(
      post,
      "council",
      `政事堂议事：轮到你发言（第 ${d.session_no} 场第 ${d.round} 轮）`,
      [
        `议题：${d.topic}`,
        `本场发言记录：\n${renderSession(d)}`,
        isChair && d.round === 1 ? "你是执政事笔（主持人），请先开议发言，再由诸相依次发言。" : "",
        "请用 council_speak 发言（stance: support/oppose/reserve），或 council_pass 弃权。每轮只能发言一次。",
      ]
        .filter(Boolean)
        .join("\n\n"),
      { trace_id: d.trace_id, meta: { deliberation_id: d.id } },
    );
  }

  function wakeChairAllSpoken(d: Deliberation): void {
    const canNext = d.round < d.max_rounds;
    env.notify(
      d.chair_post,
      "council",
      `政事堂第 ${d.round} 轮发言已毕，请主持定夺`,
      [
        `议题：${d.topic}`,
        `本场发言记录：\n${renderSession(d)}`,
        canNext
          ? `请决定：再议一轮（council_next_round，最多 ${d.max_rounds} 轮），或总结奏请陛下（council_conclude，可附 proposed_edict）。`
          : `已达最大轮次 ${d.max_rounds}，请总结奏请陛下（council_conclude，可附 proposed_edict）。`,
      ].join("\n\n"),
      { trace_id: d.trace_id, meta: { deliberation_id: d.id } },
    );
  }

  function addEntry(d: Deliberation, author: Address, content: string, stance?: Stance): CouncilEntry {
    const entry: CouncilEntry = {
      id: newId("ce"),
      deliberation_id: d.id,
      session_no: d.session_no,
      round: d.round,
      author,
      stance,
      content,
      created_at: env.now(),
    };
    store.createEntry(entry);
    ctx.events.emit({
      type: "council.entry",
      actor: author,
      trace_id: d.trace_id,
      span_id: deliberationSpanId(d.id),
      subject_type: "deliberation",
      subject_id: d.id,
      summary: `${stance ? STANCE_LABEL[stance] + "：" : ""}${clip(content, 120)}`,
      data: { session_no: d.session_no, round: d.round, stance },
    });
    return entry;
  }

  /** 发言后推进队列；队列空则唤醒主持人 */
  function advance(d: Deliberation, spoke: string): void {
    d.speaker_queue = d.speaker_queue.filter((p) => p !== spoke);
    d.current_speaker = d.speaker_queue[0];
    if (d.current_speaker) wakeSpeaker(d, d.current_speaker);
    else wakeChairAllSpoken(d);
  }

  function requireOpen(d: Deliberation): void {
    if (d.state !== "open") throw invalidState(`议事 ${d.id} 当前状态为 ${d.state}，不在议中`);
  }

  function requireChair(d: Deliberation, post: string | undefined, action: string): void {
    if (post !== d.chair_post) throw forbidden(`只有主持人（执政事笔 ${d.chair_post}）可以${action}，你是 ${post ?? "皇帝"}`);
  }

  function close(d: Deliberation, actor: Address, reason: string): void {
    const from = d.state;
    d.state = "closed";
    d.current_speaker = undefined;
    d.speaker_queue = [];
    ctx.transition("deliberation", d.id, from, "closed", actor, reason, d.trace_id);
    ctx.events.endSpan(deliberationSpanId(d.id), "ok", { closed: reason });
  }

  const flow = {
    detail,

    list(state: string | undefined, limit: number): Deliberation[] {
      return store.listDeliberations(state, limit).map((d) => ({ ...d, token_spent: tokenSpent(d) }));
    },

    emperorSpeaks(content: string, deliberationId?: string): Deliberation {
      const text = (content ?? "").trim();
      if (!text) throw bad("皇帝发言内容不能为空");
      return ctx.db.tx(() => {
        const now = env.now();
        let d: Deliberation;
        if (deliberationId) {
          d = store.getDeliberation(deliberationId);
          const from = d.state;
          // 续议：旧的议决待办作废（否则陛下事后批「照准」会在新一场议事中途颁旨/结束议事）
          store.dismissPendingNotifications(d.id, ["council_conclusion"]);
          refreshChair(d);
          d.state = "open";
          d.session_no += 1;
          d.conclusion = undefined;
          ctx.transition("deliberation", d.id, from, "open", "emperor", `陛下续议（第 ${d.session_no} 场）`, d.trace_id);
          ctx.events.span({ span_id: deliberationSpanId(d.id), trace_id: d.trace_id, kind: "deliberation", name: d.topic, actor: "emperor", status: "running" });
        } else {
          const { chair, members: ms } = members();
          if (!chair) throw invalidState("政事堂无人在任（缺主持人），无法开议");
          const id = newId("dl");
          const traceId = newId("tr");
          d = {
            id,
            trace_id: traceId,
            topic: clip(text.replace(/\s+/g, " "), 80),
            state: "open",
            chair_post: chair,
            members: ms,
            session_no: 1,
            round: 1,
            max_rounds: LIMITS.councilMaxRounds,
            speaker_queue: [],
            token_spent: 0,
            version: 0,
            created_at: now,
            updated_at: now,
          };
          store.createDeliberation(d);
          ctx.transition("deliberation", id, "new", "open", "emperor", "陛下开议", traceId);
          ctx.events.span({ span_id: deliberationSpanId(id), trace_id: traceId, kind: "deliberation", name: d.topic, actor: "emperor", status: "running", started_at: now, attrs: { deliberation_id: id } });
        }
        d.round = 1;
        d.speaker_queue = speakingOrder(d);
        d.current_speaker = d.speaker_queue[0];
        addEntry(d, "emperor", text);
        store.updateDeliberation(d, now);
        wakeSpeaker(d, d.current_speaker);
        return d;
      });
    },

    speak(id: string, post: string, stance: Stance, content: string, expectedVersion?: number): DeliberationDetail {
      return ctx.db.tx(() => {
        const d = store.getDeliberation(id);
        checkVersion(expectedVersion, d.version, versionConflict);
        requireOpen(d);
        if (d.current_speaker !== post) {
          throw invalidState(
            d.current_speaker
              ? `尚未轮到你发言。当前发言人：${d.current_speaker}；本轮待发言：${d.speaker_queue.join("、")}`
              : `尚未轮到你发言。本轮发言已毕，等待主持人 ${d.chair_post} 决定再议或总结`,
          );
        }
        addEntry(d, postAddress(post), content, stance);
        advance(d, post);
        store.updateDeliberation(d, env.now());
        return detail(id);
      });
    },

    nextRound(id: string, post: string, note?: string): DeliberationDetail {
      return ctx.db.tx(() => {
        const d = store.getDeliberation(id);
        requireOpen(d);
        requireChair(d, post, "开启下一轮");
        if (d.speaker_queue.length) throw invalidState(`本轮尚有人未发言：${d.speaker_queue.join("、")}；待全部发言后再开下一轮`);
        if (d.round >= d.max_rounds) throw invalidState(`已达最大轮次 ${d.max_rounds}，请用 council_conclude 总结`);
        d.round += 1;
        d.speaker_queue = speakingOrder(d);
        d.current_speaker = d.speaker_queue[0];
        if (note?.trim()) addEntry(d, postAddress(post), `【主持】${note.trim()}`);
        ctx.transition("deliberation", id, "open", "open", postAddress(post), `开启第 ${d.round} 轮`, d.trace_id);
        store.updateDeliberation(d, env.now());
        wakeSpeaker(d, d.current_speaker);
        return detail(id);
      });
    },

    conclude(
      id: string,
      post: string,
      input: { summary: string; dissent: string; proposed_edict?: { title: string; intent: string }; confidence: number },
    ): DeliberationDetail {
      return ctx.db.tx(() => {
        const d = store.getDeliberation(id);
        requireOpen(d);
        requireChair(d, post, "总结议事");
        const now = env.now();
        const conclusion: CouncilConclusion = {
          summary: input.summary,
          dissent: input.dissent,
          proposed_edict: input.proposed_edict,
          confidence: input.confidence,
          concluded_by: post,
          at: now,
        };
        d.conclusion = conclusion;
        d.state = "concluded";
        d.current_speaker = undefined;
        d.speaker_queue = [];
        ctx.transition("deliberation", id, "open", "concluded", postAddress(post), "主持人总结", d.trace_id);
        addEntry(d, postAddress(post), `【结论】${input.summary}${input.dissent ? `\n【异议】${input.dissent}` : ""}`);
        const options = [
          ...(input.proposed_edict ? [{ id: "approve", label: "照准颁旨" }] : []),
          { id: "reconvene", label: "再议" },
          { id: "shelve", label: "搁置" },
        ];
        env.askEmperor(
          {
            kind: "action_required",
            category: "council_conclusion",
            title: `政事堂议决：${d.topic}`,
            body: [
              `结论：${input.summary}`,
              `异议：${input.dissent || "无"}`,
              input.proposed_edict ? `建议旨意：${input.proposed_edict.title}\n${input.proposed_edict.intent}` : "",
              `置信度：${Math.round(input.confidence * 100)}%`,
            ]
              .filter(Boolean)
              .join("\n\n"),
            from: postAddress(post),
            related: { type: "deliberation", id },
            options,
            trace_id: d.trace_id,
          },
          { type: "council_conclusion", deliberation_id: id },
        );
        for (const r of recorders()) {
          env.notify(
            r,
            "council",
            `请整理议事纪要：${d.topic}`,
            `政事堂议事 ${id} 已总结。请把议事过程与结论整理成纪要，存为政事堂部门资产（asset_write owner=dept:zhengshitang）。\n\n结论：${input.summary}\n异议：${input.dissent || "无"}\n\n发言记录：\n${renderSession(d)}`,
            { trace_id: d.trace_id, meta: { deliberation_id: id } },
          );
        }
        store.updateDeliberation(d, now);
        return detail(id);
      });
    },

    /** 皇帝对议决的批复 */
    resolveConclusion(id: string, option: string, comment: string): void {
      ctx.db.tx(() => {
        const d = store.getDeliberation(id);
        if (d.state !== "concluded" && option !== "reconvene") throw invalidState(`议事 ${id} 当前状态为 ${d.state}（已续议或已结束），此议决已过时；请撤下本待办`);
        if (option === "approve") {
          const pe = d.conclusion?.proposed_edict;
          if (!pe) throw invalidState(`议事 ${id} 的结论没有建议旨意，不能照准颁旨`);
          const intent = comment.trim() ? `${pe.intent}\n【朕批】${comment.trim()}` : pe.intent;
          edicts.issueEdict({ title: pe.title, intent, deliberation_id: id, actor: "emperor" });
          close(d, "emperor", "陛下照准颁旨");
          store.updateDeliberation(d, env.now());
        } else if (option === "reconvene") {
          flow.emperorSpeaks(comment.trim() || "请诸卿再议", id);
        } else if (option === "shelve") {
          close(d, "emperor", `陛下搁置${comment.trim() ? "：" + comment.trim() : ""}`);
          store.updateDeliberation(d, env.now());
        } else {
          throw bad(`未知选项 ${option}；可选：approve / reconvene / shelve`);
        }
      });
    },

    /** 看门狗：发言人超时 → 视为弃权并推进 */
    autoPassIfStale(d: Deliberation, now: number, turnMs: number): boolean {
      if (d.state !== "open" || !d.current_speaker || now - d.updated_at < turnMs) return false;
      return ctx.db.tx(() => {
        const cur = store.getDeliberation(d.id);
        if (cur.state !== "open" || cur.current_speaker !== d.current_speaker || now - cur.updated_at < turnMs) return false;
        const post = cur.current_speaker!;
        addEntry(cur, postAddress(post), "（超时未发言，视为弃权）", "pass");
        advance(cur, post);
        store.updateDeliberation(cur, now);
        return true;
      });
    },

    /**
     * 看门狗：本轮发言已毕而主持人逾时未定夺。
     * 第 1 个周期：主持人缺位则改派并唤醒，否则再提醒一次；第 2 个周期：系统据发言记录代为总结，奏请陛下（再议/搁置）。
     */
    chairStale(d: Deliberation, now: number, turnMs: number): boolean {
      if (d.state !== "open" || d.current_speaker || d.speaker_queue.length || now - d.updated_at < turnMs) return false;
      return ctx.db.tx(() => {
        const cur = store.getDeliberation(d.id);
        if (cur.state !== "open" || cur.current_speaker || cur.speaker_queue.length) return false;
        const key = `council_chair:${cur.id}:${cur.session_no}:${cur.round}`;
        const level = store.getMarkLevel(key);
        if (level === 0) {
          store.setMark(key, 1, now);
          refreshChair(cur);
          wakeChairAllSpoken(cur);
          store.updateDeliberation(cur, now);
          return true;
        }
        if (now - cur.updated_at < turnMs) return false;
        store.setMark(key, 2, now);
        const summary = `主持人 ${cur.chair_post} 逾时未总结，由系统据本场发言记录奏请陛下定夺。\n${renderSession(cur)}`;
        const conclusion: CouncilConclusion = { summary, dissent: "", confidence: 0, concluded_by: "system:watchdog", at: now };
        cur.conclusion = conclusion;
        cur.state = "concluded";
        ctx.transition("deliberation", cur.id, "open", "concluded", "system:watchdog", "主持人逾时未定夺，系统代为奏请", cur.trace_id);
        addEntry(cur, "system:watchdog", `【结论】${summary}`);
        env.askEmperor(
          {
            kind: "action_required",
            category: "council_conclusion",
            title: `政事堂议事逾时未决：${cur.topic}`,
            body: summary,
            from: "system:watchdog",
            related: { type: "deliberation", id: cur.id },
            options: [
              { id: "reconvene", label: "再议" },
              { id: "shelve", label: "搁置" },
            ],
            trace_id: cur.trace_id,
          },
          { type: "council_conclusion", deliberation_id: cur.id },
        );
        store.updateDeliberation(cur, now);
        return true;
      });
    },

    listOpen(): Deliberation[] {
      return store.listDeliberations("open", 200);
    },
  };
  return flow;
}

export type CouncilFlow = ReturnType<typeof createCouncilFlow>;
