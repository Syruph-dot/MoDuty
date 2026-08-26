import { useEffect, useState } from "react";

import { useAgentsStore } from "../state/agentsStore";
import { useDialogStore } from "../state/dialogStore";

/** 重命名 Agent 弹窗：由 TileShell 卡片右键「重命名 Agent」触发（dialogStore.renameTarget）。 */
export default function RenameAgentDialog() {
  const renameTarget = useDialogStore((state) => state.renameTarget);
  const closeRename = useDialogStore((state) => state.closeRename);
  const agents = useAgentsStore((state) => state.agents);
  const renameAgent = useAgentsStore((state) => state.renameAgent);

  const target = agents.find((candidate) => candidate.id === renameTarget) ?? null;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 仅在打开/切换重命名目标时初始化输入框。
    // 不能依赖 target（对象引用）：Agent 状态经 SSE 更新（applyAgentEvent 会重建对象）时
    // 会把用户正在编辑的名字重置回原名。
    if (renameTarget) {
      const found = agents.find((candidate) => candidate.id === renameTarget);
      if (found) {
        setName(found.name);
        setError(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTarget]);

  if (!renameTarget || !target) return null;

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("名称不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameAgent(renameTarget, trimmed);
      closeRename();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRename();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="重命名 Agent">
        <h2 className="dialog__title">重命名 Agent</h2>
        <label className="dialog__field">
          <span className="dialog__label">名称</span>
          <input
            className="dialog__input"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) void submit();
              if (event.key === "Escape") closeRename();
            }}
          />
        </label>
        {error ? <p className="dialog__error" role="alert">{error}</p> : null}
        <div className="dialog__actions">
          <button type="button" className="dialog__btn dialog__btn--ghost" onClick={closeRename} disabled={busy}>
            取消
          </button>
          <button type="button" className="dialog__btn dialog__btn--primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
