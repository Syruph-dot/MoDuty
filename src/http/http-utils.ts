import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";

/** 桌面壳（Tauri webview 为 tauri://localhost 源）跨源访问本地 API；预检（JSON body / 自定义头）直接放行 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

export function send(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  response.end(body);
}

export function json(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, `${JSON.stringify(payload)}\n`, "application/json; charset=utf-8");
}

export function sseData(response: ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new MomokaHttpError(400, "Request body must be JSON");
  }
}

/** 双轨收束：遗留写接口显式降级为 410 Gone，指引到桌面端 */
export function gone(response: ServerResponse, message: string): void {
  json(response, 410, { error: message, deprecated: true });
}
