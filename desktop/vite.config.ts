import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 后端端口不再固定 8888（它会挑一个空闲端口，并把结果写进这个文件）。
 * 浏览器里跑 dev 时优先用 VITE_MOMOKA_API（由 scripts/dev-all.mjs 注入）；
 * 单独起 `npm run desktop:dev` 时退回这里读端口文件，最后才兜底 8888。
 */
function backendTarget(): string {
  try {
    const port = Number(readFileSync(join(tmpdir(), "arona-chest.momoka.port"), "utf-8").trim());
    if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`;
  } catch {
    /* 后端还没起来，用兜底 */
  }
  return "http://localhost:8888";
}

// MOMOKA Desktop frontend. Dev server runs on 5173 (tauri.conf.json devPath
// points here); `npm run build` emits desktop/dist for the Tauri shell.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // dev 期把 /api 代理到 MOMOKA 后端，避免跨源
    proxy: {
      "/api": backendTarget(),
    },
  },
  build: {
    outDir: "dist",
  },
});