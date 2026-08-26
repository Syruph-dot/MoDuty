import { useDialogStore } from "../state/dialogStore";

/** 通用确认弹窗：由 dialogStore.confirm 驱动，用于删除 Agent 等危险操作的二次确认。 */
export default function ConfirmDialog() {
  const confirm = useDialogStore((state) => state.confirm);
  const closeConfirm = useDialogStore((state) => state.closeConfirm);
  if (!confirm) return null;
  const { title, message, confirmLabel = "确定", onConfirm } = confirm;

  const run = () => {
    closeConfirm();
    onConfirm();
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeConfirm();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="dialog__title">{title}</h2>
        <p className="dialog__message">{message}</p>
        <div className="dialog__actions">
          <button type="button" className="dialog__btn dialog__btn--ghost" onClick={closeConfirm}>
            取消
          </button>
          <button
            type="button"
            className="dialog__btn dialog__btn--danger"
            onClick={run}
            style={{ background: "#e53935", borderColor: "#e53935", color: "#fff" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
