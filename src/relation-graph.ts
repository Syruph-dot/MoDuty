import { mkdir } from "node:fs/promises";
import path from "node:path";

import { withFileLock } from "./write-queue.js";

export interface SessionGraphNode {
  id: string;
  name: string;
  goal: string;
  type: "session";
  updatedAt: string;
}

export interface SessionGraphLink {
  source: string;
  target: string;
  type: "references";
}

export interface SessionGraphSnapshot {
  nodes: SessionGraphNode[];
  links: SessionGraphLink[];
}

export interface SessionGraphEdges {
  out: Map<string, string[]>;
  in: Map<string, string[]>;
}

interface GraphSession {
  id: string;
  name: string;
  goal: string;
  lastMessageAt: string;
}

interface GraphMessage {
  content: string;
  [key: string]: unknown;
}

export interface SessionGraphSource {
  listSessions: () => Promise<GraphSession[]>;
  getSession: (id: string) => Promise<GraphSession | null>;
  getMessages: (id: string, limit: number | null) => Promise<GraphMessage[]>;
}

interface SqliteStatement {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS graph_meta (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS graph_links (source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (source, target, type))",
  "CREATE INDEX IF NOT EXISTS idx_graph_links_target ON graph_links(target)",
];

// The first read in each process reconciles the derived database with JSON.
// A crash between a JSON write and its graph update cannot leave a stale graph indefinitely.
const reconciled = new Set<string>();

export function sessionGraphPath(sessionsDir: string): string {
  return path.join(path.resolve(sessionsDir, ".."), "session-graph.db");
}

export function normalizeSessionId(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  return value.startsWith("ses_") ? value : "ses_" + value;
}

/** Keep the historical bare-id return contract used by export-session-circuit. */
export function extractAmpersandRefs(content: string): Set<string> {
  const refs = new Set<string>();
  for (const match of content.matchAll(/&ses_([a-z0-9]+)/gi)) {
    if (match[1]) refs.add(match[1].toLowerCase());
  }
  return refs;
}

async function withDatabase<T>(sessionsDir: string, use: (db: SqliteDatabase) => T): Promise<T> {
  const file = sessionGraphPath(sessionsDir);
  await mkdir(path.dirname(file), { recursive: true });
  const mod = await import("node:sqlite");
  const db = new mod.DatabaseSync(file) as unknown as SqliteDatabase;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    for (const statement of SCHEMA) db.exec(statement);
    return use(db);
  } finally {
    db.close();
  }
}

function transaction<T>(db: SqliteDatabase, use: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = use();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function bumpGeneration(db: SqliteDatabase): void {
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO graph_meta (id, generation, updated_at) VALUES (1, 0, ?)").run(now);
  db.prepare("UPDATE graph_meta SET generation = generation + 1, updated_at = ? WHERE id = 1").run(now);
}

/** Extract explicit session handles from all persisted message text fields. */
export function extractSessionReferenceTargets(messages: GraphMessage[]): Set<string> {
  const targets = new Set<string>();
  const collect = (value: unknown, depth = 0): void => {
    if (value == null || depth > 4) return;
    if (typeof value === "string") {
      for (const raw of extractAmpersandRefs(value)) targets.add(normalizeSessionId(raw));
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
    } else if (typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) collect(item, depth + 1);
    }
  };
  for (const message of messages) {
    collect(message);
  }
  return targets;
}

/** Replace one source session and all its outgoing links in a SQLite transaction. */
export async function refreshSessionGraph(
  sessionsDir: string,
  sessionId: string,
  source: SessionGraphSource,
): Promise<void> {
  const file = sessionGraphPath(sessionsDir);
  try {
    await withFileLock(file, async () => {
      const session = await source.getSession(sessionId);
      const targets = session ? extractSessionReferenceTargets(await source.getMessages(sessionId, null)) : new Set<string>();
      await withDatabase(sessionsDir, (db) => transaction(db, () => {
        if (session) {
          db.prepare(
            "INSERT INTO graph_nodes (id, name, goal, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, goal = excluded.goal, updated_at = excluded.updated_at",
          ).run(session.id, session.name, session.goal, session.lastMessageAt);
        } else {
          db.prepare("DELETE FROM graph_nodes WHERE id = ?").run(sessionId);
        }
        db.prepare("DELETE FROM graph_links WHERE source = ?").run(sessionId);
        if (session) {
          const insert = db.prepare("INSERT OR IGNORE INTO graph_links (source, target, type) VALUES (?, ?, 'references')");
          for (const target of targets) {
            if (target !== sessionId) insert.run(sessionId, target);
          }
        }
        bumpGeneration(db);
      }));
    });
  } catch (error) {
    reconciled.delete(file);
    throw error;
  }
}

