import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SessionManager } from "./session-manager.js";
import { containsSensitiveTraceContent } from "./trace.js";
import { atomicWriteJson, withFileLock } from "./write-queue.js";

export interface QuickRefEntry {
  id: string;
  sessionId: string;
  topic: string;
  content: string;
  sourceRefs: string[];
  origin: "agent" | "manual";
  model?: string;
  promptVersion?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface QuickRefActor {
  channel: "agent" | "desktop" | "cli";
  agentId?: string;
}

export interface QuickRefAudit {
  entryId: string;
  sessionId: string;
  action: "create" | "update" | "delete";
  channel: QuickRefActor["channel"];
  agentId?: string;
  at: string;
}

export interface CreateQuickRef {
  topic: string;
  content: string;
  sourceRefs: string[];
  origin: QuickRefEntry["origin"];
  model?: string;
  promptVersion?: string;
}

export interface UpdateQuickRef {
  expectedRevision: number;
  topic?: string;
  content?: string;
  sourceRefs?: string[];
  model?: string;
  promptVersion?: string;
}

interface QuickRefFile {
  version: 1;
  entries: QuickRefEntry[];
  audit: QuickRefAudit[];
}

export class QuickRefConflictError extends Error {
  constructor() {
    super("Quick-reference revision changed; reload before editing.");
    this.name = "QuickRefConflictError";
  }
}

function cleanText(value: string, label: string, maxChars: number): string {
  const clean = value.trim();
  if (!clean || [...clean].length > maxChars) throw new Error(label + " must contain 1-" + maxChars + " characters.");
  if (containsSensitiveTraceContent(clean)) throw new Error(label + " contains secret-like content.");
  return clean;
}

function cleanRefs(refs: string[], origin: QuickRefEntry["origin"]): string[] {
  if (!Array.isArray(refs)) throw new Error("sourceRefs must be an array.");
  const clean = [...new Set(refs.map((value) => String(value).trim()).filter(Boolean))];
  if (clean.length > 20 || clean.some((ref) => ref.length > 256 || containsSensitiveTraceContent(ref))) {
    throw new Error("sourceRefs exceed the limit or contain secret-like content.");
  }
  if (origin === "agent" && clean.length === 0) throw new Error("Agent quick references require sourceRefs.");
  return clean;
}

function emptyFile(): QuickRefFile {
  return { version: 1, entries: [], audit: [] };
}

export class SessionQuickRefStore {
  constructor(private readonly sessions: SessionManager) {}

  private async filePath(sessionId: string): Promise<string> {
    if (!/^ses_[a-z0-9]+$/u.test(sessionId) || !(await this.sessions.getSession(sessionId))) {
      throw new Error("Unknown session: " + sessionId);
    }
    return path.join(this.sessions.sessionsDir, sessionId, "quickrefs.json");
  }

  private async read(file: string): Promise<QuickRefFile> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw error;
    }
    const parsed = JSON.parse(raw) as QuickRefFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.audit)) {
      throw new Error("Quick-reference file has an invalid format.");
    }
    return parsed;
  }

  private auditEvent(sessionId: string, entryId: string, action: QuickRefAudit["action"], actor: QuickRefActor): QuickRefAudit {
    return {
      entryId,
      sessionId,
      action,
      channel: actor.channel,
      ...(actor.agentId ? { agentId: actor.agentId } : {}),
      at: new Date().toISOString(),
    };
  }

  async list(sessionId: string): Promise<QuickRefEntry[]> {
    const file = await this.filePath(sessionId);
    const state = await this.read(file);
    return [...state.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async get(sessionId: string, entryId: string): Promise<QuickRefEntry | null> {
    return (await this.list(sessionId)).find((entry) => entry.id === entryId) ?? null;
  }

  async audit(sessionId: string): Promise<QuickRefAudit[]> {
    const file = await this.filePath(sessionId);
    return [...(await this.read(file)).audit];
  }

  async create(sessionId: string, input: CreateQuickRef, actor: QuickRefActor): Promise<QuickRefEntry> {
    const file = await this.filePath(sessionId);
    const topic = cleanText(input.topic, "topic", 120);
    const content = cleanText(input.content, "content", 1200);
    const sourceRefs = cleanRefs(input.sourceRefs, input.origin);
    return await withFileLock(file, async () => {
      const state = await this.read(file);
      const now = new Date().toISOString();
      const entry: QuickRefEntry = {
        id: "qrf_" + crypto.randomUUID().replace(/-/gu, "").slice(0, 12),
        sessionId,
        topic,
        content,
        sourceRefs,
        origin: input.origin,
        ...(input.model ? { model: input.model } : {}),
        ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      state.entries.push(entry);
      state.audit.push(this.auditEvent(sessionId, entry.id, "create", actor));
      await atomicWriteJson(file, state);
      return entry;
    });
  }

  async update(sessionId: string, entryId: string, input: UpdateQuickRef, actor: QuickRefActor): Promise<QuickRefEntry | null> {
    const file = await this.filePath(sessionId);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("expectedRevision must be a positive integer.");
    }
    return await withFileLock(file, async () => {
      const state = await this.read(file);
      const index = state.entries.findIndex((entry) => entry.id === entryId);
      if (index < 0) return null;
      const prior = state.entries[index]!;
      if (prior.revision !== input.expectedRevision) throw new QuickRefConflictError();
      const next: QuickRefEntry = {
        ...prior,
        ...(input.topic !== undefined ? { topic: cleanText(input.topic, "topic", 120) } : {}),
        ...(input.content !== undefined ? { content: cleanText(input.content, "content", 1200) } : {}),
        ...(input.sourceRefs !== undefined ? { sourceRefs: cleanRefs(input.sourceRefs, prior.origin) } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
        updatedAt: new Date().toISOString(),
        revision: prior.revision + 1,
      };
      state.entries[index] = next;
      state.audit.push(this.auditEvent(sessionId, entryId, "update", actor));
      await atomicWriteJson(file, state);
      return next;
    });
  }

  async delete(sessionId: string, entryId: string, expectedRevision: number, actor: QuickRefActor): Promise<boolean> {
    const file = await this.filePath(sessionId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("expectedRevision must be a positive integer.");
    }
    return await withFileLock(file, async () => {
      const state = await this.read(file);
      const index = state.entries.findIndex((entry) => entry.id === entryId);
      if (index < 0) return false;
      if (state.entries[index]!.revision !== expectedRevision) throw new QuickRefConflictError();
      state.entries.splice(index, 1);
      state.audit.push(this.auditEvent(sessionId, entryId, "delete", actor));
      await atomicWriteJson(file, state);
      return true;
    });
  }
}
