import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HUB = process.env.HUB_URL ?? "http://localhost:8001";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      // hub 对外（皇帝/Web）端口 8001；SSE 需关闭缓冲：http-proxy 默认透传流，不压缩即可
      "/api": {
        target: HUB,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyRes", (res) => {
            if (String(res.headers["content-type"] ?? "").includes("text/event-stream")) {
              res.headers["cache-control"] = "no-cache";
              res.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: HUB, changeOrigin: true } },
  },
});