/** Atomically publish a full graph reconstructed from the JSON source. */
export async function rebuildSessionGraph(sessionsDir: string, source: SessionGraphSource): Promise<void> {
  const file = sessionGraphPath(sessionsDir);
  try {
    await withFileLock(file, async () => {
      const sessions = await source.listSessions();
      const targets = new Map<string, Set<string>>();
      for (const session of sessions) {
        targets.set(session.id, extractSessionReferenceTargets(await source.getMessages(session.id, null)));
      }
      await withDatabase(sessionsDir, (db) => transaction(db, () => {
        db.exec("DELETE FROM graph_links");
        db.exec("DELETE FROM graph_nodes");
        const insertNode = db.prepare("INSERT INTO graph_nodes (id, name, goal, updated_at) VALUES (?, ?, ?, ?)");
        const insertLink = db.prepare("INSERT OR IGNORE INTO graph_links (source, target, type) VALUES (?, ?, 'references')");
        for (const session of sessions) {
          insertNode.run(session.id, session.name, session.goal, session.lastMessageAt);
          for (const target of targets.get(session.id) ?? []) {
            if (target !== session.id) insertLink.run(session.id, target);
          }
        }
        bumpGeneration(db);
      }));
      reconciled.add(file);
    });
  } catch (error) {
    reconciled.delete(file);
    throw error;
  }
}

/** Readers see one committed generation. Dangling references remain stored for later recovery. */
async function readCommittedGraph(sessionsDir: string): Promise<SessionGraphSnapshot | null> {
  return await withDatabase(sessionsDir, (db) => {
    db.exec("BEGIN");
    try {
      if (!db.prepare("SELECT generation FROM graph_meta WHERE id = 1").get()) {
        db.exec("COMMIT");
        return null;
      }
      const rows = db.prepare("SELECT id, name, goal, updated_at FROM graph_nodes ORDER BY id").all() as Array<{
        id: string; name: string; goal: string; updated_at: string;
      }>;
      const edges = db.prepare(
        "SELECT e.source, e.target FROM graph_links e " +
        "JOIN graph_nodes s ON s.id = e.source JOIN graph_nodes t ON t.id = e.target " +
        "WHERE e.type = 'references' ORDER BY e.source, e.target",
      ).all() as Array<{ source: string; target: string }>;
      const snapshot: SessionGraphSnapshot = {
        nodes: rows.map((row) => ({ id: row.id, name: row.name, goal: row.goal, type: "session", updatedAt: row.updated_at })),
        links: edges.map((row) => ({ source: row.source, target: row.target, type: "references" })),
      };
      db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export async function readSessionGraph(
  sessionsDir: string,
  source: SessionGraphSource,
): Promise<SessionGraphSnapshot> {
  const file = sessionGraphPath(sessionsDir);
  if (!reconciled.has(file)) await rebuildSessionGraph(sessionsDir, source);
  const snapshot = await readCommittedGraph(sessionsDir);
  if (snapshot) return snapshot;
  // The derived database was removed while this process was running.
  reconciled.delete(file);
  await rebuildSessionGraph(sessionsDir, source);
  const restored = await readCommittedGraph(sessionsDir);
  if (!restored) throw new Error("Session graph rebuild produced no committed snapshot");
  return restored;
}

export async function readSessionGraphEdges(
  sessionsDir: string,
  source: SessionGraphSource,
): Promise<SessionGraphEdges> {
  const { links } = await readSessionGraph(sessionsDir, source);
  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const link of links) {
    out.set(link.source, [...(out.get(link.source) ?? []), link.target]);
    incoming.set(link.target, [...(incoming.get(link.target) ?? []), link.source]);
  }
  return { out, in: incoming };
}
