import { mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { judgmentFromDisk, judgmentToDisk, outputFromDisk, outputToDisk } from "./casing.js";
import { readJsonList, writeJsonList } from "./json-file.js";
import { atomicWriteJson } from "./write-queue.js";
import { ACTIVE_CONFIDENCE, consolidateEntry, newMemoryId, type MemoryEntryLike, type MemoryStatus, type MemoryType, type TypedMemoryInput } from "./memory-extract.js";
import { recall, type RecallOptions, type ScoredMemory } from "./memory-retrieval.js";
import { INDEX_PREFILTER_MIN_ENTRIES, IndexStore } from "./index-store.js";
import type { JudgmentRecord, OutputRecord } from "./types.js";

const CONTEXT_WINDOW_CHARS = 20;

export interface LongTermMemoryEntry extends MemoryEntryLike {
  id: string;
  content: string;
  topic: string;
  /** 归属层：用户全局 / 项目 / 某个 Agent / 某个会话 */
  ownerScope: MemoryScope;
  /** 该层内的具体 id（user 与 project 用固定值） */
  scopeId: string;
  source: "judgment" | "explicit" | "legacy" | "dispatch";
  outputId?: string;
  createdAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  /** 记忆类型（P3）：episode / fact / preference / procedure / decision */
  type?: MemoryType;
  /** 生命周期状态（P3）：candidate / active / superseded / rejected */
  status?: MemoryStatus;
  /** 0..1，合并时会取高并加增益 */
  confidence?: number;
  /** 溯源：out:<outputId> / dispatch:<id> / ses:<sessionId> */
  sourceRefs?: string[];
}

/** 记忆作用域：P2 的分区维度 */
export type MemoryScope = "user" | "project" | "agent" | "session";

export interface MemoryScopeRef {
  scope: MemoryScope;
  scopeId: string;
}

export const USER_SCOPE: MemoryScopeRef = { scope: "user", scopeId: "user" };
export const PROJECT_SCOPE: MemoryScopeRef = { scope: "project", scopeId: "project" };

export interface SearchOptions {
  limit?: number;
  /** 只在某个作用域内检索；缺省 USER_SCOPE */
  ref?: MemoryScopeRef;
}

const LONG_TERM_MAX_ENTRIES_PER_SCOPE = 500;
const PROMOTE_SCORE = 6;
const PROMOTE_MAX_CHARS = 300;
const MIGRATION_MARKER = ".lt-migrated.json";

/**
 * 长期记忆存储。
 *
 * P2 起按作用域分区落盘：`<memoryDir>/memory/lt/<scope>/<scopeId>.json`
 * （user / project 用固定 scopeId；agent / session 各自一份）。
 * 旧的全局 `<memoryDir>/.long-term.json` 会在首次访问时**幂等迁移**到 user 作用域，
 * 原文件保留不动（可回滚），迁移完成后写 `<memoryDir>/memory/lt/.lt-migrated.json` 标记。
 */
export class MemoryStore {
  constructor(readonly memoryDir: string, options: { index?: IndexStore; indexPrefilterMinEntries?: number } = {}) {
    this.memoryDir = path.resolve(memoryDir);
    this.index = options.index ?? null;
    this.indexPrefilterMinEntries = options.indexPrefilterMinEntries ?? INDEX_PREFILTER_MIN_ENTRIES;
  }
  private migrationChecked = false;
  /** 索引层（P7，可选）：JSON 仍是事实源，索引只承担查询与全文检索，不可用时静默降级 */
  readonly index: IndexStore | null;
  /** 语料少于该条数时不走索引预筛（内存扫描更快也更准） */
  private readonly indexPrefilterMinEntries: number;

  outputsPath() { return path.join(this.memoryDir, ".outputs", "outputs.json"); }
  annotationLedgerPath() { return path.join(this.memoryDir, ".annotations", "ledger.json"); }
  /** 长期记忆根目录（分区父目录） */
  longTermRoot() { return path.join(this.memoryDir, "memory", "lt"); }
  /** 某个作用域的分区文件 */
  longTermPath(ref: MemoryScopeRef = USER_SCOPE) { return path.join(this.longTermRoot(), ref.scope, `${ref.scopeId}.json`); }
  /** 旧版全局长期记忆文件（迁移来源） */
  legacyLongTermPath() { return path.join(this.memoryDir, ".long-term.json"); }
  private migrationMarkerPath() { return path.join(this.longTermRoot(), MIGRATION_MARKER); }

  async recordOutput(input: Omit<OutputRecord, "timestamp"> & { timestamp?: string }): Promise<OutputRecord> {
    await mkdir(path.dirname(this.outputsPath()), { recursive: true });
    const record: OutputRecord = { ...input, timestamp: input.timestamp ?? new Date().toISOString() };
    const records = (await readJsonList(this.outputsPath())).map(outputFromDisk).filter((item) => item.outputId !== record.outputId);
    records.push(record);
    await writeJsonList(this.outputsPath(), records.slice(-200).map(outputToDisk));
    return record;
  }

  async getOutput(outputId: string): Promise<OutputRecord | null> {
    return (await readJsonList(this.outputsPath())).map(outputFromDisk).reverse().find((item) => item.outputId === outputId) ?? null;
  }

  async recordJudgment(input: { outputId: string; score: number; context?: string; comment?: string }): Promise<JudgmentRecord> {
    await mkdir(path.dirname(this.annotationLedgerPath()), { recursive: true });
    const output = await this.getOutput(input.outputId);
    const selected = (input.context ?? "").trim();
    const full = output?.response.trim() ?? "";
    const index = selected ? full.indexOf(selected) : 0;
    const quote = selected || full.slice(0, 2000);
    const record: JudgmentRecord = {
      outputId: input.outputId, score: input.score, context: quote, contextSource: selected ? "selected_text" : "full_output", quote,
      leftContext: selected && index >= 0 ? full.slice(Math.max(0, index - CONTEXT_WINDOW_CHARS), index) : "",
      rightContext: selected && index >= 0 ? full.slice(index + selected.length, index + selected.length + CONTEXT_WINDOW_CHARS) : "",
      contextWindowChars: CONTEXT_WINDOW_CHARS, comment: (input.comment ?? "").trim().slice(0, 1000), commentSource: input.comment?.trim() ? "user_comment" : "none",
      topic: output?.topic ?? "", matchedSkills: [], timestamp: new Date().toISOString(),
    };
    const records = (await readJsonList(this.annotationLedgerPath())).map(judgmentFromDisk);
    records.push(record);
    await writeJsonList(this.annotationLedgerPath(), records.map(judgmentToDisk));
    return record;
  }

  /**
   * 长期记忆：批注晋升。高分（≥6）或带用户批注的判断自动沉淀为跨会话记忆。
   * 返回 null 表示没有值得记忆的内容或该作用域内已存在相同记忆（去重）。
   */
  async promoteToLongTerm(judgment: JudgmentRecord, ref: MemoryScopeRef = USER_SCOPE): Promise<LongTermMemoryEntry | null> {
    const content = (judgment.comment || judgment.quote || "").trim().slice(0, PROMOTE_MAX_CHARS);
    if (!content) return null;
    const worthy = judgment.score >= PROMOTE_SCORE || judgment.commentSource === "user_comment";
    if (!worthy) return null;
    const records = await this.readScope(ref);
    if (records.some((record) => record.content === content)) return null;
    const entry: LongTermMemoryEntry = {
      id: `mem_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      content,
      topic: judgment.topic ?? "",
      ownerScope: ref.scope,
      scopeId: ref.scopeId,
      source: "judgment",
      outputId: judgment.outputId,
      createdAt: new Date().toISOString(),
      accessCount: 0,
    };
    records.push(entry);
    await this.writeScope(ref, records.slice(-LONG_TERM_MAX_ENTRIES_PER_SCOPE));
    return entry;
  }

  /**
   * 按 topic 在单个作用域内检索（命中更新访问统计）。
   * 兼容旧签名：第二个参数既可传 limit 数字，也可传 { limit, ref }。
   */
  async searchLongTerm(topic: string, limitOrOptions: number | SearchOptions = 3): Promise<LongTermMemoryEntry[]> {
    const options: SearchOptions = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const ref = options.ref ?? USER_SCOPE;
    const scored = await this.recallScopes(topic, [ref], { limit: options.limit ?? 3 });
    return scored.map((item) => item.entry);
  }

  /**
   * 跨作用域检索：按 refs 顺序收集后统一打分（同 id 去重），取全局前 limit。
   * 值日生/执行者注入用「自己的 agent 作用域 → 项目级 → user 全局」这条链。
   */
  async searchScopes(topic: string, refs: MemoryScopeRef[], limit = 3): Promise<LongTermMemoryEntry[]> {
    const scored = await this.recallScopes(topic, refs, { limit });
    return scored.map((item) => item.entry);
  }

  /**
   * 混合检索主入口（P4）：跨作用域合并 → 混合打分 → 预算裁剪 → 访问统计回写。
   * 返回值带 `why`（为何被召回）与原始条目的 sourceRefs（溯源）。
   */
  async recallScopes(
    topic: string,
    refs: MemoryScopeRef[],
    options: RecallOptions = {},
  ): Promise<Array<ScoredMemory<LongTermMemoryEntry>>> {
    if (refs.length === 0) return [];
    const all: LongTermMemoryEntry[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      for (const entry of await this.readScope(ref)) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        all.push(entry);
      }
    }

    // 语料量大时（P7）：先用索引召回候选（FTS 对 ≥3 字有效、短查询回落 LIKE），再做混合打分；
    // 索引不可用或召回为空 → 退回全量扫描，行为与 P4 一致。
    let candidates = all;
    if (this.index && all.length >= this.indexPrefilterMinEntries && await this.index.open()) {
      const hits = await this.index.searchMemories(topic, { limit: 200 });
      const ids = new Set(hits.map((hit) => hit.id));
      const filtered = ids.size > 0 ? all.filter((entry) => ids.has(entry.id)) : [];
      if (filtered.length > 0) candidates = filtered;
    }
    const picked = recall(candidates, topic, options);

    // 访问统计回写（按分区聚合，避免同一分区反复写盘）
    const byScope = new Map<string, { ref: MemoryScopeRef; ids: Set<string> }>();
    for (const item of picked) {
      const ref: MemoryScopeRef = { scope: item.entry.ownerScope, scopeId: item.entry.scopeId };
      const key = `${ref.scope}/${ref.scopeId}`;
      if (!byScope.has(key)) byScope.set(key, { ref, ids: new Set() });
      byScope.get(key)!.ids.add(item.entry.id);
    }
    const at = new Date().toISOString();
    for (const { ref, ids } of byScope.values()) {
      const records = await this.readScope(ref);
      let changed = false;
      for (const record of records) {
        if (!ids.has(record.id)) continue;
        record.lastAccessedAt = at;
        record.accessCount = (record.accessCount ?? 0) + 1;
        changed = true;
      }
      if (changed) await this.writeScope(ref, records);
      for (const item of picked) {
        if (!ids.has(item.entry.id)) continue;
        item.entry.lastAccessedAt = at;
        item.entry.accessCount = (item.entry.accessCount ?? 0) + 1;
      }
    }
    return picked;
  }

  /** 读取某个作用域的全部条目（P10 的列表/编辑接口会用） */
  async listScope(ref: MemoryScopeRef): Promise<LongTermMemoryEntry[]> {
    return await this.readScope(ref);
  }

  /**
   * 写入一条**类型化**记忆（P3 主入口）：抽取 → 合并/取代/新增，一次搞定。
   * 与 promoteToLongTerm 的区别：后者是旧的「整段晋升」，前者带 type/status/confidence/sourceRefs，
   * 且会与同作用域内的同内容条目合并、与相反结论的条目做取代。
   */
  async rememberTyped(
    input: TypedMemoryInput,
    ref: MemoryScopeRef = USER_SCOPE,
    meta: { topic?: string; outputId?: string; source?: LongTermMemoryEntry["source"] } = {},
  ): Promise<{ action: "inserted" | "merged" | "superseded"; entry: LongTermMemoryEntry | null; targetId: string }> {
    const records = await this.readScope(ref);
    const result = consolidateEntry<LongTermMemoryEntry>(records, input, { idFactory: newMemoryId });
    // 给新增的那条补上作用域与来源元信息（consolidateEntry 不认识这些字段）
    const entries = result.entries.map((entry) => {
      if (entry.id !== result.targetId) return entry;
      return {
        ...entry,
        ownerScope: ref.scope,
        scopeId: ref.scopeId,
        topic: entry.topic ?? meta.topic ?? "",
        source: entry.source ?? meta.source ?? "judgment",
        ...(meta.outputId ? { outputId: meta.outputId } : {}),
        accessCount: entry.accessCount ?? 0,
      } as LongTermMemoryEntry;
    });
    await this.writeScope(ref, entries.slice(-LONG_TERM_MAX_ENTRIES_PER_SCOPE));
    return {
      action: result.action,
      entry: entries.find((entry) => entry.id === result.targetId) ?? null,
      targetId: result.targetId,
    };
  }

  /** 直接替换某个作用域的全部条目（供记忆面板的编辑/删除使用） */
  async replaceScope(ref: MemoryScopeRef, entries: LongTermMemoryEntry[]): Promise<void> {
    await this.writeScope(ref, entries);
  }

  /**
   * 把某个作用域的条目同步到索引层（P7）。索引失败不影响主流程——
   * 它随时可以从 JSON 重建，所以这里只记日志不抛错。
   */
  async syncIndex(ref: MemoryScopeRef): Promise<number> {
    if (!this.index) return 0;
    if (!(await this.index.open())) return 0;
    const entries = await this.readScope(ref);
    return await this.index.upsertMemories(entries.map((entry) => ({
      id: entry.id,
      scope: entry.ownerScope,
      scopeId: entry.scopeId,
      type: entry.type,
      status: entry.status,
      confidence: entry.confidence,
      content: entry.content,
      sourceRefs: entry.sourceRefs,
      createdAt: entry.createdAt,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
    })));
  }

  /** 全量重建索引（JSON → SQLite），用于换库/损坏/版本升级后 */
  async rebuildIndex(): Promise<{ available: boolean; written: number }> {
    if (!this.index) return { available: false, written: 0 };
    if (!(await this.index.open())) return { available: false, written: 0 };
    const refs: MemoryScopeRef[] = [USER_SCOPE, PROJECT_SCOPE];
    const scopesDir = path.join(this.longTermRoot());
    const scopeNames = await readdir(scopesDir, { withFileTypes: true }).catch(() => []);
    for (const scopeDir of scopeNames.filter((entry) => entry.isDirectory())) {
      const scope = scopeDir.name as MemoryScope;
      const files = await readdir(path.join(scopesDir, scopeDir.name), { withFileTypes: true }).catch(() => []);
      for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
        refs.push({ scope, scopeId: file.name.replace(/\.json$/u, "") });
      }
    }
    const seen = new Set<string>();
    const payload: Array<Parameters<IndexStore["upsertMemories"]>[0][number]> = [];
    for (const ref of refs) {
      for (const entry of await this.readScope(ref)) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        payload.push({
          id: entry.id,
          scope: entry.ownerScope,
          scopeId: entry.scopeId,
          type: entry.type,
          status: entry.status,
          confidence: entry.confidence,
          content: entry.content,
          sourceRefs: entry.sourceRefs,
          createdAt: entry.createdAt,
        });
      }
    }
    return await this.index.rebuildMemories(payload);
  }

  /** 幂等迁移旧版全局长期记忆到 user 作用域；返回迁移条数 */
  async migrateLegacy(): Promise<number> {
    if (this.migrationChecked) return 0;
    this.migrationChecked = true;
    try {
      await readFile(this.migrationMarkerPath(), "utf8");
      return 0;
    } catch { /* 尚未迁移 */ }

    const legacy = (await readJsonList(this.legacyLongTermPath())).filter(isLongTermEntry);
    let imported = 0;
    if (legacy.length > 0) {
      const current = await this.readScope(USER_SCOPE, { skipMigration: true });
      const known = new Set(current.map((entry) => entry.content));
      for (const entry of legacy) {
        if (known.has(entry.content)) continue;
        known.add(entry.content);
        current.push({ ...entry, ownerScope: "user", scopeId: "user", source: entry.source === "explicit" ? "explicit" : "legacy" });
        imported += 1;
      }
      await this.writeScope(USER_SCOPE, current);
    }
    await atomicWriteJson(this.migrationMarkerPath(), { migratedAt: new Date().toISOString(), imported });
    return imported;
  }

  // ---------------------------------------------------------------- 内部

  private async readScope(ref: MemoryScopeRef, options: { skipMigration?: boolean } = {}): Promise<LongTermMemoryEntry[]> {
    if (!options.skipMigration && ref.scope === "user" && ref.scopeId === "user") await this.migrateLegacy();
    const parsed = await readJsonList(this.longTermPath(ref));
    return parsed.filter(isLongTermEntry).map((entry) => ({
      ...entry,
      ownerScope: ref.scope,
      scopeId: ref.scopeId,
      source: entry.source ?? "judgment",
      // P3 之前的旧条目没有类型/状态：按「已生效的事件记忆」补默认值，避免检索时被当作无效条目
      type: entry.type ?? "episode",
      status: entry.status ?? "active",
      confidence: typeof entry.confidence === "number" ? entry.confidence : ACTIVE_CONFIDENCE,
      sourceRefs: Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [],
      accessCount: typeof entry.accessCount === "number" ? entry.accessCount : 0,
    }));
  }

  private async writeScope(ref: MemoryScopeRef, records: LongTermMemoryEntry[]): Promise<void> {
    await atomicWriteJson(this.longTermPath(ref), records);
    // 写后同步索引（P7）：失败只记日志，索引可随时从 JSON 重建
    if (this.index) {
      try {
        await this.index.open();
        await this.index.upsertMemories(records.map((entry) => ({
          id: entry.id,
          scope: ref.scope,
          scopeId: ref.scopeId,
          type: entry.type,
          status: entry.status,
          confidence: entry.confidence,
          content: entry.content,
          sourceRefs: entry.sourceRefs,
          createdAt: entry.createdAt,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
        })));
      } catch { /* 索引写失败不影响 JSON 事实源 */ }
    }
  }
}

function isLongTermEntry(value: unknown): value is LongTermMemoryEntry {
  return typeof value === "object" && value !== null
    && typeof (value as LongTermMemoryEntry).id === "string"
    && typeof (value as LongTermMemoryEntry).content === "string";
}
