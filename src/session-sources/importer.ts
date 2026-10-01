import { randomUUID } from "node:crypto";
import path from "node:path";

import type { SessionManager } from "../session-manager.js";
import type { ExternalSessionSource } from "../session-source.js";
import { externalSessionId } from "./parse.js";
import type { SourceAdapter, SourceSessionSummary } from "./types.js";

/**
 * 外部来源导入编排：列出 → 比对指纹 → 只导入「新增 + 已变更」。
 *
 * 两条关键设计：
 * 1. **不用单独的同步账本文件**。「哪些外部会话已导入」「上次同步时间」都能从会话记录自身的
 *    `sourceRef` 直接导出，多存一份账本只会带来两份真值不一致的风险。
 * 2. **同步是后台作业**。codex 会话目录实测 1.1 GB、proma 471 MB，整源同步是分钟级操作，
 *    不能塞进一个 HTTP 请求里等。改为「启动作业 + 轮询进度」，并对同一来源做单飞（single-flight）。
 */

export interface SourceMirrorInfo {
  sessionId: string;
  externalId: string;
  fingerprint: string;
  syncedAt: string;
  title: string;
}

export interface SourceSessionRow extends SourceSessionSummary {
  /** 是否已有本地镜像 */
  imported: boolean;
  /** 已有镜像但源侧指纹已变 */
  needsUpdate: boolean;
  /** 本地镜像的会话 id */
  sessionId: string | null;
}

export interface SourceOverview {
  source: ExternalSessionSource;
  label: string;
  available: boolean;
  root: string;
  reason?: string;
  /** 已导入的镜像数量 */
  importedCount: number;
  /** 本地镜像里最新的 syncedAt */
  lastSyncAt: string | null;
  job: SyncJobView | null;
}

export interface SyncJobFailure {
  externalId: string;
  title: string;
  reason: string;
}

export interface SyncJobView {
  id: string;
  source: ExternalSessionSource;
  kind: "sync" | "backup" | "archive";
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  /** 本次目标会话数（已过滤掉无需更新的） */
  total: number;
  processed: number;
  imported: number;
  updated: number;
  /** 已是最新、无需动作而被跳过的会话数 */
  skipped: number;
  failed: SyncJobFailure[];
  error?: string;
  /** kind=archive 时的来源说明（压缩包路径 + 解压出的数据根） */
  origin?: string;
}

/** 作业的运行期内部字段：不对外暴露（不进入 SyncJobView） */
interface JobRuntime {
  cleanup?: () => Promise<void>;
  /** 来源路径前缀（迁移压缩包场景） */
  sourcePathPrefix?: string;
  baseDir?: string;
}

const jobs = new Map<ExternalSessionSource, { job: SyncJobView; runtime: JobRuntime }>();

function toView(job: SyncJobView): SyncJobView {
  return {
    id: job.id,
    source: job.source,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    total: job.total,
    processed: job.processed,
    imported: job.imported,
    updated: job.updated,
    skipped: job.skipped,
    failed: job.failed.map((failure) => ({ ...failure })),
    ...(job.error ? { error: job.error } : {}),
    ...(job.origin ? { origin: job.origin } : {}),
  };
}

/** 读取本地已有的来源镜像（externalId → 本地会话信息） */
export async function mirrorsByExternalId(
  sessionManager: SessionManager,
  source: ExternalSessionSource,
): Promise<Map<string, SourceMirrorInfo>> {
  const mirrors = new Map<string, SourceMirrorInfo>();
  for (const session of await sessionManager.listSessions(true)) {
    const ref = session.sourceRef;
    if (!ref || ref.kind !== source) continue;
    mirrors.set(ref.externalId, {
      sessionId: session.id,
      externalId: ref.externalId,
      fingerprint: ref.fingerprint,
      syncedAt: ref.syncedAt,
      title: session.name,
    });
  }
  return mirrors;
}

