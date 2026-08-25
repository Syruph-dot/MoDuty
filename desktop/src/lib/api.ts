import type { Agent } from "../types";

/**
 * API base 解析（异步）：
 * - 优先级：
 *   1) VITE_MOMOKA_API 显式覆盖（构建期注入）—— 同步值，立即返回
 *   2) Tauri webview → 调用 Rust 命令 get_momoka_port 拿真实端口，拼出 http://127.0.0.1:{port}
 *      （后端 sidecar 启动时端口会从 8888 起递增找空位）
 *   3) 浏览器 dev → 空串（走 Vite dev proxy /api → :8888）
 *
 * 结果按 Promise 缓存：整个应用生命周期只解析一次。
 */
let _apiBasePromise: Promise<string> | null = null;

function readEnvBase(): string | undefined {
  if (typeof import.meta === "undefined") return undefined;
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  const value = env?.VITE_MOMOKA_API;
  return value ? String(value) : undefined;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

export function awaitApiBase(): Promise<string> {
  if (_apiBasePromise) return _apiBasePromise;
  _apiBasePromise = (async () => {
    const envBase = readEnvBase();
    if (envBase) return envBase;
    if (inTauri()) {
      // 动态 import：避免 vite 浏览器构建时拉 @tauri-apps/api 失败
      try {
        const { invoke } = await import("@tauri-apps/api/tauri");
        const port = await invoke<number>("get_momoka_port");
        return `http://127.0.0.1:${port}`;
      } catch (err) {
        // 端口读取失败（后端还没起来）时重试：让上层业务去 retry，不要在这里阻塞
        console.error("[api] failed to resolve momoka port from Tauri:", err);
        throw err;
      }
    }
    return ""; // 浏览器 dev：Vite dev proxy
  })();
  return _apiBasePromise;
}

/** 已弃用的同步兜底值：仅用于日志/UI 提示；不要用于实际 fetch。 */
export const apiBaseHint = (() => {
  if (readEnvBase()) return readEnvBase();
  if (inTauri()) return "tauri://(await port)";
  return "(vite dev proxy)";
})();

async function jsonOrThrow(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

export async function listAgents(): Promise<Agent[]> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(await fetch(`${base}/api/agents`), "GET /api/agents")) as { agents: Agent[] };
  return data.agents;
}

export async function createAgent(input: { name: string; role: string; workspace_dir: string; model?: string }): Promise<Agent> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    "POST /api/agents",
  )) as { agent: Agent };
  return data.agent;
}

export async function deleteAgent(id: string): Promise<void> {
  const base = await awaitApiBase();
  await jsonOrThrow(await fetch(`${base}/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }), "DELETE /api/agents/:id");
}
