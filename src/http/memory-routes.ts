import type { MemoryStatus, MemoryType } from "../memory-extract.js";
import { MomokaHttpError } from "../agent.js";
import { json, readJsonBody } from "./http-utils.js";
import type { RouteContext } from "./route-context.js";
import type { LongTermMemoryEntry } from "../memory.js";

const MEMORY_TYPES: MemoryType[] = ["episode", "fact", "preference", "procedure", "decision"];
const MEMORY_STATUSES: MemoryStatus[] = ["candidate", "active", "superseded", "rejected"];

function toSnake(entry: LongTermMemoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    content: entry.content,
    topic: entry.topic,
    scope: entry.ownerScope,
    scope_id: entry.scopeId,
    type: entry.type ?? "episode",
    status: entry.status ?? "active",
    confidence: entry.confidence ?? null,
    source_refs: entry.sourceRefs ?? [],
    source: entry.source,
    superseded_by: entry.supersededBy ?? null,
    supersedes: entry.supersedes ?? null,
    valid_until: entry.validUntil ?? null,
    access_count: entry.accessCount ?? 0,
    created_at: entry.createdAt,
    last_accessed_at: entry.lastAccessedAt ?? null,
  };
}

/**
 * 记忆面板路由（P10）：让记忆**可审计、可纠正、可删除**。
 *
 * 没有这一层，P2–P4 建起来的记忆机制就是个黑盒：用户既看不到系统记住了什么，
 * 也无法推翻一条错误记忆或处理矛盾。所以这里把记忆当作一等资源暴露出来。
 *
 * - `GET    /api/memory`                 列表（可按 scope/type/status 过滤 + q 关键词过滤）
 * - `GET    /api/memory/:id`             单条（含来源与取代关系）
 * - `GET    /api/memory/:id/sources`     溯源详情（sourceRefs + 作用域 + 时间线）
 * - `PATCH  /api/memory/:id`             人工纠正（content/type/status/confidence/valid_until）
 * - `POST   /api/memory/:id/supersede`   人工标记被取代（可指向取代者 id）
 * - `DELETE /api/memory/:id`             删除（同时从索引移除）
 */
