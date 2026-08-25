import type { Agent } from "../types";

/**
 * API base 解析：
 * - VITE_MOMOKA_API 显式覆盖（构建期注入）
 * - Tauri webview 内 → http://localhost:8888（后端默认端口）
 * - 浏览器 dev → 同源（走 Vite dev proxy /api → :8888）
 */
export function resolveApiBase(): string {
  if (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, unknown> }).env?.VITE_MOMOKA_API) {
    return String((import.meta as { env: Record<string, unknown> }).env.VITE_MOMOKA_API);
  }
  if (typeof window !== "undefined" && "__TAURI__" in window) {
    return "http://localhost:8888";
  }
  return "";
}

export const apiBase = resolveApiBase();

async function jsonOrThrow(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

export async function listAgents(base: string = apiBase): Promise<Agent[]> {
  const data = (await jsonOrThrow(await fetch(`${base}/api/agents`), "GET /api/agents")) as { agents: Agent[] };
  return data.agents;
}

export async function createAgent(
  input: { name: string; role: string; workspace_dir: string; model?: string },
  base: string = apiBase,
): Promise<Agent> {
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

export async function deleteAgent(id: string, base: string = apiBase): Promise<void> {
  await jsonOrThrow(await fetch(`${base}/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }), "DELETE /api/agents/:id");
}