// Web 唯一后端：皇城 hub（同源 /api）。
// fixtures 模式（?fixtures=1）下由 dev/fixtures.ts 替换方法，见 main.tsx。
import { ApiError, HubClient } from "@court/shared/api";

export const hub = new HubClient({ baseUrl: "", timeoutMs: 20_000 });
/** 长耗时接口专用（MCP 测试/重启：stdio 首次启动要拉镜像、下载包，可达数分钟；hub 侧上限 330 秒） */
export const slowHub = new HubClient({ baseUrl: "", timeoutMs: 340_000 });

export { ApiError };

const FIXTURE_KEY = "court.fixtures";

/** 读取并记忆 fixtures 开关：?fixtures=1 开启，?fixtures=0 关闭（存 sessionStorage） */
export function resolveFixtureMode(): boolean {
  try {
    const p = new URLSearchParams(location.search).get("fixtures");
    if (p === "1") sessionStorage.setItem(FIXTURE_KEY, "1");
    if (p === "0") sessionStorage.removeItem(FIXTURE_KEY);
    return sessionStorage.getItem(FIXTURE_KEY) === "1";
  } catch {
    return new URLSearchParams(location.search).get("fixtures") === "1";
  }
}

export const fixtureMode = { on: false };

/** 统一的错误文字 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "unavailable") return "皇城失联：无法连接后端";
    return `${e.message}（${e.code}）`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiError && (e.code === "unavailable" || e.status === 502 || e.status === 503 || e.status === 504);
}
