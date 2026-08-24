import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// MOMOKA Desktop frontend. Dev server runs on 5173 (tauri.conf.json devPath
// points here); `npm run build` emits desktop/dist for the Tauri shell.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // dev 期把 /api 代理到 MOMOKA 后端，避免跨源
    proxy: {
      "/api": "http://localhost:8888",
    },
  },
  build: {
    outDir: "dist",
  },
});