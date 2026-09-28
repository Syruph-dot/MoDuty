import { awaitApiBase } from "./api";

export interface QuickRefView {
  id: string;
  session_id: string;
  topic: string;
  content: string;
  source_refs: string[];
  origin: "agent" | "manual";
  model: string | null;
  prompt_version: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface QuickRefAuditView {
  entry_id: string;
  session_id: string;
  action: "create" | "update" | "delete";
  channel: "agent" | "desktop" | "cli" | "api";
  agent_id: string | null;
  at: string;
}

async function request<T>(sessionId: string, suffix: string, init: RequestInit = {}): Promise<T> {
  const base = await awaitApiBase();
  const url = base + "/api/sessions/" + encodeURIComponent(sessionId) + "/quickrefs" + suffix;
  const response = await fetch(url, {
    ...init,
    headers: {
      "x-momoka-client": "desktop",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "HTTP " + response.status);
  return body;
}

export async function listQuickRefs(sessionId: string): Promise<QuickRefView[]> {
  return (await request<{ entries: QuickRefView[] }>(sessionId, "")).entries;
}

export async function createQuickRef(sessionId: string, input: { topic: string; content: string; sourceRefs: string[] }): Promise<QuickRefView> {
  return (await request<{ entry: QuickRefView }>(sessionId, "", {
    method: "POST",
    body: JSON.stringify({ topic: input.topic, content: input.content, source_refs: input.sourceRefs }),
  })).entry;
}

export async function updateQuickRef(sessionId: string, entryId: string, input: { revision: number; topic: string; content: string; sourceRefs: string[] }): Promise<QuickRefView> {
  return (await request<{ entry: QuickRefView }>(sessionId, "/" + encodeURIComponent(entryId), {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: input.revision, topic: input.topic, content: input.content, source_refs: input.sourceRefs }),
  })).entry;
}

export async function deleteQuickRef(sessionId: string, entryId: string, revision: number): Promise<void> {
  await request<{ deleted: boolean }>(sessionId, "/" + encodeURIComponent(entryId), {
    method: "DELETE",
    body: JSON.stringify({ expected_revision: revision }),
  });
}

export async function listQuickRefAudit(sessionId: string): Promise<QuickRefAuditView[]> {
  return (await request<{ events: QuickRefAuditView[] }>(sessionId, "/audit")).events;
}
