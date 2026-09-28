import { useCallback, useEffect, useMemo, useState } from "react";

import { listSessionOptions, type SessionOptionView } from "../../lib/api";
import {
  createQuickRef,
  deleteQuickRef,
  listQuickRefAudit,
  listQuickRefs,
  updateQuickRef,
  type QuickRefAuditView,
  type QuickRefView,
} from "../../lib/quickrefApi";

function sourceRefsOf(value: string): string[] {
  return [...new Set(value.split(/[,\n]/u).map((item) => item.trim()).filter(Boolean))];
}

export default function QuickRefManager() {
  const [sessions, setSessions] = useState<SessionOptionView[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [entries, setEntries] = useState<QuickRefView[]>([]);
  const [audit, setAudit] = useState<QuickRefAuditView[]>([]);
  const [topic, setTopic] = useState("");
  const [content, setContent] = useState("");
  const [sources, setSources] = useState("");
  const [editing, setEditing] = useState<QuickRefView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listSessionOptions().then((items) => {
      if (!live) return;
      setSessions(items);
      setSessionId((current) => current || items[0]?.id || "");
    }).catch((caught) => {
      if (live) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { live = false; };
  }, []);

  const reload = useCallback(async () => {
    if (!sessionId) {
      setEntries([]);
      setAudit([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextEntries, nextAudit] = await Promise.all([listQuickRefs(sessionId), listQuickRefAudit(sessionId)]);
      setEntries(nextEntries);
      setAudit(nextAudit);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
    setEditing(null);
    setTopic("");
    setContent("");
    setSources("");
    setConfirmDelete(null);
  }, [reload]);

  const choices = useMemo(() => {
    const needle = sessionQuery.trim().toLowerCase();
    const filtered = sessions.filter((session) =>
      !needle || (session.id + " " + session.name + " " + session.goal).toLowerCase().includes(needle),
    ).slice(0, 50);
    const selected = sessions.find((session) => session.id === sessionId);
    return selected && !filtered.some((session) => session.id === selected.id) ? [selected, ...filtered] : filtered;
  }, [sessions, sessionId, sessionQuery]);

  const clearForm = () => {
    setEditing(null);
    setTopic("");
    setContent("");
    setSources("");
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sessionId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const input = { topic: topic.trim(), content: content.trim(), sourceRefs: sourceRefsOf(sources) };
      if (editing) {
        await updateQuickRef(sessionId, editing.id, { ...input, revision: editing.revision });
      } else {
        await createQuickRef(sessionId, input);
      }
      clearForm();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: QuickRefView) => {
    if (confirmDelete !== entry.id || saving) {
      setConfirmDelete(entry.id);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteQuickRef(sessionId, entry.id, entry.revision);
      setConfirmDelete(null);
      if (editing?.id === entry.id) clearForm();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="quickref-manager">
      <div className="quickref-manager__toolbar">
        <label className="quickref-manager__field">
          <span>查找会话</span>
          <input
            className="memory-screen__search"
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
            placeholder="标题、目标或 ses_ ID"
          />
        </label>
        <label className="quickref-manager__field">
          <span>所属会话</span>
          <select className="memory-screen__select" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
            {choices.length === 0 ? <option value="">没有匹配会话</option> : null}
            {choices.map((session) => (
              <option key={session.id} value={session.id}>{session.name || session.goal || session.id} · {session.id}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void reload()} disabled={!sessionId || loading}>⟳ 刷新</button>
      </div>

      {error ? <p className="memory-screen__error" role="alert">{error}</p> : null}
      <div className="quickref-manager__layout">
        <section className="quickref-manager__entries" aria-label="会话速查条目">
          <div className="quickref-manager__section-head">
            <h3>当前条目</h3>
            <span>{entries.length} 条</span>
          </div>
          {loading ? <p className="memory-screen__empty">读取中…</p> : null}
          {!loading && entries.length === 0 ? <p className="memory-screen__empty">该会话尚无速查条目。可手动创建；Agent 也会在值得交接时按需维护。</p> : null}
          <ul className="memory-screen__list">
            {entries.map((entry) => (
              <li key={entry.id} className="memory-card memory-card--active">
                <div className="memory-card__head">
                  <strong>{entry.topic}</strong>
                  <span className="memory-card__spacer" />
                  <span className="memory-card__scope">{entry.origin === "manual" ? "人工维护" : "Agent 整理"} · 修订 {entry.revision}</span>
                </div>
                <p className="memory-card__content">{entry.content}</p>
                <div className="memory-card__meta">
                  <span className="memory-card__refs">{entry.source_refs.length ? "来源 " + entry.source_refs.join(", ") : "人工录入 · 无会话来源"}</span>
                  <span>更新于 {new Date(entry.updated_at).toLocaleString("zh-CN")}</span>
                  <span className="memory-card__spacer" />
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
                    setEditing(entry);
                    setTopic(entry.topic);
                    setContent(entry.content);
                    setSources(entry.source_refs.join(", "));
                    setConfirmDelete(null);
                  }}>编辑</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void remove(entry)}>
                    {confirmDelete === entry.id ? "确认删除" : "删除"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <details className="quickref-manager__audit">
            <summary>操作记录 · {audit.length} 条</summary>
            <ul>
              {[...audit].reverse().map((event, index) => (
                <li key={event.entry_id + event.at + index}>
                  {event.action} · {event.entry_id} · {event.channel} · {new Date(event.at).toLocaleString("zh-CN")}
                </li>
              ))}
            </ul>
          </details>
        </section>

        <form className="quickref-manager__editor" onSubmit={(event) => void save(event)}>
          <h3>{editing ? "编辑速查条目" : "新增速查条目"}</h3>
          <p className="memory-screen__empty">每条只写一个可复用主题。地址与路径请照原样填写，不要保存密码或密钥。</p>
          <label className="quickref-manager__field">
            <span>主题</span>
            <input className="memory-screen__search" value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={120} required />
          </label>
          <label className="quickref-manager__field">
            <span>速查正文</span>
            <textarea className="memory-card__editor" value={content} onChange={(event) => setContent(event.target.value)} maxLength={1200} rows={10} required />
          </label>
          <label className="quickref-manager__field">
            <span>来源消息或产物 ID（逗号分隔，可选）</span>
            <input className="memory-screen__search" value={sources} onChange={(event) => setSources(event.target.value)} placeholder="msg_…、产物路径…" />
          </label>
          <div className="quickref-manager__actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={!sessionId || saving}>{saving ? "保存中…" : editing ? "保存修改" : "创建条目"}</button>
            {editing ? <button type="button" className="btn btn--ghost btn--sm" onClick={clearForm}>取消编辑</button> : null}
          </div>
        </form>
      </div>
    </div>
  );
}
