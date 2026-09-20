import { useEffect, useRef } from "react";

import { subscribeDutyEvents } from "../lib/dutyEvents";
import { notifyNative } from "../lib/nativeNotify";
import { useAgentsStore } from "../state/agentsStore";

/** 同一 Agent 同一挂起状态的提醒冷却，避免 SSE 抖动导致连续弹窗 */
const ALERT_COOLDOWN_MS = 60_000;

/**
 * Agent 需要用户介入时发 OS 级提醒（Windows 原生通知）。
 *
 * 触发条件：SSE 收到某 Agent 进入 `requiring_input`（有待答提问）或 `waiting_approval`（有待审批操作）。
 * 抑制条件：该 Agent 窗口已经打开且页面可见 —— 这时卡片本身就在眼前，不再打扰。
 * 点击提醒 → 打开该 Agent 的窗口并聚焦。
 */
export function useAgentAlerts(): void {
  const lastAlertAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return subscribeDutyEvents((event) => {
      if (event.type !== "agent_state") return;
      const { state, agent_id: agentId } = event;
      if (state !== "requiring_input" && state !== "waiting_approval") return;

      const store = useAgentsStore.getState();
      const isOpen = store.openAgentIds.includes(agentId);
      if (isOpen && document.visibilityState === "visible") return;

      const cooldownKey = `${agentId}:${state}`;
      const now = Date.now();
      if (now - (lastAlertAtRef.current.get(cooldownKey) ?? 0) < ALERT_COOLDOWN_MS) return;
      lastAlertAtRef.current.set(cooldownKey, now);

      const name = event.name?.trim() || store.agents.find((candidate) => candidate.id === agentId)?.name || "有 Agent";
      const title = state === "requiring_input" ? `${name} 在等你回答` : `${name} 在等审批`;
      const body = state === "requiring_input"
        ? "有一条待回答的提问，打开窗口即可作答。"
        : "有一条待审批的操作，打开窗口即可处理。";

      void notifyNative({
        title,
        body,
        tag: `moduty-agent-${agentId}`,
        onClick: () => {
          useAgentsStore.getState().openAgent(agentId);
          window.focus();
        },
      });
    });
  }, []);
}