/** 设置页顶部需要的轻量概览：只做 probe，不做列表（列表按来源单独拉取） */
export async function describeSources(
  sessionManager: SessionManager,
  adapters: SourceAdapter[],
): Promise<SourceOverview[]> {
  const overviews: SourceOverview[] = [];
  for (const adapter of adapters) {
    const [probe, mirrors] = await Promise.all([
      adapter.probe().catch((error: unknown) => ({
        available: false,
        root: "",
        reason: error instanceof Error ? error.message : String(error),
      })),
      mirrorsByExternalId(sessionManager, adapter.source),
    ]);
    const syncedTimes = [...mirrors.values()].map((mirror) => mirror.syncedAt).filter(Boolean).sort();
    overviews.push({
      source: adapter.source,
      label: adapter.label,
      available: probe.available,
      root: probe.root,
      ...(probe.reason ? { reason: probe.reason } : {}),
      importedCount: mirrors.size,
      lastSyncAt: syncedTimes.length ? syncedTimes[syncedTimes.length - 1] : null,
      job: jobs.has(adapter.source) ? toView(jobs.get(adapter.source)!.job) : null,
    });
  }
  return overviews;
}

export interface ListOptions {
  query?: string;
  filter?: "all" | "new" | "changed" | "imported";
  offset?: number;
  limit?: number;
}

export interface ListResult {
  source: ExternalSessionSource;
  /** 源内会话总数 */
  total: number;
  /** 过滤后命中的数量 */
  matched: number;
  offset: number;
  limit: number;
  items: SourceSessionRow[];
}

export async function listSourceSessions(
  sessionManager: SessionManager,
  adapter: SourceAdapter,
  options: ListOptions = {},
): Promise<ListResult> {
  const [summaries, mirrors] = await Promise.all([
    adapter.list(),
    mirrorsByExternalId(sessionManager, adapter.source),
  ]);
  const query = (options.query ?? "").trim().toLocaleLowerCase();
  const filter = options.filter ?? "all";
  let rows: SourceSessionRow[] = summaries.map((summary) => {
    const mirror = mirrors.get(summary.externalId);
    const imported = mirror !== undefined;
    return {
      ...summary,
      imported,
      needsUpdate: imported && mirror.fingerprint !== summary.fingerprint,
      sessionId: mirror?.sessionId ?? null,
    };
  });
  if (filter === "new") rows = rows.filter((row) => !row.imported);
  else if (filter === "changed") rows = rows.filter((row) => row.needsUpdate);
  else if (filter === "imported") rows = rows.filter((row) => row.imported);
  if (query) {
    rows = rows.filter((row) =>
      row.title.toLocaleLowerCase().includes(query)
      || row.externalId.toLocaleLowerCase().includes(query)
      || (row.workspace ?? "").toLocaleLowerCase().includes(query),
    );
  }
  const total = rows.length;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  return {
    source: adapter.source,
    total: summaries.length,
    matched: total,
    offset,
    limit,
    items: rows.slice(offset, offset + limit),
  };
}

export function getJob(source: ExternalSessionSource): SyncJobView | null {
  const entry = jobs.get(source);
  return entry ? toView(entry.job) : null;
}

export function clearJob(source: ExternalSessionSource): void {
  jobs.delete(source);
}

export interface StartJobResult {
  job: SyncJobView;
  /** 同来源已有作业在跑时为 false（单飞），此时返回的是既有作业 */
  started: boolean;
}

export interface StartJobOptions {
  /** 迁移压缩包场景：把源路径记成 `zip:<包路径>#<内部相对路径>`，保留真实来源 */
  sourcePathPrefix?: string;
  /** 与 sourcePathPrefix 配合的基目录（解压根） */
  baseDir?: string;
  /** 解压根的临时清理回调；作业结束时执行 */
  cleanup?: () => Promise<void>;
  /** kind=archive 时的来源说明 */
  origin?: string;
}

