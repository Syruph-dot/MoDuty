import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";
import { isExternalSessionSource, isSessionSource, sourceOf, type ExternalSessionSource, type SessionSource } from "../session-source.js";
import { extractArchiveToTemp, findArchiveCandidates, findPromaRoot } from "../session-sources/archive.js";
import { describeSources, getJob, listSourceSessions, startImportJob, type SyncJobView } from "../session-sources/importer.js";
import { createPromaAdapter } from "../session-sources/proma.js";
import { allAdapters, getAdapter } from "../session-sources/registry.js";
import { json, readJsonBody } from "./http-utils.js";
import type { RouteContext } from "./route-context.js";

/**
 * 会话来源路由：设置页「会话来源」区域的后端。
 *
 * 三层职责边界：
 * - 本文件只做 HTTP 形状校验与序列化；
 * - 列举/比对/导入语义在 `session-sources/importer.ts`；
 * - 各来源的格式解析在 `session-sources/<source>.ts`。
 *
 * 整源同步是分钟级操作（codex 会话目录实测 1.1 GB），所以 POST sync/backup 只**启动作业**，
 * 进度靠 GET .../job 轮询；同一来源做单飞，重复点击只会拿到同一个作业。
 */
export async function handleSourceRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/sources")) return false;
  const sessionManager = ctx.agent.sessionManager;

  if (request.method === "GET" && url.pathname === "/api/sources") {
    const sessions = await sessionManager.listSessions(true);
    const bySource: Record<SessionSource, number> = { moduty: 0, claude: 0, codex: 0, proma: 0 };
    for (const session of sessions) {
      bySource[sourceOf(session)] += 1;
    }
    const overviews = await describeSources(sessionManager, allAdapters());
    json(response, 200, {
      sources: overviews.map((overview) => ({
        source: overview.source,
        label: overview.label,
        available: overview.available,
        root: overview.root,
        reason: overview.reason ?? null,
        imported_count: overview.importedCount,
        last_sync_at: overview.lastSyncAt,
        job: overview.job ? jobToSnake(overview.job) : null,
      })),
      local: { total: sessions.length, by_source: bySource },
    });
    return true;
  }

  // 迁移压缩包导入：必须排在通用 `/:source/...` 之前
  if (request.method === "GET" && url.pathname === "/api/sources/proma/archives") {
    json(response, 200, { candidates: await findArchiveCandidates() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/sources/proma/import-archive") {
    const body = await readJsonBody(request) as { path?: unknown };
    const archivePath = typeof body.path === "string" ? body.path.trim() : "";
    if (!archivePath) throw new MomokaHttpError(400, "缺少 path：请提供 Proma 迁移压缩包的绝对路径");
    const extracted = await extractArchiveToTemp(archivePath);
    try {
      const root = await findPromaRoot(extracted.dir);
      if (!root) {
        throw new MomokaHttpError(400, "压缩包里没有找到 agent-sessions.json，确认它是 Proma 的 .proma 数据目录压缩包");
      }
      const adapter = createPromaAdapter(() => root, "Proma（迁移压缩包）");
      const { job, started } = startImportJob(sessionManager, adapter, "archive", [], {
        sourcePathPrefix: `zip:${archivePath}`,
        baseDir: root,
        cleanup: extracted.cleanup,
        origin: `${archivePath} → ${root}`,
      });
      // 作业已经在跑（单飞命中）时，本次解压结果用不上，立刻清理
      if (!started) await extracted.cleanup();
      json(response, 200, { job: jobToSnake(job), started, archive_root: root });
      return true;
    } catch (error) {
      await extracted.cleanup();
      throw error;
    }
  }

  const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)(?:\/([^/]+))?$/);
  if (!sourceMatch) return false;
  const rawSource = decodeURIComponent(sourceMatch[1] ?? "");
  const action = sourceMatch[2] ? decodeURIComponent(sourceMatch[2]) : "";
  if (rawSource === "jobs") return false;
  if (!isExternalSessionSource(rawSource)) {
    throw new MomokaHttpError(404, `未知来源：${rawSource}（支持 ${allAdapters().map((adapter) => adapter.source).join(" / ")}）`);
  }
  const source: ExternalSessionSource = rawSource;
  const adapter = getAdapter(source);

  if (request.method === "GET" && !action) {
    const overviews = await describeSources(sessionManager, [adapter]);
    const overview = overviews[0];
    json(response, 200, {
      source: overview.source,
      label: overview.label,
      available: overview.available,
      root: overview.root,
      reason: overview.reason ?? null,
      imported_count: overview.importedCount,
      last_sync_at: overview.lastSyncAt,
      job: overview.job ? jobToSnake(overview.job) : null,
    });
    return true;
  }

  if (request.method === "GET" && action === "sessions") {
    const filterRaw = url.searchParams.get("filter") ?? "all";
    const filter = filterRaw === "new" || filterRaw === "changed" || filterRaw === "imported" ? filterRaw : "all";
    const offsetRaw = Number(url.searchParams.get("offset") ?? "");
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const result = await listSourceSessions(sessionManager, adapter, {
      query: url.searchParams.get("query") ?? "",
      filter,
      offset: Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
      limit: Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50,
    });
    json(response, 200, {
      source: result.source,
      total: result.total,
      matched: result.matched,
      offset: result.offset,
      limit: result.limit,
      items: result.items.map((item) => ({
        external_id: item.externalId,
        title: item.title,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        message_count: item.messageCount,
        workspace: item.workspace ?? null,
        archived: item.archived === true,
        imported: item.imported,
        needs_update: item.needsUpdate,
        session_id: item.sessionId,
      })),
    });
    return true;
  }

  if (request.method === "GET" && action === "job") {
    json(response, 200, { job: getJob(source) ? jobToSnake(getJob(source) as SyncJobView) : null });
    return true;
  }

  if (request.method === "POST" && action === "sync") {
    const { job, started } = startImportJob(sessionManager, adapter, "sync");
    json(response, 202, { job: jobToSnake(job), started });
    return true;
  }

  if (request.method === "POST" && action === "backup") {
    const body = await readJsonBody(request) as { ids?: unknown };
    if (!Array.isArray(body.ids) || !body.ids.length) {
      throw new MomokaHttpError(400, "ids 必须是非空字符串数组");
    }
    if (body.ids.length > 500) {
      throw new MomokaHttpError(400, "单次备份最多 500 个会话，请分批或改用 Sync");
    }
    const ids = body.ids.map((id) => String(id)).filter(Boolean);
    const { job, started } = startImportJob(sessionManager, adapter, "backup", ids);
    json(response, 202, { job: jobToSnake(job), started });
    return true;
  }

  return false;
}

function jobToSnake(job: SyncJobView): Record<string, unknown> {
  return {
    id: job.id,
    source: job.source,
    kind: job.kind,
    status: job.status,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    total: job.total,
    processed: job.processed,
    imported: job.imported,
    updated: job.updated,
    skipped: job.skipped,
    failed: job.failed.map((failure) => ({
      external_id: failure.externalId,
      title: failure.title,
      reason: failure.reason,
    })),
    error: job.error ?? null,
    origin: job.origin ?? null,
  };
}

/** 供其它路由复用：把外来查询串解析成来源筛选值 */
export function parseSourceFilter(value: string | null): SessionSource | null {
  return value && isSessionSource(value) ? value : null;
}
