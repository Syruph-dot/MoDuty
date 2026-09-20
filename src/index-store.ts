import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * 索引存储（P7）：用 Node 内置 `node:sqlite` 建一份可查询的索引库（`<dataDir>/index.db`）。
 *
 * 为什么不是「迁移到 SQLite」：JSON 仍是事实源（可读、可 diff、可 git 审计），
 * SQLite 只承担**查询与全文检索**这两件 JSON 做不好的事。因此这里是双写 + 可重建：
 * 丢了、坏了、版本不对，都能从 JSON 重建，不影响主流程。
 *
 * 中文分词实测结论（Node 22 自带 SQLite 3.50 FTS5）：
 * - `unicode61` 把整句中文切成一个 token，`MATCH '计划'` 命中 0，不可用；
 * - `trigram` 对 ≥3 字查询有效（`计划验证`/`基沃托斯` 命中），但 2 字（`计划`/`偏好`）命中 0。
 * 所以检索策略是：**≥3 字走 FTS5(trigram)，<3 字或 FTS 空结果回退 LIKE**。
 *
 * 降级：任何一步失败（模块不可用、库打不开、建表失败）→ `available=false`，
 * 所有方法返回空结果/静默，让调用方继续走原来的 JSON 路径。
 */

/** 建表语句：普通表用于结构化查询，`_fts` 表用于全文检索 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     scope TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     type TEXT,
     status TEXT,
     confidence REAL,
     content TEXT NOT NULL,
     source_refs TEXT,
     created_at TEXT,
     updated_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS plans (
     id TEXT PRIMARY KEY,
     goal TEXT NOT NULL,
     status TEXT NOT NULL,
     dispatcher_id TEXT,
     steps INTEGER,
     updated_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS dispatches (
     id TEXT PRIMARY KEY,
     dispatcher_id TEXT,
     target_agent_id TEXT,
     state TEXT,
     task TEXT,
     updated_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     role TEXT,
     content TEXT,
     created_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, tokenize='trigram')`,
];

export interface IndexedMemory {
  id: string;
  scope: string;
  scopeId: string;
  type?: string;
  status?: string;
  confidence?: number;
  content: string;
  sourceRefs?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface IndexedMessage {
  id: string;
  sessionId: string;
  role?: string;
  content: string;
  createdAt?: string;
}

export interface MemorySearchHit {
  id: string;
  /** 命中方式：fts（≥3 字）或 like（短查询回落） */
  via: "fts" | "like";
  score: number;
}

/** FTS5 trigram 的最小可用查询长度 */
export const FTS_MIN_CHARS = 3;

/** 少于该条数时没必要走索引（内存扫描更快、也更准），直接回落 JSON 路径 */
export const INDEX_PREFILTER_MIN_ENTRIES = 200;

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
  close: () => void;
};

export class IndexStore {
  private db: SqliteDatabase | null = null;
  private opened = false;
  private lastError: string | null = null;

  constructor(readonly dataDir: string, readonly fileName = "index.db") {}

  dbPath(): string {
    return path.join(path.resolve(this.dataDir), this.fileName);
  }