export async function handleMemoryRoutes(
  ctx: RouteContext,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  url: URL,
): Promise<boolean> {
  const store = ctx.agent.memoryStore;

  if (url.pathname === "/api/memory" && request.method === "GET") {
    const scope = url.searchParams.get("scope");
    const type = url.searchParams.get("type");
    const status = url.searchParams.get("status");
    const keyword = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;

    let entries = await store.listAllEntries();
    if (scope) entries = entries.filter((entry) => entry.ownerScope === scope);
    if (type) entries = entries.filter((entry) => (entry.type ?? "episode") === type);
    if (status) entries = entries.filter((entry) => (entry.status ?? "active") === status);
    if (keyword) entries = entries.filter((entry) => entry.content.toLowerCase().includes(keyword));
    entries.sort((a, b) => String(b.lastAccessedAt ?? b.createdAt).localeCompare(String(a.lastAccessedAt ?? a.createdAt)));

    json(response, 200, {
      total: entries.length,
      memories: entries.slice(0, limit).map(toSnake),
      filters: { scope, type, status, q: keyword || null },
    });
    return true;
  }

  if (url.pathname === "/api/memory/experiences" && request.method === "GET") {
    const experiences = await ctx.agent.experienceMemory.list(url.searchParams.get("q") ?? "");
    json(response, 200, { total: experiences.length, experiences });
    return true;
  }

  const experienceMatch = url.pathname.match(/^\/api\/memory\/experiences\/([A-Za-z0-9_-]+)$/u);
  if (experienceMatch) {
    const id = decodeURIComponent(experienceMatch[1] ?? "");
    if (request.method === "GET") {
      const experience = await ctx.agent.experienceMemory.get(id);
      if (!experience) throw new MomokaHttpError(404, "Unknown work experience");
      json(response, 200, { experience });
      return true;
    }
    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      if (typeof body.content !== "string") throw new MomokaHttpError(400, "content must be Markdown text");
      const experience = await ctx.agent.experienceMemory.update(id, body.content);
      if (!experience) throw new MomokaHttpError(404, "Unknown work experience");
      json(response, 200, { experience });
      return true;
    }
  }

  const sourcesMatch = url.pathname.match(/^\/api\/memory\/([^/]+)\/sources$/u);
  if (sourcesMatch && request.method === "GET") {
    const found = await store.findEntryById(decodeURIComponent(sourcesMatch[1] ?? ""));
    if (!found) throw new MomokaHttpError(404, "Unknown memory");
    json(response, 200, {
      id: found.entry.id,
      scope: found.entry.ownerScope,
      scope_id: found.entry.scopeId,
      type: found.entry.type ?? "episode",
      status: found.entry.status ?? "active",
      source: found.entry.source,
      source_refs: found.entry.sourceRefs ?? [],
      output_id: found.entry.outputId ?? null,
      created_at: found.entry.createdAt,
      last_accessed_at: found.entry.lastAccessedAt ?? null,
      access_count: found.entry.accessCount ?? 0,
      superseded_by: found.entry.supersededBy ?? null,
      supersedes: found.entry.supersedes ?? null,
    });
    return true;
  }

  const supersedeMatch = url.pathname.match(/^\/api\/memory\/([^/]+)\/supersede$/u);
  if (supersedeMatch && request.method === "POST") {
    const body = await readJsonBody(request);
    const id = decodeURIComponent(supersedeMatch[1] ?? "");
    const by = body.by == null ? undefined : String(body.by).trim() || undefined;
    const updated = await store.supersedeEntry(id, by);
    if (!updated) throw new MomokaHttpError(404, "Unknown memory");
    json(response, 200, { memory: toSnake(updated) });
    return true;
  }

  const entryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/u);
  if (entryMatch && request.method === "GET") {
    const found = await store.findEntryById(decodeURIComponent(entryMatch[1] ?? ""));
    if (!found) throw new MomokaHttpError(404, "Unknown memory");
    json(response, 200, { memory: toSnake(found.entry) });
    return true;
  }

  if (entryMatch && request.method === "PATCH") {
    const body = await readJsonBody(request);
    const type = body.type === undefined ? undefined : String(body.type);
    if (type && !MEMORY_TYPES.includes(type as MemoryType)) {
      throw new MomokaHttpError(400, `type must be one of ${MEMORY_TYPES.join(", ")}`);
    }
    const status = body.status === undefined ? undefined : String(body.status);
    if (status && !MEMORY_STATUSES.includes(status as MemoryStatus)) {
      throw new MomokaHttpError(400, `status must be one of ${MEMORY_STATUSES.join(", ")}`);
    }
    const confidence = body.confidence === undefined ? undefined : Number(body.confidence);
    if (confidence !== undefined && !Number.isFinite(confidence)) {
      throw new MomokaHttpError(400, "confidence must be a number");
    }
    const updated = await store.updateEntry(decodeURIComponent(entryMatch[1] ?? ""), {
      ...(body.content !== undefined ? { content: String(body.content) } : {}),
      ...(type ? { type: type as MemoryType } : {}),
      ...(status ? { status: status as MemoryStatus } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(body.valid_until !== undefined ? { validUntil: body.valid_until == null ? null : String(body.valid_until) } : {}),
    });
    if (!updated) throw new MomokaHttpError(404, "Unknown memory");
    json(response, 200, { memory: toSnake(updated) });
    return true;
  }

  if (entryMatch && request.method === "DELETE") {
    const removed = await store.deleteEntry(decodeURIComponent(entryMatch[1] ?? ""));
    if (!removed) throw new MomokaHttpError(404, "Unknown memory");
    json(response, 200, { success: true });
    return true;
  }

  return false;
}
