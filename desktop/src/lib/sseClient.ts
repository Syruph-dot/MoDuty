import type { Agent, AgentStateEvent } from "../types";

/** 与 DOM EventSource 最小兼容的注入点（测试可注入 fake） */
export interface EventSourceLike {
  readonly readyState: number;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface AgentEventStreamOptions {
  /** 注入 EventSource 构造器；缺省用全局 EventSource，不可用则降级轮询 */
  eventSourceCtor?: new (url: string) => EventSourceLike;
  /** 轮询间隔，默认 5000ms */
  pollIntervalMs?: number;
  /** 轮询模式下的事件源（测试注入；缺省拉 /api/agents 换算为 agent_state） */
  pollFetch?: (base: string) => Promise<AgentStateEvent[] | null>;
  onEvent: (event: AgentStateEvent) => void;
  /** 断线进入重连（EventSource 转 CONNECTING）时触发 */
  onReconnect?: () => void;
  /** 降级到轮询时触发 */
  onPolling?: () => void;
}

export interface AgentEventStreamControl {
  mode: "sse" | "polling";
  stop(): void;
}

/**
 * 订阅 /api/agents/events：SSE 优先（EventSource 原生自动重连），
 * EventSource 不可用（如 Tauri file:// 场景）时降级为轮询 /api/agents。
 */
export function startAgentEventStream(base: string, options: AgentEventStreamOptions): AgentEventStreamControl {
  const ES = options.eventSourceCtor ?? (typeof EventSource !== "undefined" ? (EventSource as new (url: string) => EventSourceLike) : undefined);
  if (!ES) {
    return startPolling(base, options);
  }
  let source: EventSourceLike | undefined;
  try {
    source = new ES(`${base}/api/agents/events`);
  } catch {
    return startPolling(base, options);
  }
  source.onmessage = (event) => {
    try {
      options.onEvent(JSON.parse(String(event.data)) as AgentStateEvent);
    } catch {
      // 忽略坏帧，等待下一条
    }
  };
  source.onerror = () => {
    // EventSource 断线后由浏览器自动转 CONNECTING 重连
    if (source?.readyState === 0) {
      options.onReconnect?.();
    }
  };
  return {
    mode: "sse",
    stop: () => source?.close(),
  };
}

async function pollAgentStates(base: string, pollFetch?: AgentEventStreamOptions["pollFetch"]): Promise<AgentStateEvent[]> {
  if (pollFetch) {
    return (await pollFetch(base)) ?? [];
  }
  const res = await fetch(`${base}/api/agents`);
  if (!res.ok) {
    return [];
  }
  const data = (await res.json()) as { agents: Agent[] };
  return data.agents.map((agent) => ({
    type: "agent_state" as const,
    agent_id: agent.id,
    state: agent.state,
    ...(agent.phase ? { phase: agent.phase } : {}),
  }));
}

function startPolling(base: string, options: AgentEventStreamOptions): AgentEventStreamControl {
  options.onPolling?.();
  const ms = options.pollIntervalMs ?? 5000;
  const timer = setInterval(() => {
    void pollAgentStates(base, options.pollFetch)
      .then((events) => {
        for (const event of events) {
          options.onEvent(event);
        }
      })
      .catch(() => {
        // 下次轮询再试
      });
  }, ms);
  return {
    mode: "polling",
    stop: () => clearInterval(timer),
  };
}