  /** 惰性打开并建表；返回是否可用（不抛异常） */
  async open(): Promise<boolean> {
    if (this.opened) return this.available;
    this.opened = true;
    try {
      await mkdir(path.resolve(this.dataDir), { recursive: true });
      const moduleName = "node:sqlite";
      const mod = (await import(/* @vite-ignore */ moduleName)) as { DatabaseSync?: new (file: string) => SqliteDatabase };
      if (!mod.DatabaseSync) {
        this.lastError = "node:sqlite 不可用（DatabaseSync 缺失）";
        return false;
      }
      const database = new mod.DatabaseSync(this.dbPath());
      for (const statement of SCHEMA) database.exec(statement);
      this.db = database;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.db = null;
      return false;
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  get error(): string | null {
    return this.lastError;
  }

  close(): void {
    try { this.db?.close(); } catch { /* 忽略关闭失败 */ }
    this.db = null;
    this.opened = false;
  }

  async status(): Promise<{ available: boolean; path: string; error: string | null; memories: number; messages: number }> {
    const ok = await this.open();
    if (!ok || !this.db) return { available: false, path: this.dbPath(), error: this.lastError, memories: 0, messages: 0 };
    const memoryCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count?: number })?.count ?? 0);
    const messageCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count?: number })?.count ?? 0);
    return { available: true, path: this.dbPath(), error: null, memories: memoryCount, messages: messageCount };
  }

  // ---------------------------------------------------------------- 记忆

  async upsertMemory(entry: IndexedMemory): Promise<boolean> {
    if (!(await this.open()) || !this.db) return false;
    try {
      const db = this.db;
      db.prepare(
        `INSERT INTO memories (id, scope, scope_id, type, status, confidence, content, source_refs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scope=excluded.scope, scope_id=excluded.scope_id, type=excluded.type, status=excluded.status,
           confidence=excluded.confidence, content=excluded.content, source_refs=excluded.source_refs,
           updated_at=excluded.updated_at`,
      ).run(
        entry.id, entry.scope, entry.scopeId, entry.type ?? null, entry.status ?? null,
        entry.confidence ?? null, entry.content, JSON.stringify(entry.sourceRefs ?? []),
        entry.createdAt ?? null, entry.updatedAt ?? new Date().toISOString(),
      );
      db.prepare("DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)").run(entry.id);
      db.prepare("INSERT INTO memories_fts (rowid, content) SELECT rowid, content FROM memories WHERE id = ?").run(entry.id);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async upsertMemories(entries: IndexedMemory[]): Promise<number> {
    let written = 0;
    for (const entry of entries) {
      if (await this.upsertMemory(entry)) written += 1;
    }
    return written;
  }

  async deleteMemory(id: string): Promise<boolean> {
    if (!(await this.open()) || !this.db) return false;
    try {
      const db = this.db;
      db.prepare("DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)").run(id);
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** 清空并按给定快照重建（JSON 是事实源，索引可随时重算） */
  async rebuildMemories(entries: IndexedMemory[]): Promise<{ available: boolean; written: number }> {
    if (!(await this.open()) || !this.db) return { available: false, written: 0 };
    try {
      this.db.exec("DELETE FROM memories");
      this.db.exec("DELETE FROM memories_fts");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return { available: true, written: 0 };
    }
    return { available: true, written: await this.upsertMemories(entries) };
  }

  /**
   * 记忆检索：≥3 字走 FTS5(trigram)，<3 字或 FTS 无结果回退 LIKE。
   * 返回命中的 id 与分数，排序由调用方（混合打分）决定，这里只做候选召回。
   */
  async searchMemories(query: string, options: { limit?: number; scope?: string } = {}): Promise<MemorySearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (!(await this.open()) || !this.db) return [];
    const limit = Math.max(1, options.limit ?? 50);
    const scopeClause = options.scope ? " AND m.scope = ?" : "";
    const scopeParams = options.scope ? [options.scope] : [];

    if ([...trimmed].length >= FTS_MIN_CHARS) {
      try {
        const rows = this.db
          .prepare(
            `SELECT m.id AS id, bm25(memories_fts) AS rank
             FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
             WHERE memories_fts MATCH ?${scopeClause}
             ORDER BY rank LIMIT ?`,
          )
          .all(...[trimmed, ...scopeParams, limit]) as Array<{ id?: string; rank?: number }>;
        const hits = rows
          .filter((row) => typeof row.id === "string")
          .map((row) => ({ id: String(row.id), via: "fts" as const, score: -(row.rank ?? 0) }));
        if (hits.length > 0) return hits;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      const rows = this.db
        .prepare(
          `SELECT m.id AS id FROM memories m
           WHERE m.content LIKE '%' || ? || '%'${scopeClause}
           ORDER BY m.updated_at DESC LIMIT ?`,
        )
        .all(...[trimmed, ...scopeParams, limit]) as Array<{ id?: string }>;
      return rows.filter((row) => typeof row.id === "string").map((row) => ({ id: String(row.id), via: "like" as const, score: 1 }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  // ---------------------------------------------------------------- 其它实体

  async upsertPlan(plan: { id: string; goal: string; status: string; dispatcherId?: string; steps: number; updatedAt?: string }): Promise<boolean> {
    if (!(await this.open()) || !this.db) return false;
    try {
      this.db.prepare(
        `INSERT INTO plans (id, goal, status, dispatcher_id, steps, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET goal=excluded.goal, status=excluded.status, dispatcher_id=excluded.dispatcher_id,
           steps=excluded.steps, updated_at=excluded.updated_at`,
      ).run(plan.id, plan.goal, plan.status, plan.dispatcherId ?? null, plan.steps, plan.updatedAt ?? new Date().toISOString());
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async upsertDispatch(entry: { id: string; dispatcherId?: string; targetAgentId?: string; state?: string; task?: string; updatedAt?: string }): Promise<boolean> {
    if (!(await this.open()) || !this.db) return false;
    try {
      this.db.prepare(
        `INSERT INTO dispatches (id, dispatcher_id, target_agent_id, state, task, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET dispatcher_id=excluded.dispatcher_id, target_agent_id=excluded.target_agent_id,
           state=excluded.state, task=excluded.task, updated_at=excluded.updated_at`,
      ).run(entry.id, entry.dispatcherId ?? null, entry.targetAgentId ?? null, entry.state ?? null, entry.task ?? null, entry.updatedAt ?? new Date().toISOString());
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async upsertMessages(messages: IndexedMessage[]): Promise<number> {
    if (!(await this.open()) || !this.db) return 0;
    let written = 0;
    for (const message of messages) {
      try {
        const db = this.db;
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, role=excluded.role, content=excluded.content`,
        ).run(message.id, message.sessionId, message.role ?? null, message.content, message.createdAt ?? null);
        db.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id = ?)").run(message.id);
        db.prepare("INSERT INTO messages_fts (rowid, content) SELECT rowid, content FROM messages WHERE id = ?").run(message.id);
        written += 1;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return written;
  }

  /** 消息全文检索（同样的 ≥3 字 FTS / <3 字 LIKE 策略） */
  async searchMessages(query: string, options: { limit?: number } = {}): Promise<MemorySearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (!(await this.open()) || !this.db) return [];
    const limit = Math.max(1, options.limit ?? 20);
    if ([...trimmed].length >= FTS_MIN_CHARS) {
      try {
        const rows = this.db
          .prepare(
            `SELECT m.id AS id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`,
          )
          .all(trimmed, limit) as Array<{ id?: string }>;
        const hits = rows.filter((row) => typeof row.id === "string").map((row) => ({ id: String(row.id), via: "fts" as const, score: 1 }));
        if (hits.length > 0) return hits;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      const rows = this.db
        .prepare("SELECT id FROM messages WHERE content LIKE '%' || ? || '%' ORDER BY created_at DESC LIMIT ?")
        .all(trimmed, limit) as Array<{ id?: string }>;
      return rows.filter((row) => typeof row.id === "string").map((row) => ({ id: String(row.id), via: "like" as const, score: 1 }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }
}
