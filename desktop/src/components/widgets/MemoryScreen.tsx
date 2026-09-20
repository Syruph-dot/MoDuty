import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteMemory,
  listMemories,
  patchMemory,
  supersedeMemory,
  type MemoryStatusView,
  type MemoryTypeView,
  type MemoryView,
} from "../../lib/memoryApi";

const TYPE_LABELS: Record<string, string> = {
  episode: "事件",
  fact: "事实",
  preference: "偏好",
  procedure: "流程",
  decision: "决策",
};

const STATUS_LABELS: Record<string, string> = {
  active: "生效",
  candidate: "候选",
  superseded: "被取代",
  rejected: "已否决",
};

const SCOPES = ["", "user", "project", "agent", "session"];

/**
 * 记忆面板（P10）：把系统记住的东西摆到台面上，并允许人工纠正。
 *
 * 入口：桌面右键菜单 →「记忆」。设计上跟值日生页/设置页同类（整页视图），
 * 因为它是「检视与治理」而不是日常操作，不需要常驻占位。
 */
export default function MemoryScreen({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMemories(await listMemories({ scope: scope || undefined, type: type || undefined, status: status || undefined, q: keyword || undefined }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [scope, type, status, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const byStatus = new Map<string, number>();
    for (const memory of memories) byStatus.set(memory.status, (byStatus.get(memory.status) ?? 0) + 1);
    return { total: memories.length, byStatus };
  }, [memories]);

  const saveEdit = async (memory: MemoryView) => {
    try {
      const updated = await patchMemory(memory.id, { content: draft });
      setMemories((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const changeStatus = async (memory: MemoryView, next: MemoryStatusView) => {
    try {
      const updated = next === "superseded" ? await supersedeMemory(memory.id) : await patchMemory(memory.id, { status: next });
      setMemories((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const changeType = async (memory: MemoryView, next: MemoryTypeView) => {
    try {
      const updated = await patchMemory(memory.id, { type: next });
      setMemories((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const remove = async (memory: MemoryView) => {
    try {
      await deleteMemory(memory.id);
      setMemories((prev) => prev.filter((item) => item.id !== memory.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <section className="memory-screen" aria-label="记忆面板">
      <header className="memory-screen__header">
        <div className="memory-screen__identity">
          <h2 className="memory-screen__title">记忆</h2>
          <span className="memory-screen__subtitle">
            共 {stats.total} 条
            {stats.byStatus.size > 0 ? ` · ${[...stats.byStatus.entries()].map(([key, count]) => `${STATUS_LABELS[key] ?? key} ${count}`).join(" / ")}` : ""}
          </span>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="关闭记忆面板">
          × 关闭
        </button>
      </header>

      <div className="memory-screen__filters">
        <label className="memory-screen__filter">
          <span>归属</span>
          <select className="memory-screen__select" value={scope} onChange={(event) => setScope(event.target.value)} aria-label="按归属筛选">
            {SCOPES.map((value) => (
              <option key={value || "all"} value={value}>{value === "" ? "全部" : value}</option>
            ))}
          </select>
        </label>
        <label className="memory-screen__filter">
          <span>类型</span>
          <select className="memory-screen__select" value={type} onChange={(event) => setType(event.target.value)} aria-label="按类型筛选">
            <option value="">全部</option>
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="memory-screen__filter">
          <span>状态</span>
          <select className="memory-screen__select" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="按状态筛选">
            <option value="">全部</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <input
          className="memory-screen__search"
          value={keyword}
          placeholder="搜内容关键词…"
          onChange={(event) => setKeyword(event.target.value)}
          aria-label="搜索记忆内容"
        />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()} aria-label="刷新记忆列表">
          ⟳ 刷新
        </button>
      </div>

      {error ? <p className="memory-screen__error" role="alert">{error}</p> : null}
      {loading ? <p className="memory-screen__empty">读取中…</p> : null}
      {!loading && memories.length === 0 ? <p className="memory-screen__empty">没有匹配的记忆。</p> : null}

      <ul className="memory-screen__list">
        {memories.map((memory) => (
          <li key={memory.id} className={`memory-card memory-card--${memory.status}`} data-memory-id={memory.id}>
            <div className="memory-card__head">
              <span className={`memory-card__badge memory-card__badge--${memory.type}`}>{TYPE_LABELS[memory.type] ?? memory.type}</span>
              <span className="memory-card__scope">{memory.scope}/{memory.scope_id}</span>
              <span className={`memory-card__status memory-card__status--${memory.status}`}>{STATUS_LABELS[memory.status] ?? memory.status}</span>
              <span className="memory-card__confidence">置信度 {memory.confidence === null ? "—" : memory.confidence.toFixed(2)}</span>
              <span className="memory-card__spacer" />
              {editingId === memory.id ? (
                <>
                  <button type="button" className="btn btn--primary btn--sm" onClick={() => void saveEdit(memory)}>保存</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditingId(null)}>取消</button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => { setEditingId(memory.id); setDraft(memory.content); }}
                >
                  编辑
                </button>
              )}
            </div>

            {editingId === memory.id ? (
              <textarea
                className="memory-card__editor"
                value={draft}
                rows={3}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="编辑记忆内容"
              />
            ) : (
              <p className="memory-card__content">{memory.content}</p>
            )}

            <div className="memory-card__meta">
              {memory.source_refs.length > 0 ? <span className="memory-card__refs">来源 {memory.source_refs.join(", ")}</span> : <span className="memory-card__refs">无来源标注</span>}
              {memory.supersedes ? <span className="memory-card__link">取代了 {memory.supersedes}</span> : null}
              {memory.superseded_by ? <span className="memory-card__link">已被 {memory.superseded_by} 取代</span> : null}
              <span className="memory-card__spacer" />
              <select
                className="memory-card__select"
                value={memory.type}
                onChange={(event) => void changeType(memory, event.target.value as MemoryTypeView)}
                aria-label="修改记忆类型"
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <select
                className="memory-card__select"
                value={memory.status}
                onChange={(event) => void changeStatus(memory, event.target.value as MemoryStatusView)}
                aria-label="修改记忆状态"
              >
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void remove(memory)} aria-label="删除这条记忆">
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
