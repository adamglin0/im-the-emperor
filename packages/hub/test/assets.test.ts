import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@court/shared";
import { startHub, expectStatus, type TestHub } from "./helpers.ts";

describe("资产", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("个人私产：版本化、sha256、仅本人与陛下可见、分享、访问审计", async () => {
    const me = hub.as("gongbu.langzhong");
    const a1 = await me.putAsset({ actor: "post:gongbu.langzhong", owner: "post:gongbu.langzhong", path: "notes/plan.md", content: "# 计划 v1" });
    expect(a1).toMatchObject({ latest_version: 1, visibility: "private", mime: "text/markdown", sha256: sha256("# 计划 v1") });
    expect(a1.owner_official).toBe(hub.ctx.registry.officialOf("gongbu.langzhong")!.official_id);
    const a2 = await me.putAsset({ actor: "post:gongbu.langzhong", owner: "post:gongbu.langzhong", path: "notes/plan.md", content: "# 计划 v2" });
    expect(a2.id).toBe(a1.id);
    expect(a2.latest_version).toBe(2);
    expect(existsSync(join(hub.dataDir, "hub", "assets", a1.id, "2"))).toBe(true);
    // 相同内容不产生新版本
    expect((await me.putAsset({ actor: "post:gongbu.langzhong", owner: "post:gongbu.langzhong", path: "notes/plan.md", content: "# 计划 v2" })).latest_version).toBe(2);

    expect((await me.asset(a1.id, "post:gongbu.langzhong", 1)).content).toBe("# 计划 v1");
    expect((await hub.emperor.asset(a1.id, "emperor")).content).toBe("# 计划 v2");
    expect((await me.assetVersions(a1.id, "post:gongbu.langzhong")).map((v) => v.version)).toEqual([2, 1]);

    const peer = hub.as("gongbu.shilang");
    await expectStatus(peer.asset(a1.id, "post:gongbu.shilang"), 403);
    expect((await peer.assets({ viewer: "post:gongbu.shilang" })).some((a) => a.id === a1.id)).toBe(false);
    // 他人不能写我的私产
    await expectStatus(peer.putAsset({ actor: "post:gongbu.shilang", owner: "post:gongbu.langzhong", path: "x.md", content: "x" }), 403);

    await expectStatus(peer.shareAsset(a1.id, { actor: "post:gongbu.shilang", with: ["post:gongbu.shilang"] }), 403);
    await me.shareAsset(a1.id, { actor: "post:gongbu.langzhong", with: ["post:gongbu.shilang"] });
    expect((await peer.asset(a1.id, "post:gongbu.shilang")).content).toBe("# 计划 v2");
    expect((await peer.assets({ viewer: "post:gongbu.shilang" })).some((a) => a.id === a1.id)).toBe(true);

    const audit = hub.ctx.db.all<{ action: string }>("SELECT action FROM asset_access WHERE asset_id = ?", a1.id).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(["write", "read", "share"]));
  });

  it("部门资产：部门成员可读写，他部不可；department/court 可见性", async () => {
    const a = hub.as("libu_rites.langzhong");
    const d = await a.putAsset({ actor: "post:libu_rites.langzhong", owner: "dept:libu_rites", path: "glossary.json", content: '{"诏":"edict"}' });
    expect(d.mime).toBe("application/json");
    const b = hub.as("libu_rites.shangshu");
    expect((await b.asset(d.id, "post:libu_rites.shangshu")).content).toBe('{"诏":"edict"}');
    await b.putAsset({ actor: "post:libu_rites.shangshu", owner: "dept:libu_rites", path: "glossary.json", content: '{"诏":"imperial edict"}' });
    await expectStatus(hub.as("bingbu.shangshu").asset(d.id, "post:bingbu.shangshu"), 403);

    // 个人资产设为 department：同部门可见
    const p = await a.putAsset({ actor: "post:libu_rites.langzhong", owner: "post:libu_rites.langzhong", path: "draft.txt", content: "草稿", visibility: "department" });
    expect((await b.asset(p.id, "post:libu_rites.shangshu")).content).toBe("草稿");
    await expectStatus(hub.as("bingbu.shangshu").asset(p.id, "post:bingbu.shangshu"), 403);
    // court：所有人可见
    await a.shareAsset(p.id, { actor: "post:libu_rites.langzhong", with: [], visibility: "court" });
    expect((await hub.as("bingbu.shangshu").asset(p.id, "post:bingbu.shangshu")).content).toBe("草稿");

    // 二进制
    const bin = await a.putAsset({ actor: "post:libu_rites.langzhong", owner: "dept:libu_rites", path: "seal.png", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" });
    const got = await b.asset(bin.id, "post:libu_rites.shangshu");
    expect(got.encoding).toBe("base64");
    expect(Buffer.from(got.content, "base64")).toEqual(Buffer.from([1, 2, 3]));

    await expectStatus(a.putAsset({ actor: "post:libu_rites.langzhong", owner: "court", path: "x.md", content: "x" }), 403);
    await expectStatus(a.putAsset({ actor: "post:libu_rites.langzhong", owner: "dept:libu_rites", path: "../etc/passwd", content: "x" }), 400);
  });

  it("私产跟人走：调岗后仍归本人", async () => {
    const me = hub.as("xingbu.bibu_langzhong");
    const a = await me.putAsset({ actor: "post:xingbu.bibu_langzhong", owner: "post:xingbu.bibu_langzhong", path: "ledger-notes.md", content: "账目备忘" });
    const official = hub.ctx.registry.officialOf("xingbu.bibu_langzhong")!;
    // 腾出户部主事，把比部郎中调过去
    const zhushi = hub.ctx.registry.officialOf("hubu.zhushi")!;
    await hub.emperor.personnel({ actor: "emperor", action: "dismiss", official_id: zhushi.official_id, reason: "腾位" });
    await hub.emperor.personnel({ actor: "emperor", action: "transfer", official_id: official.official_id, to_post_id: "hubu.zhushi", reason: "调任" });
    const now = hub.as("hubu.zhushi");
    expect((await now.asset(a.id, "post:hubu.zhushi")).content).toBe("账目备忘");
    expect((await now.assets({ viewer: "post:hubu.zhushi", owner: "post:hubu.zhushi" })).map((x) => x.id)).toContain(a.id);
  });

  it("删除", async () => {
    const me = hub.as("gongbu.shangshu");
    const a = await me.putAsset({ actor: "post:gongbu.shangshu", owner: "dept:gongbu", path: "tmp.txt", content: "临时" });
    await expectStatus(hub.as("xingbu.shangshu").deleteAsset(a.id, "post:xingbu.shangshu"), 403);
    await me.deleteAsset(a.id, "post:gongbu.shangshu");
    await expectStatus(hub.emperor.asset(a.id, "emperor"), 404);
  });
});
