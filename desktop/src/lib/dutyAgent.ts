import { awaitApiBase } from "./api";

/**
 * 值日生（dispatcher）身份：固定名字 + localStorage 缓存 + 幂等创建。
 *
 * 桌面上的可见形态是 `widget:duty` 磁贴（立绘）；真正承载会话的是后端一个
 * kind="dispatcher" 的 Agent。两者 id 不同，靠这里把 widget 与 Agent 对上。
 */

export const DUTY_AGENT_NAME = "值日生";
export const DUTY_AGENT_KEY = "momoka:duty:agentId";

export function cachedDutyAgentId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(DUTY_AGENT_KEY);
}

/**
 * 从 Agent 列表里解析值日生 id：kind 标记优先（后端下发）→ localStorage 缓存（需在列表里）→ 名字兜底（旧数据）。
 * 返回 null 表示还没有值日生（首次运行，或缓存已失效需重建）。
 *
 * 注意：缓存必须拿列表校验。否则缓存里存的是已删/旧库的 id 时，界面会“以为有值日生”，
 * 点了打开却打不开任何卡片（打开的是一个不存在的 agent）。
 */
export function resolveDutyAgentId(agents: Array<{ id: string; name: string; kind?: string }>): string | null {
  const byKind = agents.find((agent) => agent.kind === "dispatcher");
  if (byKind) return byKind.id;
  const cached = cachedDutyAgentId();
  if (cached && agents.some((agent) => agent.id === cached)) return cached;
  const byName = agents.find((agent) => agent.name === DUTY_AGENT_NAME);
  return byName?.id ?? null;
}

/**
 * 强制重建值日生（缓存失效或列表里没有 dispatcher 时用）：
 * 总是 POST 一个新 dispatcher 并覆写缓存。模块级锁避免并发/StrictMode 重复创建。
 */
let dutyRecreateLock: Promise<string | null> | null = null;
export function createDutyAgent(): Promise<string | null> {
  if (dutyRecreateLock) return dutyRecreateLock;
  dutyRecreateLock = (async () => {
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
      dutyRecreateLock = null;
    }
  })();
  return dutyRecreateLock;
}
