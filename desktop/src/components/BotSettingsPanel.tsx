import { useCallback, useEffect, useRef, useState } from "react";

import {
  botAction,
  cancelWechatBotLogin,
  fetchBots,
  fetchBotStatus,
  listSessionOptions,
  logoutWechatBot,
  saveBotTarget,
  saveFeishuBot,
  setWechatBotEnabled,
  startWechatBotLogin,
  type BotConnectionState,
  type BotStatusView,
  type BotsView,
  type SessionOptionView,
} from "../lib/api";

/**
 * 设置页「远程机器人」区块：飞书 + 微信两个入口，让手机能操控 MoDuty。
 *
 * 数据来源 /api/bots（见 src/http/bot-routes.ts）。密钥永不回传，所以输入框只显示占位提示
 * 「已保存（留空不改）」；保存时留空 = 不动原值。
 * 页面打开期间每 3 秒拉一次状态（只为看连接灯和扫码状态），不覆盖正在编辑的输入。
 */

const STATE_DOT: Record<BotConnectionState, string> = {
  connected: "#8ce99a",
  connecting: "#ffd43b",
  waiting_scan: "#ffd43b",
  scanned: "#ffd43b",
  disabled: "rgba(232,237,247,0.28)",
  not_configured: "rgba(232,237,247,0.28)",
  expired: "#ff8787",
  error: "#ff8787",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  fontFamily: "inherit",
  fontSize: 13,
  padding: "7px 10px",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 8,
  color: "#e8edf7",
  outline: "none",
};

