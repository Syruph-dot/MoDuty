import { useEffect, useRef, useState } from "react";

import { useDialogStore } from "../state/dialogStore";
import { fetchSettings, updateSettings, fetchModels } from "../lib/api";

interface FormState {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const EMPTY_FORM: FormState = { apiKey: "", baseUrl: "", model: "" };

/**
 * 设置弹窗（由 dialogStore.settingsOpen 控制）。
 * 触发点：桌面空白处右键菜单 → dialogStore.openSettings。
 * 内容（依兰/一栏）：API Key/Token、Base URL、默认模型；
 * 默认模型由 Base URL 官方 /models 拉取后选择。
 */
export default function SettingsDialog() {
  const open = useDialogStore((state) => state.settingsOpen);
  const close = useDialogStore((state) => state.closeSettings);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [models, setModels] = useState<string[]>([]);
  const [keyMasked, setKeyMasked] = useState<string>("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // 打开时：重置并预填当前配置（apiKey 仅回显掩码，需手动重填才修改）
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    setModels([]);
    setSaving(false);
    setForm(EMPTY_FORM);
    void (async () => {
      try {
        const settings = await fetchSettings();
        setForm({ apiKey: "", baseUrl: settings.baseUrl ?? "", model: settings.model ?? "" });
        setKeyMasked(settings.apiKey_masked ?? "");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    requestAnimationFrame(() => firstInputRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const loadModels = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const list = await fetchModels();
      setModels(list);
      if (list.length === 0) {
        setError("未拉取到模型列表（请确认 Base URL 与 API Key 正确）");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    // 空字段表示不修改：例如留空 apiKey 时不覆盖已保存的密钥
    const patch: { apiKey?: string; baseUrl?: string; model?: string } = {};
    if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
    if (form.baseUrl.trim()) patch.baseUrl = form.baseUrl.trim();
    if (form.model.trim()) patch.model = form.model.trim();
    try {
      await updateSettings(patch);
      setSaved(true);
      if (patch.apiKey) setKeyMasked(`${patch.apiKey.slice(0, 8)}...`);
      setTimeout(() => close(), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onBackdropClick = () => {
    if (!saving) close();
  };

  return (
    <div className="dialog-backdrop" onClick={onBackdropClick}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onSubmit={(event) => void submit(event)}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title">Settings（凭证与模型）</h2>

        <label className="dialog__field">
          <span className="dialog__label">API Key / Token</span>
          <input
            ref={firstInputRef}
            className="dialog__input"
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            placeholder="sk-...（留空则不修改已保存的密钥）"
          />
          {keyMasked ? <span style={{ opacity: 0.7, fontSize: 12 }}>当前已配置：{keyMasked}</span> : null}
        </label>

        <label className="dialog__field">
          <span className="dialog__label">Base URL（OpenAI 兼容，留空 = 阿里云 DashScope）</span>
          <input
            className="dialog__input"
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
          />
        </label>

        <label className="dialog__field">
          <span className="dialog__label">默认模型</span>
          <input
            className="dialog__input"
            list="momoka-model-list"
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
            placeholder="qwen-plus"
          />
          <datalist id="momoka-model-list">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void loadModels()}
            disabled={loadingModels}
          >
            {loadingModels ? "拉取中…" : "从 Base URL 获取模型列表"}
          </button>
        </label>

        {error ? (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p style={{ color: "#4caf50", fontSize: 13, margin: "4px 0" }} role="status">
            已保存
          </p>
        ) : null}

        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
