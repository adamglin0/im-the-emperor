import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/theme.css";
import "./styles/base.css";
import "./styles/components.css";
import { App } from "./App.tsx";
import { fixtureMode, hub, resolveFixtureMode } from "./api/client.ts";

async function bootstrap() {
  if (resolveFixtureMode()) {
    // 样例数据仅在 ?fixtures=1 时按需加载（独立 chunk，不进生产路径）
    const m = await import("./dev/fixtures.ts");
    m.installFixtures(hub);
    fixtureMode.on = true;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void bootstrap();
