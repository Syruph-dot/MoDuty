import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_UPLOAD_BYTES,
  defaultPastedFilename,
  deleteAttachment,
  guessMediaType,
  importAttachmentPath,
  listAttachments,
  readAttachmentBytes,
  saveAttachmentBytes,
  sanitizeFilename,
} from "../attachments.js";
import { MomokaHttpError } from "../http-error.js";
import { corsHeaders, json } from "./http-utils.js";
import { ensureAgents, requireAgent, type RouteContext } from "./route-context.js";

/**
 * 附件轨道路由（输入框粘贴 / 拖拽 / 文件选择）。
 *
 * 与 Agent 轨道的分工：这里只管「字节/路径 → 工作区文件 + 引用元数据」，
 * 消息落盘与模型消费在 agent-routes / agent.ts 里。
 */

/** 上传 body 的体积上限：base64 会膨胀约 4/3，这里按解码后上限再放宽 */
const MAX_UPLOAD_BODY_BYTES = Math.ceil((MAX_INLINE_UPLOAD_BYTES * 4) / 3) + 1024 * 1024;

export async function handleAttachmentRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const importMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/attachments\/import$/u);
  if (importMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(importMatch[1] ?? ""));
    const body = await readJsonBodyLimited(request, 1024 * 1024);
    const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : [];
    if (paths.length === 0) {
      throw new MomokaHttpError(400, "paths array is required");
    }
    const refs = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const filePath of paths) {
      try {
        // 拖拽进来的文件用 drop 语义；同一次请求也可能是其它入口，源标记交给前端意义不大
        refs.push(await importAttachmentPath({
          workspaceDir: record.workspaceDir,
          sessionId: record.sessionId,
          filePath,
        }));
      } catch (error) {
        failed.push({ path: filePath, error: error instanceof Error ? error.message : String(error) });
      }
    }
    json(response, 200, { attachments: refs, failed });
    return true;
  }

  const uploadMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/attachments$/u);
  if (uploadMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(uploadMatch[1] ?? ""));
    const body = await readJsonBodyLimited(request, MAX_UPLOAD_BODY_BYTES);
    const rawName = typeof body.filename === "string" ? body.filename.trim() : "";
    const declared = typeof body.mediaType === "string" ? body.mediaType : "";
    const rawBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
    if (!rawBase64) {
      throw new MomokaHttpError(400, "dataBase64 is required");
    }
    const data = decodeBase64(rawBase64);
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new MomokaHttpError(413, "附件体积超过上限");
    }
    const filename = rawName
      ? sanitizeFilename(rawName)
      : defaultPastedFilename(declared || "application/octet-stream");
    const ref = await saveAttachmentBytes({
      workspaceDir: record.workspaceDir,
      sessionId: record.sessionId,
      filename,
      mediaType: declared || guessMediaType(filename),
      data,
      source: body.source === "drop" ? "drop" : body.source === "picker" ? "picker" : "paste",
    });
    json(response, 200, { attachment: ref });
    return true;
  }

  const rawMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/attachments\/([^/]+)\/raw$/u);
  if (rawMatch && (request.method === "GET" || request.method === "HEAD")) {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(rawMatch[1] ?? ""));
    const found = await readAttachmentBytes(
      record.workspaceDir,
      record.sessionId,
      decodeURIComponent(rawMatch[2] ?? ""),
    );
    if (!found) throw new MomokaHttpError(404, "Unknown attachment");
    response.writeHead(200, {
      "content-type": found.ref.mediaType || "application/octet-stream",
      "content-length": String(found.data.byteLength),
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(found.ref.filename)}`,
      "cache-control": "no-store",
      ...corsHeaders(),
    });
    response.end(request.method === "HEAD" ? undefined : found.data);
    return true;
  }

  const listMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/attachments$/u);
  if (listMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(listMatch[1] ?? ""));
    json(response, 200, { attachments: await listAttachments(record.workspaceDir, record.sessionId) });
    return true;
  }

  const deleteMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/attachments\/([^/]+)$/u);
  if (deleteMatch && request.method === "DELETE") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(deleteMatch[1] ?? ""));
    const removed = await deleteAttachment(
      record.workspaceDir,
      record.sessionId,
      decodeURIComponent(deleteMatch[2] ?? ""),
    );
    json(response, removed ? 200 : 404, { success: removed });
    return true;
  }

  return false;
}

function decodeBase64(value: string): Buffer {
  const normalized = value.includes(",") && value.startsWith("data:")
    ? value.slice(value.indexOf(",") + 1)
    : value;
  try {
    return Buffer.from(normalized, "base64");
  } catch {
    throw new MomokaHttpError(400, "dataBase64 不是合法的 base64");
  }
}

/** 带体积上限的 JSON body 读取；超限直接 413，不把整个 body 吞进内存 */
async function readJsonBodyLimited(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MomokaHttpError(
      413,
      `请求体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）；大文件请改用拖拽（后端按路径复制）。`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new MomokaHttpError(
        413,
        `请求体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）；大文件请改用拖拽（后端按路径复制）。`,
      );
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new MomokaHttpError(400, "Request body must be JSON");
  }
}