/**
 * 启动导入作业。
 * - kind=sync：导入该来源全部「新增 + 已变更」会话
 * - kind=backup：只处理 ids 指定的会话（其中已是最新的会被计入 skipped）
 * - kind=archive：从迁移压缩包解压出的数据根导入，与 sync 同语义
 *
 * 各模式都会把「已是最新、无需动作」的会话计入 skipped，而不是无意义地重写一遍。
 */
export function startImportJob(
  sessionManager: SessionManager,
  adapter: SourceAdapter,
  kind: "sync" | "backup" | "archive",
  ids: string[] = [],
  options: StartJobOptions = {},
): StartJobResult {
  const existing = jobs.get(adapter.source);
  if (existing && existing.job.status === "running") {
    return { job: toView(existing.job), started: false };
  }
  const job: SyncJobView = {
    id: `job_${randomUUID().replace(/-/gu, "").slice(0, 12)}`,
    source: adapter.source,
    kind,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    processed: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: [],
    ...(options.origin ? { origin: options.origin } : {}),
  };
  jobs.set(adapter.source, { job, runtime: { ...options } });
  void runImportJob(sessionManager, adapter, job, kind, new Set(ids));
  return { job: toView(job), started: true };
}

async function runImportJob(
  sessionManager: SessionManager,
  adapter: SourceAdapter,
  job: SyncJobView,
  kind: "sync" | "backup" | "archive",
  ids: Set<string>,
): Promise<void> {
  const runtime = jobs.get(adapter.source)?.runtime ?? {};
  try {
    const [summaries, mirrors] = await Promise.all([
      adapter.list(),
      mirrorsByExternalId(sessionManager, adapter.source),
    ]);
    const targets = summaries.filter((summary) => {
      if (kind === "backup" && !ids.has(summary.externalId)) return false;
      const mirror = mirrors.get(summary.externalId);
      return !mirror || mirror.fingerprint !== summary.fingerprint;
    });
    const considered = kind === "backup"
      ? summaries.filter((summary) => ids.has(summary.externalId)).length
      : summaries.length;
    job.total = targets.length;
    job.skipped = Math.max(0, considered - targets.length);

    for (const summary of targets) {
      try {
        await importOne(sessionManager, adapter, summary, mirrors, job, runtime);
      } catch (error) {
        job.failed.push({
          externalId: summary.externalId,
          title: summary.title,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      job.processed += 1;
    }
    job.status = "done";
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    job.finishedAt = new Date().toISOString();
    await runtime.cleanup?.().catch(() => undefined);
  }
}

async function importOne(
  sessionManager: SessionManager,
  adapter: SourceAdapter,
  summary: SourceSessionSummary,
  mirrors: Map<string, SourceMirrorInfo>,
  job: SyncJobView,
  runtime: JobRuntime,
): Promise<void> {
  const sessionId = externalSessionId(adapter.source, summary.externalId);
  const { summary: fresh, messages } = await adapter.read(summary.externalId);
  const now = new Date().toISOString();
  const existing = mirrors.get(summary.externalId);
  const sourcePath = runtime.sourcePathPrefix && runtime.baseDir && fresh.path
    ? `${runtime.sourcePathPrefix}#${path.relative(runtime.baseDir, fresh.path).split(path.sep).join("/")}`
    : fresh.path || summary.path;
  const result = await sessionManager.importSessionSnapshot({
    sessionId,
    source: adapter.source,
    title: fresh.title || summary.title,
    createdAt: fresh.createdAt || summary.createdAt,
    updatedAt: fresh.updatedAt || summary.updatedAt,
    messages,
    sourceRef: {
      kind: adapter.source,
      externalId: summary.externalId,
      sourcePath,
      fingerprint: fresh.fingerprint || summary.fingerprint,
      importedAt: existing ? existing.syncedAt : now,
      syncedAt: now,
    },
  });
  if (result.created) job.imported += 1;
  else job.updated += 1;
}
