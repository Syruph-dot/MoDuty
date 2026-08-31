import { useEffect, useState } from "react";

import { useDialogStore } from "../state/dialogStore";
import { useWidgetStore } from "../state/widgetStore";

/** Widget 重命名弹窗：由 widget 磁贴右键「重命名 Widget」触发（dialogStore.renameWidgetTarget）。 */
export default function RenameWidgetDialog() {
  const renameWidgetTarget = useDialogStore((state) => state.renameWidgetTarget);
  const closeRenameWidget = useDialogStore((state) => state.closeRenameWidget);
  const widgets = useWidgetStore((state) => state.widgets);
  const renameWidget = useWidgetStore((state) => state.renameWidget);

  const target = widgets.find((candidate) => candidate.id === renameWidgetTarget) ?? null;
  const [name, setName] = useState("");

  useEffect(() => {
    if (renameWidgetTarget) {
      const found = widgets.find((candidate) => candidate.id === renameWidgetTarget);
      if (found) setName(found.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameWidgetTarget]);

  if (!renameWidgetTarget || !target) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    renameWidget(renameWidgetTarget, trimmed);
    closeRenameWidget();
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRenameWidget();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="重命名 Widget">
        <h2 className="dialog__title">重命名 Widget</h2>
        <label className="dialog__field">
          <span className="dialog__label">名称</span>
          <input
            className="dialog__input"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") closeRenameWidget();
            }}
          />
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={closeRenameWidget}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
