import { awaitApiBase } from "./api";

/**
 * 值日生（dispatcher）身份：固定名字 + localStorage 缓存 + 幂等创建。
 *
 * 桌面上的可见形态是 `widget:duty` 磁贴（立绘）；真正承载会话的是后端一个
 * kind="dispatcher" 的 Agent。两者 id 不同，靠这里把 widget 与 Agent 对上。
 */

export const DUTY_AGENT_NAME = "值日生";
export const DUTY_AGENT_KEY = "momoka:duty:agentId";

/** 创建锁：多个实例 / StrictMode 双挂载时只发一次创建请求 */
let dutyCreateLock: Promise<string | null> | null = null;

export function cachedDutyAgentId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(DUTY_AGENT_KEY);
}

/** 确保值日生 Agent 存在（已缓存直接返回；否则 POST /api/agents 创建并缓存） */
export function ensureDutyAgentId(): Promise<string | null> {
  const cached = cachedDutyAgentId();
  if (cached) return Promise.resolve(cached);
  if (dutyCreateLock) return dutyCreateLock;
  dutyCreateLock = (async () => {
    try {
      const base = await awaitApiBase();
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: DUTY_AGENT_NAME, kind: "dispatcher" }),
      });
      const data = (await res.json()) as { agent?: { id: string } };
      const id = data.agent?.id ?? null;
      if (id && typeof localStorage !== "undefined") localStorage.setItem(DUTY_AGENT_KEY, id);
      return id;
    } catch {
      return null;
    } finally {
      dutyCreateLock = null;
    }
  })();
  return dutyCreateLock;
}

/**
 * 从 Agent 列表里解析值日生 id：kind 标记优先（后端下发）→ localStorage 缓存 → 名字兜底（旧数据）。
 * 返回 null 表示还没有值日生（首次运行且未创建）。
 */
export function resolveDutyAgentId(agents: Array<{ id: string; name: string; kind?: string }>): string | null {
  const byKind = agents.find((agent) => agent.kind === "dispatcher");
  if (byKind) return byKind.id;
  const cached = cachedDutyAgentId();
  if (cached && agents.some((agent) => agent.id === cached)) return cached;
  const byName = agents.find((agent) => agent.name === DUTY_AGENT_NAME);
  return byName?.id ?? null;
}
