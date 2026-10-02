import { useCallback, useEffect, useRef, useState } from "react";

import BotSettingsPanel from "./BotSettingsPanel";
import SourcePanel from "./SourcePanel";
import { useDialogStore } from "../state/dialogStore";
import { notifyNative } from "../lib/nativeNotify";
import {
  getOverscrollEffect,
  onOverscrollEffectChange,
  setOverscrollEffect,
  useEdgeOverscroll,
  type EdgeOverscrollMode,
} from "../lib/edgeOverscroll";
import {
  fetchModels,
  fetchSettings,
  fetchShellVerbStatus,
  updateSandbox,
  updateSettings,
  updateShellVerb,
  type ModelPoolEntryView,
  type ShellVerbStatusView,
  type TierDefaultsView,
} from "../lib/api";

type SettingsTab = "models" | "sources" | "bots" | "runtime" | "about";

const NAV_ITEMS: Array<{ key: SettingsTab; label: string; icon?: string }> = [
  { key: "models", label: "模型与轨道" },
  { key: "sources", label: "会话来源" },
  { key: "bots", label: "远程机器人" },
  { key: "runtime", label: "运行时" },
  { key: "about", label: "关于" },
];

function shellVerbStatusText(status: ShellVerbStatusView | null): string {
  if (!status) return "无法读取注册状态（后端不可用）。";
  if (!status.supported) return "当前平台不支持（仅 Windows）。";
  if (!status.script_exists || !status.launcher_exists || !status.bridge_exists) {
    return "注册文件缺失：请确认 scripts/ 下的 register-shell-verb.ps1、moduty-launch.vbs、shell-verb-bridge.mjs 均存在。";
  }
  if (status.registered) return "已注册（文件 / 文件夹 / 桌面背景）。新开资源管理器窗口后生效。";
  if (status.partial) return "部分注册（三项未全部写入），建议重新注册。";
  return "未注册。";
}

/**
 * SettingsScreen — Win8 组织风格全屏设置页。
 * - 打开：磁贴墙先播放退出动画（Desktop 根 class .tile-wall--settings-leaving），
 *   设置页自身从左侧浮入（CSS animation）。
 * - 关闭：设置页向左浮出后卸载，磁贴墙恢复。
 */
