import type { ServerResponse } from "node:http";

import { corsHeaders } from "./http-utils.js";

/**
 * /api/agents/events 的 SSE 客户端池。
 *
 * 职责（传输层，不含业务）：
 * - open()：完成 SSE 握手（立即 flush 响应头，否则 Node 等第一个 write 才发头，客户端 fetch 会挂起）、
 *   30s 心跳注释保活、连接关闭时清理；
 * - broadcast()：把一帧 data: 推给所有在线客户端（已断开的静默忽略）。
 *
 * 业务编排（状态持久化、事件组装）在 http/agent-orchestration.ts。
 */
export class AgentEventBroadcaster {
  private readonly clients = new Set<ServerResponse>();

  /** 接管一条 /api/agents/events 长连接 */
  open(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      ...corsHeaders(),
    });
    // 立即冲刷响应头：不做的话 Node 会等第一个 write 才发头，客户端 fetch 将挂起
    response.flushHeaders();
    this.clients.add(response);
    const ping = setInterval(() => {
      if (!response.writableEnded) {
        response.write(": ping\n\n");
      }
    }, 30000);
    response.on("close", () => {
      clearInterval(ping);
      this.clients.delete(response);
    });
  }

  /** 向所有在线客户端广播一帧；客户端已断开时静默忽略 */
  broadcast(frame: string): void {
    for (const client of [...this.clients]) {
      try {
        if (!client.writableEnded) {
          client.write(frame);
        }
      } catch {
        // 客户端已断开，忽略
      }
    }
  }
}
