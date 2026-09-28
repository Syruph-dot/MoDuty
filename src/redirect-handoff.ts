import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { resolveWorkspacePath } from "./tools.js";
import { atomicWrite } from "./write-queue.js";
import { containsSensitiveTraceContent } from "./trace.js";
import type { StoredMessage } from "./serialization.js";

export function redirectRelativePath(sessionId: string): string {
  if (!/^ses_[A-Za-z0-9_-]{1,100}$/u.test(sessionId)) throw new Error("Invalid session id");
  return `.momoka/handoffs/${sessionId}.md`;
}

function latestCompleteMessage(messages: StoredMessage[]): StoredMessage | null {
  const last = messages.at(-1);
  if (!last || last.role !== "agent" || last.status === "streaming" || last.status === "error" || last.status === "stopped") return null;
  return last;
}

async function checkedPath(workDir: string, sessionId: string, operation: "read" | "write"): Promise<string> {
  const relative = redirectRelativePath(sessionId);
  const file = resolveWorkspacePath(workDir, relative, operation);
  const root = path.resolve(workDir);
  const directory = path.dirname(file);
  if (operation === "write") {
    let cursor = root;
    for (const part of path.relative(root, directory).split(path.sep)) {
      cursor = path.join(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Handoff directory may not be a symlink");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(directory, { recursive: true });
  }
  // The workspace manifest checks lexical paths; reject symlink escapes as well.
  const actualRoot = await realpath(root);
  const actualDirectory = await realpath(directory);
  const inside = path.relative(actualRoot, actualDirectory);
  if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("Handoff directory escapes the workspace");
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Handoff file may not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

export interface RedirectHandoffStatus {
  ready: boolean;
  relativePath: string;
}

export async function readRedirectHandoff(workDir: string, sessionId: string): Promise<string | null> {
  try {
    const file = await checkedPath(workDir, sessionId, "read");
    return (await readFile(file, "utf8")).slice(0, 40_000);
  } catch {
    return null;
  }
}

export async function redirectHandoffStatus(workDir: string, sessionId: string, messages: StoredMessage[]): Promise<RedirectHandoffStatus> {
  const relativePath = redirectRelativePath(sessionId);
  const current = latestCompleteMessage(messages);
  if (!current) return { ready: false, relativePath };
  try {
    resolveWorkspacePath(workDir, relativePath, "write");
    const file = await checkedPath(workDir, sessionId, "read");
    const content = await readFile(file, "utf8");
    return { ready: validHandoff(content, sessionId, current.id), relativePath };
  } catch {
    return { ready: false, relativePath };
  }
}

export async function writeRedirectHandoff(workDir: string, sessionId: string, coveredMessageId: string, narrative: string): Promise<void> {
  const body = narrative.trim();
  if (!body.startsWith("# ") || body.length < 80 || body.length > 40_000 || containsSensitiveTraceContent(body)) {
    throw new Error("Agent returned an invalid redirect handoff");
  }
  const file = await checkedPath(workDir, sessionId, "write");
  const content = `<!-- moduty-redirect-session: ${sessionId}; through: ${coveredMessageId} -->\n${body}\n\n## 母会话\n&${sessionId}\n`;
  await atomicWrite(file, content);
  if (!validHandoff(await readFile(file, "utf8"), sessionId, coveredMessageId)) throw new Error("Redirect handoff verification failed");
}

function validHandoff(content: string, sessionId: string, messageId: string): boolean {
  return content.startsWith(`<!-- moduty-redirect-session: ${sessionId}; through: ${messageId} -->\n`)
    && content.includes(`&${sessionId}`) && /^#\s+\S/mu.test(content)
    && content.length >= 100 && content.length <= 42_000 && !containsSensitiveTraceContent(content);
}
