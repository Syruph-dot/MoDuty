import type { AgentStateEvent } from "../types";

/** 收尾单链的判读结论事件（server → SSE `dispatch_verdict` 帧） */
export interface DispatchVerdictEvent {
  type: "dispatch_verdict";
  dispatch_id: string;
  dispatcher_agent_id: string;
  dispatcher_session_id: string;
  target_agent_id: string;
  target_session_id: string;
  task: string;
  verdict: "deliver" | "continue";
  continue_count: number;
  note: string;
}

export type DutyEvent = AgentStateEvent | DispatchVerdictEvent;

type Listener = (event: DutyEvent) => void;

/**
 * 桌面端事件分发：Desktop 的 /api/agents/events 流在这里扇出，
 * 值日生磁贴（终态刷新）与判读上报 toast 按需订阅，替代轮询。
 */
const listeners = new Set<Listener>();

export function emitDutyEvent(event: DutyEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // 单个订阅者异常不影响其它订阅者
    }
  }
}

export function subscribeDutyEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
