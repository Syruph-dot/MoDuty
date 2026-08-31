import type { ServerResponse } from "node:http";

/**
 * 活跃 chat 流注册表 —— 连接是「在线投影」，任务不依赖连接存在：
 * agent 输出由 agent.chat 流式写入会话日志；这里只登记 controller 供
 * 两个入口中止任务：
 * 1. 显式取消（POST /api/agents/:id/chat/cancel，前端停止按钮）
 * 2. 服务退出（SIGINT/SIGTERM，abortAllChatStreams）
 *
 * 客户端断开（关窗/收起磁贴）**不**经此中止任务——任务继续后台跑。
 */
interface ChatStreamEntry {
  agentId: string;
  controller: AbortController;
  response: ServerResponse;
  startedAt: number;
}

const streams = new Map<string, ChatStreamEntry>();

export function registerChatStream(streamId: string, entry: Omit<ChatStreamEntry, "startedAt">): void {
  streams.set(streamId, { ...entry, startedAt: Date.now() });
}

export function unregisterChatStream(streamId: string): void {
  streams.delete(streamId);
}

/** 按 agent 中止其全部活跃 chat 流；返回是否命中过 */
export function abortChatStreamByAgent(agentId: string): boolean {
  let hit = false;
  for (const [id, entry] of [...streams]) {
    if (entry.agentId === agentId) {
      entry.controller.abort();
      streams.delete(id);
      hit = true;
    }
  }
  return hit;
}

/** 中止全部活跃 chat 流（服务退出时调用）；返回中止数量 */
export function abortAllChatStreams(): number {
  const count = streams.size;
  for (const entry of streams.values()) {
    entry.controller.abort();
  }
  streams.clear();
  return count;
}

export function activeChatStreamCount(): number {
  return streams.size;
}