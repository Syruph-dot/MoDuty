import type { CSSProperties } from "react";

import AgentTile from "./AgentTile";
import { useAgentsStore, useVisibleAgents } from "../state/agentsStore";
import { useDialogStore } from "../state/dialogStore";
import { useContextMenuStore, type ContextMenuItem } from "../state/contextMenuStore";
import { groupByAgents, type AgentFilters } from "../lib/agentFilter";
import type { Agent } from "../types";

/**
 * 分组墙（方案 B，grouped 视图）：
 * - 布局规则（用户偏好）：组与组之间按 X 轴分开，某一组占有一个 X 区间的空间；
 *   组名在组上方预留空间左对齐显示，使用 Segoe UI 细体（Light）
 * - 顶部工作区 tab：全部 / 各工作区；点击只显示该工作区
 * - 组头可折叠（collapsedWorkspaces 持久化）；组内统一尺寸小磁贴（不使用自由 tiles 坐标）
 * - 磁贴交互：单击打开；右键 = 钉住 / 归档 / 重命名 / 删除
 * - 纯展示视图，不写回 tiles 几何
 */
export default function GroupedWall({ onOpen }: { onOpen: (agent: Agent) => void }) {
  const filters = useAgentsStore((state) => state.filters);
  const viewMode = useAgentsStore((state) => state.viewMode);
  const groupBy = useAgentsStore((state) => state.groupBy);
  const pinnedIds = useAgentsStore((state) => state.pinnedIds);
  const activeWorkspace = useAgentsStore((state) => state.activeWorkspace);
  const collapsedWorkspaces = useAgentsStore((state) => state.collapsedWorkspaces);
  const setActiveWorkspace = useAgentsStore((state) => state.setActiveWorkspace);
  const toggleWorkspaceCollapse = useAgentsStore((state) => state.toggleWorkspaceCollapse);
  const togglePin = useAgentsStore((state) => state.togglePin);
  const toggleArchive = useAgentsStore((state) => state.toggleArchive);
  const setArchiveOpen = useAgentsStore((state) => state.setArchiveOpen);

  const renameTarget = useDialogStore((state) => state.renameTarget);
  const openRename = useDialogStore((state) => state.openRename);
  const closeRename = useDialogStore((state) => state.closeRename);
  const openConfirm = useDialogStore((state) => state.openConfirm);
  const showContextMenu = useContextMenuStore((state) => state.show);
  const deleteAgent = useAgentsStore((state) => state.deleteAgent);
  const renameAgent = useAgentsStore((state) => state.renameAgent);

  // grouped 视图专用：墙内可见集（含筛选），不渲染归档
  const { wall } = useVisibleAgents();

  if (viewMode !== "grouped") return null;

  const groups = groupByAgents(wall, groupBy, activeWorkspace);
  // tab 列表 = 组键去重（拼音模式约 27 个；名称模式可能很多，截断显示前 20 个 + …）
  const tabKeys = ["all", ...groups.map((group) => group.key)];
  const tabKeysDedupe: string[] = [];
  for (const key of tabKeys) {
    if (!tabKeysDedupe.includes(key)) tabKeysDedupe.push(key);
  }
  const tabs = tabKeysDedupe.slice(0, 22);

  const buildAgentMenu = (agent: Agent): ContextMenuItem[] => {
    const pinned = pinnedIds.includes(agent.id);
    const manualArchived = useAgentsStore.getState().archivedIds.includes(agent.id);
    return [
      {
        id: pinned ? "unpin" : "pin",
        label: pinned ? "取消钉住" : "钉住（始终在墙）",
        onClick: () => togglePin(agent.id),
      },
      {
        id: manualArchived ? "unarchive" : "archive",
        label: manualArchived ? "从归档恢复" : "移至归档",
        onClick: () => {
          if (manualArchived) {
            toggleArchive(agent.id);
          } else {
            toggleArchive(agent.id);
            setArchiveOpen(true);
          }
        },
      },
      { id: "divider-1", label: "", onClick: () => {}, divider: true },
      {
        id: "rename",
        label: "重命名",
        onClick: () => openRename(agent.id),
      },
      {
        id: "delete",
        label: "删除 Agent（含会话）",
        onClick: () => {
          openConfirm({
            title: "删除 Agent",
            message: `确定删除 ${agent.name} 及其所有消息？此操作不可撤销。`,
            confirmLabel: "删除",
            onConfirm: () => {
              void deleteAgent(agent.id);
            },
          });
        },
      },
    ];
  };

  const onGroupContextMenu = (event: React.MouseEvent, agent: Agent) => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu({ x: event.clientX, y: event.clientY }, buildAgentMenu(agent));
  };

  return (
    <div className="grouped-wall">
      {/* 工作区切换 tab */}
      <div className="ws-tabs" role="tablist" aria-label="分组切换">
        {tabs.map((ws) => {
          const label =
            ws === "all" ? "全部" : groups.find((group) => group.key === ws)?.label ?? ws;
          const active = activeWorkspace === ws;
          return (
            <button
              key={ws}
              type="button"
              role="tab"
              aria-selected={active}
              className={`ws-tabs__tab${active ? " ws-tabs__tab--active" : ""}`}
              title={ws === "all" ? "全部组" : ws}
              onClick={() => setActiveWorkspace(ws)}
            >
              {label}
            </button>
          );
        })}
      </div>

      {groups.length === 0 ? (
        <div className="grouped-wall__empty">
          <p>没有符合当前筛选的活动 Agent</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => useAgentsStore.getState().clearFilters()}
          >
            清除筛选
          </button>
        </div>
      ) : null}

      {/* X 轴分列：每组占一列 X 区间 */}
      <div className="grouped-wall__cols">
        {groups.map((group) => {
          const collapsed = collapsedWorkspaces.includes(group.key);
          const groupStyle = {
            "--ws-group-width": `${Math.min(Math.max(group.agents.length, 3), 8) * 232}px`,
          } as CSSProperties;
          return (
            <section key={group.key} className="ws-group" style={groupStyle}>
              <button
                type="button"
                className="ws-group__head"
                aria-expanded={!collapsed}
                onClick={() => toggleWorkspaceCollapse(group.key)}
                title={group.key}
              >
                <span className="ws-group__title">{group.label}</span>
                <span className="ws-group__count">{group.agents.length}</span>
                <span className="ws-group__fold" aria-hidden="true">
                  {collapsed ? "▸" : "▾"}
                </span>
              </button>
              {!collapsed ? (
                <div className="ws-group__tiles">
                  {group.agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="ws-group__tile"
                      onContextMenu={(event) => onGroupContextMenu(event, agent)}
                    >
                      <AgentTile
                        agent={agent}
                        onOpen={onOpen}
                        pinned={pinnedIds.includes(agent.id)}
                        highlight={filters.query}
                        renaming={renameTarget === agent.id}
                        onRenameCommit={(agentName) => {
                          void renameAgent(agent.id, agentName)
                            .then(() => closeRename())
                            .catch(() => undefined);
                        }}
                        onRenameCancel={() => closeRename()}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// 类型引用，保持导出统一（filter 类型供调用方推导）
export type { AgentFilters };