function StatusDot({ state }: { state: BotConnectionState }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: STATE_DOT[state] ?? "rgba(232,237,247,0.28)",
        boxShadow: state === "connected" ? "0 0 6px rgba(140,233,154,0.8)" : undefined,
      }}
    />
  );
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function BotSettingsPanel() {
  const [view, setView] = useState<BotsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [domain, setDomain] = useState<"feishu" | "lark">("feishu");
  const [sessions, setSessions] = useState<SessionOptionView[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const dirtyRef = useRef(false);

  const statusOf = (kind: "feishu" | "wechat"): BotStatusView | undefined =>
    view?.statuses.find((item) => item.kind === kind);

  const load = useCallback(async () => {
    try {
      const data = await fetchBots();
      setView(data);
      setError(null);
      // 只在没动过输入框时回填，避免打断编辑
      if (!dirtyRef.current) {
        setAppId(data.config.feishu.appId);
        setDomain(data.config.feishu.domain);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 状态轮询：只看连接灯与扫码状态，不动表单
  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchBotStatus()
        .then((data) => {
          setView((prev) => (prev ? { ...prev, statuses: data.statuses, activity: data.activity } : prev));
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const run = useCallback(
    async (label: string, job: () => Promise<unknown>, okText?: string) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        await job();
        await load();
        if (okText) setNotice(okText);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const ensureSessions = useCallback(async () => {
    if (sessionsLoaded) return;
    try {
      const list = await listSessionOptions();
      const sorted = [...list].sort((a, b) =>
        String(b.last_message_at ?? "").localeCompare(String(a.last_message_at ?? "")),
      );
      setSessions(sorted);
      setSessionsLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionsLoaded]);

  const feishu = statusOf("feishu");
  const wechat = statusOf("wechat");
  const config = view?.config;
  const activity = view?.activity;
  const wechatQr = wechat?.login?.qrDataUrl ?? "";
  const target = config?.defaultTarget ?? { kind: "dispatcher" as const };

  return (
    <>
      {error ? (
        <div className="settings-msg settings-msg--error" role="alert">
          {error}
        </div>
      ) : notice ? (
        <div className="settings-msg settings-msg--ok" role="status">
          {notice}
        </div>
      ) : null}
      <p className="settings-main__sub">
        手机装飞书或微信，把消息发给这个机器人，就等于在手机上下命令：裸文本交给值日生，带 <span className="settings-kbd">/</span> 的命令直接对应 CLI
        动词。两个渠道共用同一条命令通路，回复都是纯文本。
      </p>

      {/* 飞书 */}
      <section className="settings-group">
        <h3 className="settings-group__title">飞书机器人（长连接）</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row__grow">
              <div className="settings-row__label">
                <StatusDot state={feishu?.state ?? "disabled"} /> {feishu?.label ?? "读取中…"}
              </div>
              <div className="settings-row__desc">
                长连接由本机主动连飞书网关，不需要公网地址或回调 URL。凭证写在本机配置里，接口不回传密钥。
              </div>
              {feishu?.error ? (
                <div className="settings-row__desc" style={{ color: "#ff8787" }}>
                  {feishu.error}
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="settings-btn"
                disabled={busy !== null || feishu?.state !== "connected"}
                onClick={() => void run("feishu-test", () => botAction("feishu", "test"), "已把测试消息发给最近说话的会话")}
              >
                测试发送
              </button>
              <button
                type="button"
                className="settings-btn"
                disabled={busy !== null || !config?.feishu.enabled}
                onClick={() => void run("feishu-disable", () => botAction("feishu", "disable"), "飞书机器人已停用")}
              >
                停用
              </button>
            </div>
          </div>

          <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <label className="settings-field">
              <span className="settings-field__label">App ID</span>
              <input
                type="text"
                value={appId}
                spellCheck={false}
                style={inputStyle}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                onChange={(event) => {
                  dirtyRef.current = true;
                  setAppId(event.target.value);
                }}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">
                App Secret {config?.feishu.hasSecret ? "（已保存，留空不改）" : ""}
              </span>
              <input
                type="password"
                value={appSecret}
                spellCheck={false}
                style={inputStyle}
                placeholder={config?.feishu.hasSecret ? "••••••（留空 = 不修改）" : "开放平台「凭证与基础信息」里的 App Secret"}
                onChange={(event) => {
                  dirtyRef.current = true;
                  setAppSecret(event.target.value);
                }}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">域名</span>
              <select
                value={domain}
                style={inputStyle}
                onChange={(event) => {
                  dirtyRef.current = true;
                  setDomain(event.target.value === "lark" ? "lark" : "feishu");
                }}
              >
                <option value="feishu">feishu（国内版 open.feishu.cn）</option>
                <option value="lark">lark（国际版 open.larksuite.com）</option>
              </select>
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                disabled={busy !== null || !appId.trim()}
                onClick={() =>
                  void run(
                    "feishu-save",
                    async () => {
                      dirtyRef.current = false;
                      await saveFeishuBot({
                        enabled: true,
                        appId: appId.trim(),
                        domain,
                        // 留空 = 不修改（后端约定）
                        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
                      });
                      setAppSecret("");
                    },
                    "飞书配置已保存，正在建立长连接",
                  )
                }
              >
                {busy === "feishu-save" ? "连接中…" : "保存并连接"}
              </button>
              {config?.feishu.hasSecret ? (
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy !== null}
                  onClick={() => void run("feishu-clear", () => saveFeishuBot({ enabled: false, clearSecret: true }), "已清除 App Secret")}
                >
                  清除密钥
                </button>
              ) : null}
            </div>
            <div className="settings-row__desc">
              开放平台准备：自建应用 → 开启「机器人」能力 → 事件订阅方式选「长连接」→ 订阅事件{" "}
              <span className="settings-kbd">im.message.receive_v1</span> → 权限 <span className="settings-kbd">im:message</span>
              （接收与发送消息）。群聊里需要 @机器人。
            </div>
          </div>
        </div>
      </section>

      {/* 微信 */}
      <section className="settings-group">
        <h3 className="settings-group__title">微信机器人（iLink 扫码登录）</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row__grow">
              <div className="settings-row__label">
                <StatusDot state={wechat?.state ?? "not_configured"} /> {wechat?.label ?? "读取中…"}
              </div>
              <div className="settings-row__desc">
                扫码后 MoDuty 以这个微信号的身份收发消息（iLink Bot 协议）。凭证只在本机，退出登录会清除。
              </div>
              {wechat?.error ? (
                <div className="settings-row__desc" style={{ color: "#ff8787" }}>
                  {wechat.error}
                </div>
              ) : null}
              {config?.wechat.hasToken ? (
                <div className="settings-row__desc">
                  Bot：<span className="settings-kbd">{config.wechat.ilinkBotId}</span>
                  {config.wechat.loggedInAt ? ` · 登录于 ${new Date(config.wechat.loggedInAt).toLocaleString()}` : ""}
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {wechatQr ? (
                <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void run("wechat-cancel", () => cancelWechatBotLogin())}>
                  取消扫码
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={busy !== null}
                  onClick={() => void run("wechat-login", () => startWechatBotLogin(), "用微信扫一扫下面的二维码")}
                >
                  {busy === "wechat-login" ? "获取二维码…" : "扫码登录"}
                </button>
              )}
              {config?.wechat.hasToken ? (
                <>
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={busy !== null || !config.wechat.enabled}
                    onClick={() =>
                      void run(
                        "wechat-toggle",
                        () => setWechatBotEnabled(!config.wechat.enabled),
                        config.wechat.enabled ? "微信机器人已停用" : "微信机器人已启用",
                      )
                    }
                  >
                    {config.wechat.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={busy !== null || wechat?.state !== "connected"}
                    onClick={() => void run("wechat-test", () => botAction("wechat", "test"), "已把测试消息发给最近说话的会话")}
                  >
                    测试发送
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-btn--danger"
                    disabled={busy !== null}
                    onClick={() => void run("wechat-logout", () => logoutWechatBot(), "已退出微信登录")}
                  >
                    退出登录
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {wechatQr ? (
            <div className="settings-row" style={{ gap: 16 }}>
              <img
                src={wechatQr}
                alt="微信 iLink 登录二维码"
                style={{ width: 168, height: 168, borderRadius: 10, background: "#fff", padding: 6 }}
              />
              <div className="settings-row__grow">
                <div className="settings-row__label">用手机微信「扫一扫」并确认</div>
                <div className="settings-row__desc">
                  确认后本页状态会变成「已连接」。二维码有效期很短，过期了点「扫码登录」重新取。
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* 默认去处 + 命令速查 */}
      <section className="settings-group">
        <h3 className="settings-group__title">手机说一句话给谁</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row__grow">
              <div className="settings-row__label">裸文本（不带 / 命令）默认去处</div>
              <div className="settings-row__desc">
                选「值日生」时手机发「帮我看看今天的日报」就是直接对她说话；选会话则固定转给那个会话绑定的 Agent。
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                value={target.kind === "session" ? target.sessionId ?? "" : ""}
                style={{ ...inputStyle, width: 240 }}
                onFocus={() => void ensureSessions()}
                onChange={(event) => {
                  const value = event.target.value;
                  void run(
                    "target",
                    () => (value ? saveBotTarget({ kind: "session", sessionId: value }) : saveBotTarget({ kind: "dispatcher" })),
                    value ? "默认去处已改为指定会话" : "默认去处已改为值日生",
                  );
                }}
              >
                <option value="">值日生（调度者）</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name || session.goal || session.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <div className="settings-row__label">手机上可用的话</div>
            <div className="settings-row__desc" style={{ lineHeight: 1.8 }}>
              <span className="settings-kbd">直接一句话</span> 交给值日生 ·{" "}
              <span className="settings-kbd">/status</span> 现在怎么样 ·{" "}
              <span className="settings-kbd">/sessions 关键词</span> 找会话 ·{" "}
              <span className="settings-kbd">/chat 会话 一句话</span> ·{" "}
              <span className="settings-kbd">/agent 名字 一句话</span> ·{" "}
              <span className="settings-kbd">/dispatch 名字 任务</span> 派活 ·{" "}
              <span className="settings-kbd">/new 名字</span> 新建 ·{" "}
              <span className="settings-kbd">/help</span> 全部说明
            </div>
            <div className="settings-row__desc">
              最近收到：{activity?.lastInboundAt ? `${fmtTime(activity.lastInboundAt)} ｜ ${activity.lastInboundPreview || "(非文本)"}` : "还没有"} · 最近回复：
              {activity?.lastOutboundAt ? fmtTime(activity.lastOutboundAt) : "—"}
            </div>
            <div className="settings-row__desc">
              配置文件：<span className="settings-kbd">{view?.configPath ?? "~/.momoka/bots.json"}</span>（本机文件，含密钥明文，别外传）
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
