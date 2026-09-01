import { useEffect, useRef, useState } from "react";

import { useAgentsStore, useVisibleAgents } from "../state/agentsStore";
import { workspaceLabel } from "../lib/agentFilter";
import { formatShortTime } from "../lib/tileContent";

/**
 * 归档库侧边面板（方案 D）：
 * - 右侧滑出列表：被手动归档 + 超过自动归档阈值（派生）的 Agent
 * - 每行：名称 / 工作区 / 最后活跃 / 消息数 + 「恢复」
 * - 「全部恢复」清除手动归档标记（自动归档的会随活跃自动回墙）
 * - 搜索复用治理栏 query（filters.query，Enter 提交后生效）
 * - 直角矩形样式（与治理栏一致，无圆角）
 */
export default function ArchivePanel() {
  const open = useAgentsStore((state) => state.archiveOpen);
  const setArchiveOpen = useAgentsStore((state) => state.setArchiveOpen);
  const archivedIds = useAgentsStore((state) => state.archivedIds);
  const pinnedIds = useAgentsStore((state) => state.pinnedIds);
  const filters = useAgentsStore((state) => state.filters);
  const setFilterQuery = useAgentsStore((state) => state.setFilterQuery);
  const toggleArchive = useAgentsStore((state) => state.toggleArchive);
  const unarchiveAll = useAgentsStore((state) => state.unarchiveAll);
  const togglePin = useAgentsStore((state) => state.togglePin);
  const toggleFilterBar = useAgentsStore((state) => state.toggleFilterBar);

  const { archived, archivedTotal } = useVisibleAgents();

  const [draft, setDraft] = useState(filters.query);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(filters.query);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, filters.query]);

  if (!open) return null;

  // 手动归档总数（不受筛选影响）；auto 归档的由阈值派生
  const manualTotal = archivedIds.length;

  return (
    <aside className="archive-panel" role="complementary" aria-label="归档会话库">
      <div className="archive-panel__head">
        <h2 className="archive-panel__title">归档库</h2>
        <button
          type="button"
          className="archive-panel__close"
          aria-label="关闭归档库"
          onClick={() => setArchiveOpen(false)}
        >
          ×
        </button>
      </div>

      <p className="archive-panel__hint">
        共 {archivedTotal} 个归档会话（手动 {manualTotal} 个；其余按活跃阈值自动归档）。
        手动归档的会话不会自动回墙，需手动恢复；自动归档的会话一经活跃即自动回墙。
      </p>

      {/* 搜索：Enter 提交，复用治理栏 query */}
      <input
        ref={inputRef}
        className="archive-panel__search"
        value={draft}
        placeholder="在归档中搜索（Enter 开始）"
        aria-label="在归档中搜索"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setFilterQuery(draft.trim());
          } else if (event.key === "Escape") {
            setDraft("");
          }
        }}
      />

      <div className="archive-panel__actions">
        {manualTotal > 0 ? (
          <button type="button" className="btn btn--ghost archive-panel__unarchive-all" onClick={unarchiveAll}>
            全部恢复（消除手动归档）
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setArchiveOpen(false);
            toggleFilterBar();
          }}
        >
          打开筛选栏
        </button>
      </div>

      <div className="archive-panel__list">
        {archived.length === 0 ? (
          <p className="archive-panel__empty">
            {archivedTotal > 0 ? "没有符合当前筛选的归档会话" : "暂无归档会话"}
          </p>
        ) : (
          archived.map((agent) => {
            const manual = archivedIds.includes(agent.id);
            const pinned = pinnedIds.includes(agent.id);
            return (
              <div key={agent.id} className="archive-item" data-id={agent.id}>
                <div className="archive-item__main">
                  <div className="archive-item__name">{agent.name}</div>
                  <div className="archive-item__meta">
                    <span className="archive-item__ws">{workspaceLabel(agent.workspace_dir)}</span>
                    <span>{formatShortTime(agent.last_active_at)}</span>
                    <span>{agent.session ? `${agent.session.message_count} 条消息` : "无消息"}</span>
                    {manual ? <span className="archive-item__badge">手动</span> : null}
                    {pinned ? <span className="archive-item__badge archive-item__badge--pin">已钉</span> : null}
                  </div>
                </div>
                <div className="archive-item__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    title={pinned ? "取消钉住（不改变归档状态）" : "钉住（始终回墙）"}
                    onClick={() => togglePin(agent.id)}
                  >
                    {pinned ? "取消钉住" : "钉住"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    title={manual ? "从手动归档恢复" : "钉住并唤醒回墙"}
                    onClick={() => {
                      if (manual) toggleArchive(agent.id);
                      else togglePin(agent.id);
                      setArchiveOpen(false);
                    }}
                  >
                    恢复
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="archive-panel__foot">
        <button
          type="button"
          className="archive-panel__foot-btn"
          onClick={() => setArchiveOpen(false)}
        >
          返回磁贴墙
        </button>
      </p>
    </aside>
  );
}