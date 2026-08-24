import { useEffect, useRef, useState } from "react";

import { useAgentsStore } from "../state/agentsStore";

interface NewAgentForm {
  name: string;
  role: string;
  workspace_dir: string;
  model: string;
}

const EMPTY_FORM: NewAgentForm = { name: "", role: "", workspace_dir: "", model: "" };

/** "+" 磁贴：打开创建 Agent 弹窗 */
export default function NewAgentTile() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewAgentForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const createAgent = useAgentsStore((state) => state.createAgent);

  useEffect(() => {
    if (open) {
      firstInputRef.current?.focus();
    }
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    const role = form.role.trim();
    const workspaceDir = form.workspace_dir.trim();
    if (!name || !role || !workspaceDir) {
      setError("name / role / workspace_dir 均为必填");
      return;
    }
    setSubmitting(true);
    setError(null);
    const agent = await createAgent({
      name,
      role,
      workspace_dir: workspaceDir,
      ...(form.model.trim() ? { model: form.model.trim() } : {}),
    });
    setSubmitting(false);
    if (agent) {
      setForm(EMPTY_FORM);
      setOpen(false);
    } else {
      setError("创建失败，请查看后端是否可用");
    }
  };

  const close = () => {
    if (!submitting) {
      setOpen(false);
      setError(null);
    }
  };

  return (
    <>
      <button type="button" className="new-tile" onClick={() => setOpen(true)} aria-label="新建 Agent">
        <span className="new-tile__plus" aria-hidden="true">
          +
        </span>
        <span className="new-tile__label">New Agent</span>
      </button>

      {open ? (
        <div className="dialog-backdrop" onClick={close}>
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
              <span className="dialog__label">Role / 系统提示词</span>
              <textarea
                className="dialog__input dialog__input--area"
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value })}
                placeholder="You are a research assistant that verifies sources."
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

            {error ? <p className="dialog__error" role="alert">{error}</p> : null}

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
      ) : null}
    </>
  );
}