// 礼部·文字规范工具：术语表、文风指南（存为礼部部门资产，朝廷可见）
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Asset } from "@court/shared";
import type { ToolContext } from "../tool-context.ts";
import { READ_CHUNK } from "./assets.ts";
import { ToolError, defineTool, ok, selfAddr, sliceByBytes, writeMeta } from "./_util.ts";

export const RITES_OWNER = "dept:libu_rites";
export const GLOSSARY_PATH = "glossary.json";
export const STYLE_GUIDE_PATH = "style-guide.md";

export interface GlossaryEntry {
  term: string;
  translation: string;
  note?: string;
}

export const DEFAULT_STYLE_GUIDE = `# 朝廷文书文风指南（礼部默认版）

1. 用简体中文；专有名词、代码、命令保留原文。
2. 公文体：先结论后理由；条目化；每条一事。称皇帝为「陛下」，自称「臣」。
3. 诏书正文：目标、约束、验收标准、期限四要素齐备；用语庄重简洁，不用华而不实的骈俪。
4. 白话体：面向执行者，短句、主动语态，写清谁在何时做什么。
5. 数字：统一用阿拉伯数字；时间写「YYYY-MM-DD HH:mm（北京时间）」。
6. 术语以礼部术语表为准（glossary_get）；首次出现的外来术语附原文。
7. Markdown：标题不超过三级；列表用「-」；代码用代码块。
8. 禁止：空话套话、无依据的断言、对未完成事项称「已完成」。
`;

export function ritesTools(ctx: ToolContext): AgentTool<any>[] {
  const self = selfAddr(ctx);

  async function findAsset(path: string): Promise<Asset | undefined> {
    const list = await ctx.hub.assets({ viewer: self, owner: RITES_OWNER, q: path, limit: 50 });
    return list.find((a) => a.path === path);
  }

  async function readGlossary(): Promise<{ asset?: Asset; entries: GlossaryEntry[] }> {
    const asset = await findAsset(GLOSSARY_PATH);
    if (!asset) return { entries: [] };
    const c = await ctx.hub.asset(asset.id, self);
    try {
      const data = JSON.parse(c.content) as GlossaryEntry[] | { entries: GlossaryEntry[] };
      return { asset, entries: Array.isArray(data) ? data : (data.entries ?? []) };
    } catch {
      throw new ToolError(`术语表资产 ${asset.id} 内容不是合法 JSON`, "请用 glossary_update 重新写入完整术语表（会覆盖）。");
    }
  }

  return [
    defineTool({
      name: "glossary_get",
      label: "查术语表",
      description: "查阅礼部术语表（译名统一）：术语、译名、备注。可按关键词过滤。翻译、润色前先查。",
      parameters: Type.Object({
        q: Type.Optional(Type.String({ description: "关键词（匹配术语、译名或备注）" })),
      }),
      async run(p) {
        const { asset, entries } = await readGlossary();
        const q = p.q?.trim().toLowerCase();
        const list = q ? entries.filter((e) => [e.term, e.translation, e.note ?? ""].some((s) => s.toLowerCase().includes(q))) : entries;
        return ok(asset ? `术语表（${asset.id} v${asset.latest_version}）共 ${entries.length} 条，匹配 ${list.length} 条` : "术语表尚未建立", list.slice(0, 300), list.length > 300 ? { hint: "条目过多，请用 q 过滤。" } : undefined);
      },
    }),

    defineTool({
      name: "glossary_update",
      label: "修订术语表",
      description: "增补或修订术语表：按 term 合并（同名覆盖译名与备注）；remove 中列出的术语将删除。存为礼部部门资产 glossary.json（朝廷可见，版本化）。",
      parameters: Type.Object({
        entries: Type.Array(
          Type.Object({
            term: Type.String({ description: "术语原文" }),
            translation: Type.String({ description: "统一译名" }),
            note: Type.Optional(Type.String({ description: "备注（语境、用法）" })),
          }),
          { description: "要新增或修订的条目" },
        ),
        remove: Type.Optional(Type.Array(Type.String({ description: "术语原文" }), { description: "要删除的术语" })),
      }),
      async run(p, call) {
        const { entries } = await readGlossary();
        const map = new Map(entries.map((e) => [e.term, e]));
        let added = 0;
        let updated = 0;
        for (const e of p.entries) {
          if (!e.term.trim()) continue;
          if (map.has(e.term)) updated++;
          else added++;
          map.set(e.term, { term: e.term, translation: e.translation, ...(e.note ? { note: e.note } : {}) });
        }
        let removed = 0;
        for (const t of p.remove ?? []) if (map.delete(t)) removed++;
        const list = [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
        const a = await ctx.hub.putAsset({
          ...writeMeta(ctx, call.toolCallId),
          actor: self,
          owner: RITES_OWNER,
          path: GLOSSARY_PATH,
          content: JSON.stringify(list, null, 1),
          encoding: "utf8",
          mime: "application/json",
          visibility: "court",
        });
        return ok(`术语表已更新（${a.id} v${a.latest_version}）：新增 ${added}、修订 ${updated}、删除 ${removed}，共 ${list.length} 条`);
      },
    }),

    defineTool({
      name: "style_guide_get",
      label: "文风指南",
      description: "查阅朝廷文书文风指南（礼部维护的 style-guide.md；尚未建立时返回内置默认版）。润色、撰写正式文书前参考。",
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "分段读取的字符偏移，默认 0" })),
      }),
      async run(p) {
        const asset = await findAsset(STYLE_GUIDE_PATH);
        const text = asset ? (await ctx.hub.asset(asset.id, self)).content : DEFAULT_STYLE_GUIDE;
        const part = sliceByBytes(text, p.offset ?? 0, READ_CHUNK);
        return ok(
          `${asset ? `文风指南（${asset.id} v${asset.latest_version}）` : "文风指南（内置默认版，礼部尚未发布）"}\n${part.text}`,
          undefined,
          part.next !== undefined ? { hint: `未读完：style_guide_get {offset: ${part.next}}` } : asset ? undefined : { hint: "礼部可用 asset_write {path: \"style-guide.md\", owner: \"department\", visibility: \"court\"} 发布正式版。" },
        );
      },
    }),
  ];
}
