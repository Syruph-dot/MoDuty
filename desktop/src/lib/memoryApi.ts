import { awaitApiBase } from "./api";

/**
 * 记忆面板 API（P10）：把 /api/memory 系列包成有类型的函数。
 * 记忆在这里是**一等资源**——可看、可改、可退役、可删，这也是 P2–P4 那些机制能被信任的前提。
 */

export type MemoryTypeView = "episode" | "fact" | "preference" | "procedure" | "decision";
export type MemoryStatusView = "candidate" | "active" | "superseded" | "rejected";

export interface MemoryView {
  id: string;
  content: string;
  topic: string;
  scope: string;
  scope_id: string;
  type: MemoryTypeView;
  status: MemoryStatusView;
  confidence: number | null;
  source_refs: string[];
  source: string;
  superseded_by: string | null;
  supersedes: string | null;
  valid_until: string | null;
  access_count: number;
  created_at: string;
  last_accessed_at: string | null;
}

export interface MemoryListFilters {
  scope?: string;
  type?: string;
  status?: string;
  q?: string;
}

export async function listMemories(filters: MemoryListFilters = {}): Promise<MemoryView[]> {
  const base = await awaitApiBase();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value));
  }
  const query = params.toString();
  const response = await fetch(`${base}/api/memory${query ? `?${query}` : ""}`);
  if (!response.ok) throw new Error(`加载记忆失败：HTTP ${response.status}`);
  const body = (await response.json()) as { memories?: MemoryView[] };
  return body.memories ?? [];
}

export async function patchMemory(id: string, patch: { content?: string; type?: MemoryTypeView; status?: MemoryStatusView; confidence?: number }): Promise<MemoryView> {
  const base = await awaitApiBase();
  const response = await fetch(`${base}/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`修改记忆失败：HTTP ${response.status}`);
  const body = (await response.json()) as { memory: MemoryView };
  return body.memory;
}

export async function supersedeMemory(id: string, by?: string): Promise<MemoryView> {
  const base = await awaitApiBase();
  const response = await fetch(`${base}/api/memory/${encodeURIComponent(id)}/supersede`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(by ? { by } : {}),
  });
  if (!response.ok) throw new Error(`标记取代失败：HTTP ${response.status}`);
  const body = (await response.json()) as { memory: MemoryView };
  return body.memory;
}

export async function deleteMemory(id: string): Promise<void> {
  const base = await awaitApiBase();
  const response = await fetch(`${base}/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`删除记忆失败：HTTP ${response.status}`);
}