export default function SettingsScreen() {
  const open = useDialogStore((state) => state.settingsOpen);
  const closeSettings = useDialogStore((state) => state.closeSettings);

  const [tab, setTab] = useState<SettingsTab>("models");
  const [closing, setClosing] = useState(false);

  // 模型池状态
  const [pool, setPool] = useState<ModelPoolEntryView[]>([]);
  const [defaults, setDefaults] = useState<TierDefaultsView>({ high: null, low: null, exact: null });
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [agentPersona, setAgentPersona] = useState("");
  const [crossWorkspaceExperienceRecall, setCrossWorkspaceExperienceRecall] = useState(false);
  const [personaDirty, setPersonaDirty] = useState(false);
  const [shellVerb, setShellVerb] = useState<ShellVerbStatusView | null>(null);
  const [shellVerbBusy, setShellVerbBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 编辑抽屉
  const [draft, setDraft] = useState<ModelPoolEntryView | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  useEdgeOverscroll(mainRef); // 设置页滚动容器：边界拖动效果（Glow/Stretch 跟随下方选择）
  const [overscrollEffect, setOverscrollEffectState] = useState<EdgeOverscrollMode>(getOverscrollEffect());
  useEffect(() => onOverscrollEffectChange(setOverscrollEffectState), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await fetchSettings();
      setPool(settings.modelPool ?? []);
      setDefaults(settings.tierDefaults ?? { high: null, low: null, exact: null });
      setSandboxEnabled(settings.sandbox_enabled);
      setAgentPersona(settings.agent_persona ?? "");
      setCrossWorkspaceExperienceRecall(settings.cross_workspace_experience_recall === true);
      setPersonaDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadShellVerb = useCallback(async () => {
    try {
      setShellVerb(await fetchShellVerbStatus());
    } catch {
      setShellVerb(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setClosing(false);
    setTab("models");
    setError(null);
    setSaved(false);
    setDraft(null);
    setModels([]);
    void load();
    void loadShellVerb();
  }, [open, load, loadShellVerb]);

  // 关闭动画：设置页向左浮出后再真正关闭（磁贴墙随即恢复）
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => closeSettings(), 250);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing]);

  if (!open) return null;

  const slug = (name: string) =>
    name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `m${Date.now().toString(36)}`;

  const openNew = () => {
    setError(null);
    setModels([]);
    setDraft({ id: "", name: "", baseUrl: "", apiKey: "", model: "", enabled: true });
    requestAnimationFrame(() => firstInputRef.current?.focus());
  };
  const openEdit = (entry: ModelPoolEntryView) => {
    setError(null);
    setModels([]);
    setDraft({ ...entry });
  };
  const closeDraft = () => {
    setDraft(null);
    setModels([]);
  };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      setError("Base URL 与 模型 必填");
      return;
    }
    const entry: ModelPoolEntryView = {
      ...draft,
      id: draft.id || slug(draft.name || draft.model),
      baseUrl: draft.baseUrl.trim().replace(/\/+$/u, ""),
      model: draft.model.trim(),
      name: draft.name.trim() || draft.model.trim(),
    };
    if (pool.some((item) => item.id === entry.id)) {
      setPool((prev) => prev.map((item) => (item.id === entry.id ? entry : item)));
    } else {
      setPool((prev) => [...prev, entry]);
    }
    setDraft(null);
    setModels([]);
    setSaved(false);
  };

  const removeEntry = (id: string) => {
    const entry = pool.find((item) => item.id === id);
    if (!window.confirm(`删除模型条目「${entry?.name ?? id}」？`)) return;
    setPool((prev) => prev.filter((item) => item.id !== id));
    setDefaults((prev) => ({
      high: prev.high === id ? null : prev.high,
      low: prev.low === id ? null : prev.low,
      exact: prev.exact === id ? null : prev.exact,
    }));
    setSaved(false);
  };

  const toggleDefault = (id: string, tier: keyof TierDefaultsView) => {
    setDefaults((prev) => (prev[tier] === id ? { ...prev, [tier]: null } : { ...prev, [tier]: id }));
    setSaved(false);
  };

  const toggleEnabled = (id: string, enabled: boolean) => {
    setPool((prev) => prev.map((item) => (item.id === id ? { ...item, enabled } : item)));
    if (!enabled) {
      setDefaults((prev) => ({
        high: prev.high === id ? null : prev.high,
        low: prev.low === id ? null : prev.low,
        exact: prev.exact === id ? null : prev.exact,
      }));
    }
    setSaved(false);
  };

  const loadModels = async () => {
    if (!draft) return;
    setLoadingModels(true);
    setError(null);
    try {
      const list = await fetchModels({
        baseUrl: draft.baseUrl.trim() || undefined,
        apiKey: (draft.apiKey ?? "").trim() || undefined,
      });
      setModels(list);
      if (list.length === 0) setError("未拉取到模型列表（请确认 Base URL 与 API Key 正确）");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
    }
  };

  const submitPool = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateSettings({ modelPool: pool, tierDefaults: defaults });
      setSaved(true);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleSandbox = async (next: boolean) => {
    setError(null);
    setSaved(false);
    try {
      const result = await updateSandbox(next);
      setSandboxEnabled(result);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const applyShellVerb = async (action: "register" | "unregister") => {
    setShellVerbBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateShellVerb(action);
      setShellVerb(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setShellVerbBusy(false);
    }
  };

  const savePersona = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const trimmed = agentPersona.trim();
      await updateSettings({ agent_persona: trimmed || null });
      setSaved(true);
      setPersonaDirty(false);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveCrossWorkspaceExperienceRecall = async (enabled: boolean) => {
    const previous = crossWorkspaceExperienceRecall;
    setCrossWorkspaceExperienceRecall(enabled);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateSettings({ cross_workspace_experience_recall: enabled });
      setSaved(true);
    } catch (err) {
      setCrossWorkspaceExperienceRecall(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const labelOf = (id: string | null) => {
    if (!id) return "未设置";
    return pool.find((item) => item.id === id)?.name ?? "未设置";
  };
  const enabledCount = pool.filter((item) => item.enabled).length;
  const msgBox = error ? (
    <div className="settings-msg settings-msg--error" role="alert">{error}</div>
  ) : saved ? (
    <div className="settings-msg settings-msg--ok" role="status">已保存</div>
  ) : null;

  return (
    <div className={`settings-screen${closing ? " settings-screen--exit" : ""}`} data-tab={tab}>
      {/* 左侧分类导航 */}
      <nav className="settings-nav" aria-label="设置分类">
        <div className="settings-nav__brand">
          MoDuty 设置
          <small>模型池 · 轨道 · 运行时 · 机器人</small>
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`settings-nav__item${tab === item.key ? " settings-nav__item--active" : ""}`}
            onClick={() => {
              setTab(item.key);
              setError(null);
              setSaved(false);
            }}
          >
            {item.label}
          </button>
        ))}
        <div className="settings-nav__spacer" />
        <button type="button" className="settings-nav__back" onClick={requestClose}>
          ← 返回桌面（Esc）
        </button>
      </nav>

      {/* 右侧大平面 */}
      <main ref={mainRef} className="settings-main" style={{ outline: "none" }} tabIndex={-1}>
        {tab === "models" ? (
          <>
            <h2 className="settings-main__title">模型与轨道</h2>
            <p className="settings-main__sub">
              模型池保存你的可用模型（Base URL + API Key + 模型名）；“高/低/指定”只是指向池条目的默认指针，仅在选择模型层生效。
            </p>
            {msgBox}

            {/* 轨道默认摘要 */}
            <section className="settings-group">
              <h3 className="settings-group__title">轨道默认</h3>
              <div className="settings-card">
                <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13 }}>高消费默认：<b style={{ color: "#8ce99a" }}>{labelOf(defaults.high)}</b></span>
                  <span style={{ fontSize: 13 }}>低消费默认：<b style={{ color: "#8ce99a" }}>{labelOf(defaults.low)}</b></span>
                  <span style={{ fontSize: 13 }}>指定默认：<b style={{ color: "#8ce99a" }}>{labelOf(defaults.exact)}</b></span>
                  <span style={{ fontSize: 13, opacity: 0.7 }}>{pool.length} 条（启用 {enabledCount}）</span>
                </div>
              </div>
            </section>

            {/* 模型池 */}
            <section className="settings-group">
              <h3 className="settings-group__title">模型池</h3>
              {loading ? <p style={{ opacity: 0.6, fontSize: 13 }}>加载中…</p> : null}
              {!loading && pool.length === 0 ? (
                <div className="settings-card">
                  <p style={{ opacity: 0.7, fontSize: 13, margin: 0 }}>
                    还没有模型条目——点下方“＋ 添加模型”开始配置；已有旧版单组配置会在保存时自动迁移为一条“默认配置”。
                  </p>
                </div>
              ) : (
                pool.map((entry) => (
                  <div key={entry.id} className={`settings-entry${entry.enabled ? "" : " settings-entry--dim"}`}>
                    <span className="settings-entry__name" onClick={() => openEdit(entry)} title={entry.baseUrl}>
                      {entry.name}
                    </span>
                    <span className="settings-entry__meta">
                      {entry.model} @ {entry.baseUrl}
                      {entry.apiKey ? "" : "（免鉴权）"}
                    </span>
                    <button
                      type="button"
                      className={`settings-badge${defaults.high === entry.id ? " settings-badge--active" : ""}`}
                      onClick={() => toggleDefault(entry.id, "high")}
                      title="设为高消费默认"
                    >
                      高
                    </button>
                    <button
                      type="button"
                      className={`settings-badge${defaults.low === entry.id ? " settings-badge--active" : ""}`}
                      onClick={() => toggleDefault(entry.id, "low")}
                      title="设为低消费默认"
                    >
                      低
                    </button>
                    <button
                      type="button"
                      className={`settings-badge${defaults.exact === entry.id ? " settings-badge--active" : ""}`}
                      onClick={() => toggleDefault(entry.id, "exact")}
                      title="设为精确（手动指定）默认"
                    >
                      指定
                    </button>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                      <input type="checkbox" checked={entry.enabled} onChange={(event) => toggleEnabled(entry.id, event.target.checked)} />
                      启用
                    </label>
                    <button type="button" className="settings-btn settings-btn--small" onClick={() => openEdit(entry)}>
                      编辑
                    </button>
                    <button type="button" className="settings-btn settings-btn--small settings-btn--danger" onClick={() => removeEntry(entry.id)}>
                      删除
                    </button>
                  </div>
                ))
              )}
            </section>

            {/* 编辑抽屉 */}
            {draft ? (
              <div className="settings-drawer">
                <div className="settings-drawer__title">{draft.id ? "编辑模型条目" : "添加模型条目"}</div>
                <label className="settings-field">
                  <span className="settings-field__label">名称（如 “Zen 日常”）</span>
                  <input
                    ref={firstInputRef}
                    type="text"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="OpenCode Zen（日常）"
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">Base URL（OpenAI 兼容）</span>
                  <input
                    type="text"
                    value={draft.baseUrl}
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                    placeholder="https://opencode.ai/zen/v1"
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">API Key（可留空 = 免鉴权）</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={draft.apiKey ?? ""}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                    placeholder="sk-..."
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">模型</span>
                  <input
                    type="text"
                    list="model-pool-list"
                    value={draft.model}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                    placeholder="hy3-free / deepseek-chat"
                  />
                  <datalist id="model-pool-list">
                    {models.map((model) => <option key={model} value={model} />)}
                  </datalist>
                  <button
                    type="button"
                    className="settings-btn"
                    style={{ marginTop: 6 }}
                    onClick={() => void loadModels()}
                    disabled={loadingModels}
                  >
                    {loadingModels ? "拉取中…" : "从 Base URL 获取模型列表"}
                  </button>
                  {models.length > 0 ? (
                    <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>拉取到 {models.length} 个模型，可在上方输入框选择</div>
                  ) : null}
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">上下文窗口（tokens，可留空自动识别）</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.contextWindow ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      const contextWindow = value === "" ? undefined : Number(value);
                      setDraft({
                        ...draft,
                        contextWindow: contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0
                          ? contextWindow
                          : undefined,
                      });
                    }}
                    placeholder="自动识别（如 131072）"
                  />
                  <small style={{ fontSize: 11, opacity: 0.65 }}>用于上下文占用与 Compact 预算；留空时根据模型名推断。</small>
                </label>
                <label className="settings-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={draft.supportsVision === true}
                    onChange={(event) => setDraft({ ...draft, supportsVision: event.target.checked ? true : undefined })}
                  />
                  <span className="settings-field__label" style={{ margin: 0 }}>支持图片输入（多模态）</span>
                  <small style={{ fontSize: 11, opacity: 0.65 }}>
                    勾选后，粘贴的图片会直接作为图像发给该模型；未勾选时只给图片路径与占位说明（图片对模型不可见）。
                  </small>
                </label>
                <div className="settings-actions__right" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                  <button type="button" className="settings-btn" onClick={closeDraft}>取消</button>
                  <button type="button" className="settings-btn settings-btn--primary" onClick={saveDraft}>应用</button>
                </div>
              </div>
            ) : null}

            <div className="settings-actions" style={{ marginTop: 6 }}>
              <button type="button" className="settings-btn" onClick={openNew} disabled={loading || saving}>
                ＋ 添加模型
              </button>
              <div className="settings-actions__right">
                <button type="button" className="settings-btn settings-btn--primary" onClick={(event) => void submitPool(event)} disabled={saving || loading}>
                  {saving ? "保存中…" : "保存模型池设置"}
                </button>
              </div>
            </div>
            <p className="settings-hint">
              普通对话/日报按默认轨道自动选模型：日报类低频任务默认用低消费轨道（可在生成日报前指定 modelTier）。配置保存在 <span className="settings-kbd">~/.momoka/settings.json</span>。
            </p>
          </>
        ) : null}

        {tab === "sources" ? <SourcePanel /> : null}
        {tab === "bots" ? (
          <>
            <h2 className="settings-main__title">远程机器人</h2>
            <BotSettingsPanel />
          </>
        ) : null}

        {tab === "runtime" ? (
          <>
            <h2 className="settings-main__title">运行时</h2>
            <p className="settings-main__sub">后端运行时的行为开关。</p>
            {msgBox}
            <section className="settings-group">
              <h3 className="settings-group__title">执行</h3>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">沙箱模式</div>
                    <div className="settings-row__desc">开启后限制 Agent 工具执行的越界行为（受控文件/命令）。</div>
                  </div>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={sandboxEnabled}
                      onChange={(event) => void toggleSandbox(event.target.checked)}
                    />
                    <span style={{ fontSize: 13 }}>{sandboxEnabled ? "已开启" : "已关闭"}</span>
                  </label>
                </div>
              </div>
            </section>
            <section className="settings-group">
              <h3 className="settings-group__title">资源管理器右键菜单</h3>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">Send to MoDuty Dispatcher</div>
                    <div className="settings-row__desc">
                      在资源管理器或桌面右键，把选中的文件/文件夹直接发给值日生处理。写入 HKCU，无需管理员权限。
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="settings-btn settings-btn--primary"
                      disabled={shellVerbBusy || shellVerb?.supported === false}
                      onClick={() => void applyShellVerb("register")}
                    >
                      {shellVerbBusy ? "处理中…" : "注册"}
                    </button>
                    <button
                      type="button"
                      className="settings-btn"
                      disabled={shellVerbBusy || shellVerb?.supported === false || !shellVerb?.registered}
                      onClick={() => void applyShellVerb("unregister")}
                    >
                      注销
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">当前状态</div>
                    <div className="settings-row__desc">{shellVerbStatusText(shellVerb)}</div>
                    {shellVerb?.detail ? (
                      <pre
                        style={{
                          margin: "8px 0 0",
                          padding: "8px 10px",
                          maxHeight: 160,
                          overflow: "auto",
                          fontSize: 12,
                          lineHeight: 1.5,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.12)",
                          borderRadius: 8,
                          color: "rgba(232,237,247,0.75)",
                        }}
                      >
                        {shellVerb.detail}
                      </pre>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
            <section className="settings-group">
              <h3 className="settings-group__title">界面</h3>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">滚动边界效果（其它页面）</div>
                    <div className="settings-row__desc">
                      列表/页面滚到尽头继续拉时的反馈。Glow：弧形半透明阴影从边缘长出；Stretch：内容被拉出一小段后弹回。主桌面固定为混合版（拉出一小段 → 碰壁 → Glow）。
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["glow", "stretch"] as EdgeOverscrollMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`settings-btn${overscrollEffect === mode ? " settings-btn--primary" : ""}`}
                        onClick={() => {
                          setOverscrollEffect(mode);
                          setOverscrollEffectState(mode);
                        }}
                      >
                        {mode === "glow" ? "Glow 弧影" : "Stretch 拉伸"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            <section className="settings-group">
              <h3 className="settings-group__title">默认 Agent 人格</h3>
              <div className="settings-card">
                <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <div className="settings-row__label">未自定义 role 的 Agent 使用此人格作为 system prompt 首层</div>
                  <div className="settings-row__desc">留空 = 使用内置默认（文件助手/工具行为）；修改后对所有新建及未自定义的 Agent 生效。平台规则（安全/会话引用）固定附加，不受此处影响。</div>
                  <textarea
                    value={agentPersona}
                    onChange={(event) => {
                      setAgentPersona(event.target.value);
                      setPersonaDirty(true);
                      setSaved(false);
                    }}
                    rows={9}
                    spellCheck={false}
                    style={{
                      width: "100%",
                      resize: "vertical",
                      fontFamily: "inherit",
                      fontSize: 13,
                      lineHeight: 1.55,
                      padding: "8px 10px",
                      background: "rgba(255,255,255,0.06)",
                      border: "1px solid rgba(255,255,255,0.14)",
                      borderRadius: 8,
                      color: "#e8edf7",
                      outline: "none",
                    }}
                    placeholder={"# 文件助手\n\n你是一个 Agent（代理）。\n\n## 能力…（内置默认；留空保存即恢复默认）"}
                  />
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button type="button" className="settings-btn" disabled={saving || !personaDirty} onClick={() => void savePersona()}>
                      {saving ? "保存中…" : "保存人格"}
                    </button>
                    <span style={{ fontSize: 12, color: "rgba(232,237,247,0.45)" }}>
                      {personaDirty ? "有未保存修改" : "已同步"}
                    </span>
                  </div>
                </div>
              </div>
            </section>
            <section className="settings-group">
              <h3 className="settings-group__title">工作经验召回范围</h3>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">允许跨工作区召回工作经验</div>
                    <div className="settings-row__desc">关闭时只检索当前工作区且有来源会话的经验；开启后允许从其它工作区和无会话来源的经验中召回，并在本轮显示来源。</div>
                  </div>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={crossWorkspaceExperienceRecall}
                      disabled={saving}
                      onChange={(event) => void saveCrossWorkspaceExperienceRecall(event.target.checked)}
                      aria-label="允许跨工作区召回工作经验"
                    />
                    {crossWorkspaceExperienceRecall ? "已允许" : "仅当前工作区"}
                  </label>
                </div>
              </div>
            </section>
          </>
        ) : null}

        {tab === "about" ? (
          <>
            <h2 className="settings-main__title">关于 MoDuty</h2>
            <p className="settings-main__sub">接口优先的 Agent 桌面 · 磁贴墙（React + Vite + TypeScript）。</p>
            <section className="settings-group">
              <div className="settings-card">
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">版本</div>
                    <div className="settings-row__desc">MoDuty v0.1.0（原 MOMOKA TS）</div>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">配置文件</div>
                    <div className="settings-row__desc"><span className="settings-kbd">~/.momoka/settings.json</span>（可手动编辑，保存即生效）</div>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">模型轨道</div>
                    <div className="settings-row__desc">高/低/指定只是指向模型池条目的指针；日报默认走低消费轨道，普通对话走高消费轨道。</div>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row__grow">
                    <div className="settings-row__label">系统通知</div>
                    <div className="settings-row__desc">
                      需要你介入 / 有结果时发 Windows 原生通知（来源名与图标取自 MoDuty）；通知上的按钮可直接把对应窗口开出来。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="settings-nav__back"
                    onClick={() => {
                      void notifyNative({
                        title: "MoDuty · 通知自检",
                        body: "右下角能看到这条，说明系统通知已经打通。",
                        actions: [{ id: "open-duty", label: "打开值日生页" }],
                      });
                    }}
                  >
                    发送测试通知
                  </button>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
