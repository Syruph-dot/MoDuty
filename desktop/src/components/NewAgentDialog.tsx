import { useEffect, useRef, useState } from "react";

import { useAgentsStore } from "../state/agentsStore";
import { useDialogStore } from "../state/dialogStore";

interface FormState {
  name: string;
  workspace_dir: string;
  model: string;
}

const EMPTY_FORM: FormState = { name: "新建Agent", workspace_dir: "", model: "" };

/**
 * 新建 Agent 弹窗（由 dialogStore.newAgentOpen 控制）。
 * 触发点：桌面空白处右键菜单 → dialogStore.openNewAgent。
 */
export default function NewAgentDialog() {
  const open = useDialogStore((state) => state.newAgentOpen);
  const close = useDialogStore((state) => state.closeNewAgent);
  const createAgent = useAgentsStore((state) => state.createAgent);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // 打开时聚焦 + 重置表单
  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
      setSubmitting(false);
      // 等下一帧再 focus，确保 dialog 已挂载
      requestAnimationFrame(() => firstInputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    const workspaceDir = form.workspace_dir.trim();
    if (!name) {
      setError("name 为必填");
      return;
    }
    setSubmitting(true);
    setError(null);
    const spawn = useDialogStore.getState().newAgentSpawn;
    // spawn 是视口坐标；横向滚动时折算成内容坐标，让新磁贴插入到鼠标 X 轴对应列
    const scrollLeft = document.querySelector<HTMLElement>(".tile-wall")?.scrollLeft ?? 0;
    const agent = await createAgent({
      name,
      workspace_dir: workspaceDir,
      ...(form.model.trim() ? { model: form.model.trim() } : {}),
      ...(spawn ? { spawn: { x: spawn.x + scrollLeft, y: spawn.y } } : {}),
    });
    setSubmitting(false);
    if (agent) {
      setForm(EMPTY_FORM);
      close();
    } else {
      setError("创建失败，请查看后端是否可用");
    }
  };

  const onBackdropClick = () => {
    if (!submitting) close();
  };

  return (
    <div className="dialog-backdrop" onClick={onBackdropClick}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="创建 Agent"
        onSubmit={(event) => void submit(event)}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title">Create Agent</h2>

        <label className="dialog__field">
          <span className="dialog__label">Name</span>
          <input
            ref={firstInputRef}
            className="dialog__input"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Research Agent"
          />
        </label>


        <label className="dialog__field">
          <span className="dialog__label">Workspace dir</span>
          <input
            className="dialog__input"
            value={form.workspace_dir}
            onChange={(event) => setForm({ ...form, workspace_dir: event.target.value })}
            placeholder="D:\work\research"
          />
        </label>

        <label className="dialog__field">
          <span className="dialog__label">Model（可选，缺省用全局）</span>
          <input
            className="dialog__input"
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
            placeholder="qwen-plus"
          />
        </label>

        {error ? (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={close} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
