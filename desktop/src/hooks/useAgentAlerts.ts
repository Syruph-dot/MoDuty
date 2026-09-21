import { useEffect } from "react";

import {
  catchUpAgentAlerts,
  clearAgentAlert,
  raiseAgentAlert,
} from "../lib/agentAlerts";
import { subscribeDutyEvents } from "../lib/dutyEvents";
import { primeNotificationPermission } from "../lib/nativeNotify";

/**
 * Agent 需要用户介入时的双层提醒：
 * - 应用内 toast（不依赖系统权限，一定看得见）：AgentAlertToasts 订阅同一套事件；
 * - OS 通知（Windows 原生 / 浏览器通知）：本 hook 通过 lib/agentAlerts 统一触发。
 *
 * 抑制/去重/冷却的规则集中在 lib/agentAlerts.ts，这里只负责把两类来源接进去：
 * 1. SSE 事件（实时）；
 * 2. 启动对账 catchUpAgentAlerts（应用没开着时错过的挂起转移）。
 */
export function useAgentAlerts(): void {
  useEffect(() => {
    // 浏览器要在用户手势里才能拿到通知权限；顺手在第一次点击/按键时申请
    primeNotificationPermission();
    // 开机补一次：现在就在等你的 Agent（事件早丢了也不会漏）
    void catchUpAgentAlerts();

    return subscribeDutyEvents((event) => {
      if (event.type !== "agent_state") return;
      const { state, agent_id: agentId } = event;
      if (state === "requiring_input" || state === "waiting_approval") {
        raiseAgentAlert({ agentId, name: event.name, state });
        return;
      }
      // 脱离挂起态（已作答/已审批/重跑）：撤掉提示，允许下次再提醒
      clearAgentAlert(agentId);
    });
  }, []);
}
