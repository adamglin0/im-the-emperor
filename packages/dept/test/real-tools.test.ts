// 与模块 D 的真实工具集联调：结束型工具经 ToolContext 设定下一次唤醒
import { afterEach, describe, expect, it } from "vitest";
import { DeptRuntime } from "../src/runtime.ts";
import { buildTools } from "../src/tools/index.ts";
import { FAST_LIMITS, FakeHub, POST, scriptedModel, tmpDataDir, toolCallMsg, until } from "./helpers.ts";

let rt: DeptRuntime | undefined;
afterEach(async () => {
  await rt?.stop(1000);
  rt = undefined;
});

describe("真实工具集", () => {
  it("wait_for 工具设定等待条件；系统消息声明了工具", async () => {
    const hub = new FakeHub(tmpDataDir());
    const model = scriptedModel();
    rt = new DeptRuntime({
      dept: "menxia",
      hubUrl: "http://hub",
      gatewayUrl: "http://gateway",
      dataDir: hub.dataDir,
      tokens: { dept: "tok" },
      buildTools,
      streamFn: model.streamFn,
      limits: FAST_LIMITS,
      fetchImpl: hub.fetchImpl,
      logger: () => undefined,
    });
    await rt.start();
    hub.addMessage(POST, { from: "emperor", body: "候中书回音" });
    model.push(toolCallMsg("wait_for", { from: ["post:zhongshu.sheren_a"], timeout_seconds: 900 }));
    rt.doorbell([POST]);
    await until(() => hub.acks.length === 1);
    const sys = model.calls[0].ctx.messages[0] as any;
    expect(sys.role).toBe("system");
    expect((sys.toolsAdded ?? []).map((t: any) => t.name)).toEqual(expect.arrayContaining(["sleep", "wait_for", "end_turn", "send_message"]));
    const w = rt.officials.get(POST)!.waitState();
    expect(w.mode).toBe("wait");
    expect(w.agent_set).toBe(true);
    expect(w.wait_filter?.from).toEqual(["post:zhongshu.sheren_a"]);
    expect(rt.officials.get(POST)!.status().state).toBe("waiting");
  });
});
