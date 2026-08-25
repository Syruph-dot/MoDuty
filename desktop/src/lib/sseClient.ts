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
  /** 初始 SSE 失败重试次数（默认 5 次；针对 sidecar 启动慢场景） */
  initialRetries?: number;
  /** 每次重试的退避基数（ms），默认 800ms，线性递增 */
  retryBackoffMs?: number;
}

export interface AgentEventStreamControl {
  mode: "sse" | "polling";
  stop(): void;
}

/**
 * 订阅 /api/agents/events：
 * - SSE 优先：EventSource 原生自动重连
 * - 初始连接失败（sidecar 启动慢 / 端口文件尚未写入）按线性退避重试 N 次
 * - 仍失败 或 EventSource 不可用（Tauri file:// 场景） → 降级为轮询 /api/agents
 */
export function startAgentEventStream(base: string, options: AgentEventStreamOptions): AgentEventStreamControl {
  const ES = options.eventSourceCtor ?? (typeof EventSource !== "undefined" ? (EventSource as new (url: string) => EventSourceLike) : undefined);
  if (!ES) {
    return startPolling(base, options);
  }

  const maxRetries = Math.max(0, options.initialRetries ?? 5);
  const backoff = Math.max(100, options.retryBackoffMs ?? 800);

  let source: EventSourceLike | undefined;
  let stopped = false;
  let attempt = 0;
  let closedCleanly = false;

  const open = (): void => {
    if (stopped) return;
    try {
      source = new ES(`${base}/api/agents/events`);
    } catch {
      // new EventSource 同步抛错（极少见），按一次失败处理
      scheduleRetry();
      return;
    }
    source.onmessage = (event) => {
      try {
        options.onEvent(JSON.parse(String(event.data)) as AgentStateEvent);
      } catch {
        // 忽略坏帧，等待下一条
      }
    };
    source.onerror = () => {
      // READYSTATE 0 = CONNECTING（浏览器在自动重连）
      // READYSTATE 2 = CLOSED（彻底断线，例如后端没起来或主动拒绝）
      if (source?.readyState === 0) {
        options.onReconnect?.();
        return;
      }
      if (stopped) return;
      // 彻底失败：关掉当前源，进入退避重试
      source?.close();
      scheduleRetry();
    };
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    if (attempt >= maxRetries) {
      // 超过上限：降级轮询
      options.onPolling?.();
      // 启动一个轻量 timer，定期尝试重连回 SSE（Tauri 场景下 sidecar 可能稍后启动）
      // 这里不直接换回 SSE，避免又一轮断线抖动；保持 polling
      const timer = setInterval(() => {
        if (stopped) {
          clearInterval(timer);
          return;
        }
        // 探测一次 /api/agents 可达性（轻量、不依赖 SSE）
        void fetch(`${base}/api/agents`)
          .then((res) => {
            if (!res.ok) return;
            // 服务可达：尝试重建 SSE
            clearInterval(timer);
            attempt = 0;
            open();
          })
          .catch(() => undefined);
      }, Math.max(2000, backoff * 4));
      // 把 timer 句柄挂到 stopped 检测上：stop 时一起清
      stopFallback = (): void => clearInterval(timer);
      return;
    }
    const delay = backoff * (attempt + 1);
    attempt += 1;
    setTimeout(() => {
      if (stopped) return;
      open();
    }, delay);
  };

  let stopFallback: (() => void) | undefined;

  open();

  return {
    mode: "sse",
    stop: () => {
      if (stopped) return;
      stopped = true;
      closedCleanly = true;
      source?.close();
      stopFallback?.();
    },
    // 内部状态访问（测试用）
    get isClosedCleanly() {
      return closedCleanly;
    },
  } as AgentEventStreamControl & { isClosedCleanly: boolean };
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
