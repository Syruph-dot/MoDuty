/**
 * 机器人生命周期总管：装配配置 → 起/停两个桥 → 收消息 → 跑 CLI 命令 → 回消息。
 *
 * 两个桥共用这里的一条流水线，保证手机上两种渠道行为一致：
 *   收到消息 → 每个外部会话串行排队（同一会话不并发，避免两条消息抢同一个 Agent）
 *          → 长任务先回「收到，处理中…」→ 执行 CLI → 回正文。
 *
 * 单例：`botManager`。HTTP 路由（src/http/bot-routes.ts）只跟它打交道。
 */
import {
  loadBotConfig,
  saveBotConfig,
  type BotDefaultTarget,
  type BotKind,
  type FeishuBotSettings,
  type WechatBotSettings,
} from "../bot-config.js";
import { classifyBotCommand, runBotCommand } from "./command.js";
import { splitReplyForDelivery } from "./reply-format.js";
import { FeishuBridge } from "./feishu.js";
import { WeChatBridge, type WechatLoginStatus } from "./wechat.js";

export type BotConnectionState =
  | "disabled"
  | "not_configured"
  | "connecting"
  | "connected"
  | "waiting_scan"
  | "scanned"
  | "expired"
  | "error";

export interface BotStatus {
  kind: BotKind;
  state: BotConnectionState;
  /** 给 UI 直接显示的一句话 */
  label: string;
  error?: string;
  connectedAt?: number;
  login?: { status: WechatLoginStatus; qrDataUrl: string; scanUrl: string; error: string };
}

export interface BotActivity {
  lastInboundAt: number;
  lastOutboundAt: number;
  /** 最近一条收到的消息（截断，仅用于 UI 观察链路通不通） */
  lastInboundPreview: string;
}

const DEFAULT_FEISHU: FeishuBotSettings = { enabled: false, appId: "", appSecret: "", domain: "feishu" };
const DEFAULT_WECHAT: WechatBotSettings = {
  enabled: false,
  botToken: "",
  ilinkBotId: "",
  ilinkUserId: "",
  baseUrl: "",
  syncBuf: "",
};

class BotManager {
  private feishuSettings: FeishuBotSettings = { ...DEFAULT_FEISHU };
  private wechatSettings: WechatBotSettings = { ...DEFAULT_WECHAT };
  private defaultTarget: BotDefaultTarget = { kind: "dispatcher" };
  private feishuBridge: FeishuBridge | null = null;
  private wechatBridge: WeChatBridge | null = null;
  /** 每个外部会话一条串行链：`<kind>:<外部会话 id>` → 队尾 Promise */
  private readonly chains = new Map<string, Promise<void>>();
  /** 每种渠道最后一次收到的会话位置（用于「发测试消息」） */
  private readonly lastChat = new Map<BotKind, { chatId: string; replyToMessageId?: string; contextToken?: string }>();
  readonly activity: BotActivity = { lastInboundAt: 0, lastOutboundAt: 0, lastInboundPreview: "" };

  constructor() {
    this.wechatBridge = this.createWechatBridge();
    this.feishuBridge = this.createFeishuBridge();
  }

  // ===== 装配 =====

  /** 重新读配置并按 `enabled` 起停两个桥（启动时与每次改配置后都调） */
  async applyAll(): Promise<void> {
    const config = await loadBotConfig();
    this.feishuSettings = config.feishu;
    this.wechatSettings = config.wechat;
    this.defaultTarget = config.defaultTarget;

    // 飞书
    if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
      if (!this.feishuBridge) this.feishuBridge = this.createFeishuBridge();
      if (!this.feishuBridge.connected) {
        try {
          await this.feishuBridge.start();
        } catch (error) {
          console.warn(`[机器人] 飞书启动失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      this.feishuBridge?.stop();
    }

    // 微信
    if (config.wechat.enabled && config.wechat.botToken && config.wechat.ilinkBotId) {
      try {
        await this.wechatBridge?.start();
      } catch (error) {
        console.warn(`[机器人] 微信启动失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.wechatBridge?.stop();
    }
  }

  private createFeishuBridge(): FeishuBridge {
    return new FeishuBridge({
      getSettings: () => this.feishuSettings,
      onMessage: (input) => {
        this.lastChat.set("feishu", { chatId: input.chatId, replyToMessageId: input.messageId });
        this.noteInbound(input.text);
        this.enqueue(`feishu:${input.chatId}`, () =>
          this.runPipeline("feishu", input.text, async (text) => {
            await this.feishuBridge?.sendText(input.chatId, text, input.messageId);
          }),
        );
      },
      onStatusChange: () => undefined,
    });
  }

  private createWechatBridge(): WeChatBridge {
    return new WeChatBridge({
      getSettings: () => this.wechatSettings,
      saveSettings: async (patch) => {
        const saved = await saveBotConfig({ wechat: patch });
        this.wechatSettings = saved.wechat;
      },
      onLoggedIn: () => {
        void this.applyAll();
      },
      onMessage: (input) => {
        this.lastChat.set("wechat", { chatId: input.fromUserId, contextToken: input.contextToken });
        this.noteInbound(input.unsupportedMedia ? "(非文本消息)" : input.text);
        this.enqueue(`wechat:${input.fromUserId}`, () =>
          this.runPipeline(
            "wechat",
            input.text,
            async (text) => {
              await this.wechatBridge?.sendText(input.fromUserId, text, input.contextToken);
            },
            async (on) => {
              await this.wechatBridge?.sendTyping(input.fromUserId, input.contextToken, on ? 1 : 0);
            },
            input.unsupportedMedia,
          ),
        );
      },
      onStatusChange: () => undefined,
    });
  }

  private noteInbound(text: string): void {
    this.activity.lastInboundAt = Date.now();
    this.activity.lastInboundPreview = text.slice(0, 120);
  }

  private enqueue(key: string, job: () => Promise<void>): void {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(job)
      .catch((error) => {
        console.warn(`[机器人] 处理消息失败（${key}）：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** 一条消息的完整处理：即时反馈 → 执行 CLI → 回正文（错误也回给用户，不静默） */
  private async runPipeline(
    _kind: BotKind,
    text: string,
    reply: (text: string) => Promise<void>,
    typing?: (on: boolean) => Promise<void>,
    mediaOnly = false,
  ): Promise<void> {
    if (mediaOnly) {
      await this.safeReply(reply, "目前只支持文字消息（图片/文件先不在手机上处理）");
      return;
    }
    const quick = classifyBotCommand(text) === "quick";
    try {
      if (!quick) {
        await this.safeReply(reply, "收到，处理中…");
        void typing?.(true);
      }
      const result = await runBotCommand({ text, defaultTarget: this.defaultTarget });
      void typing?.(false);
      await this.safeReply(reply, result.text);
    } catch (error) {
      void typing?.(false);
      const message = error instanceof Error ? error.message : String(error);
      await this.safeReply(reply, `出错了：${message}`);
    }
  }

  private async safeReply(reply: (text: string) => Promise<void>, text: string): Promise<void> {
    // 不截断：一条完整回应拆成多条消息发完（拆点见 splitReplyForDelivery）
    const parts = splitReplyForDelivery(text);
    if (parts.length === 0) return;
    for (const [index, part] of parts.entries()) {
      try {
        await reply(part);
        this.activity.lastOutboundAt = Date.now();
      } catch (error) {
        console.warn(
          `[机器人] 回复失败（第 ${index + 1}/${parts.length} 条）：${error instanceof Error ? error.message : String(error)}`,
        );
        return; // 一条失败就不要再往下刷屏
      }
      if (index < parts.length - 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  // ===== 状态 =====

  status(kind: BotKind): BotStatus {
    if (kind === "feishu") {
      const settings = this.feishuSettings;
      if (!settings.enabled) {
        return { kind, state: "disabled", label: "未启用" };
      }
      if (!settings.appId || !settings.appSecret) {
        return { kind, state: "not_configured", label: "缺少 App ID / Secret" };
      }
      const bridge = this.feishuBridge;
      if (bridge?.connected) {
        return { kind, state: "connected", label: "已连接（长连接）", connectedAt: bridge.connectedAt() };
      }
      const error = bridge?.lastError;
      return error
        ? { kind, state: "error", label: "连接失败", error }
        : { kind, state: "connecting", label: "连接中…" };
    }

    const settings = this.wechatSettings;
    const bridge = this.wechatBridge;
    const login = bridge?.login;
    if (login && login.status !== "idle" && login.status !== "confirmed") {
      const map: Record<string, { state: BotConnectionState; label: string }> = {
        waiting_scan: { state: "waiting_scan", label: "等待扫码" },
        scanned: { state: "scanned", label: "已扫码，等待手机确认" },
        expired: { state: "expired", label: "二维码已过期" },
        error: { state: "error", label: "登录出错" },
      };
      const hit = map[login.status] ?? { state: "connecting" as BotConnectionState, label: "登录中…" };
      return {
        kind,
        state: hit.state,
        label: hit.label,
        ...(login.error ? { error: login.error } : {}),
        login: { status: login.status, qrDataUrl: login.qrDataUrl, scanUrl: login.scanUrl, error: login.error },
      };
    }
    if (!settings.botToken || !settings.ilinkBotId) {
      return { kind, state: "not_configured", label: "未扫码登录" };
    }
    if (!settings.enabled) {
      return { kind, state: "disabled", label: "已登录但未启用" };
    }
    if (bridge?.expired) {
      return { kind, state: "expired", label: "登录已过期，请重新扫码" };
    }
    if (bridge?.running) {
      return {
        kind,
        state: "connected",
        label: settings.displayName ? `已连接（${settings.displayName}）` : "已连接（长轮询）",
        connectedAt: bridge.connectedAt,
        ...(bridge.lastError ? { error: bridge.lastError } : {}),
      };
    }
    return { kind, state: "connecting", label: "启动中…" };
  }

  statuses(): BotStatus[] {
    return [this.status("feishu"), this.status("wechat")];
  }

  // ===== 供路由调用的动作 =====

  async enable(kind: BotKind, enabled: boolean): Promise<void> {
    await saveBotConfig(kind === "feishu" ? { feishu: { enabled } } : { wechat: { enabled } });
    await this.applyAll();
  }

  async restart(kind: BotKind): Promise<void> {
    if (kind === "feishu") {
      this.feishuBridge?.stop();
      this.feishuBridge = null;
      const config = await loadBotConfig();
      this.feishuSettings = config.feishu;
      this.feishuBridge = this.createFeishuBridge();
    } else {
      this.wechatBridge?.stop();
    }
    await this.applyAll();
  }

  async startWechatLogin(): Promise<{ scanUrl: string; qrDataUrl: string }> {
    if (!this.wechatBridge) this.wechatBridge = this.createWechatBridge();
    return await this.wechatBridge.startLogin();
  }

  cancelWechatLogin(): void {
    this.wechatBridge?.cancelLogin();
  }

  async logoutWechat(): Promise<void> {
    await this.wechatBridge?.logout();
  }

  /** 给「最后一次说过话的那个会话」发一条测试消息，用来确认收发链路 */
  async testSend(kind: BotKind, text?: string): Promise<void> {
    const body = text?.trim() || "MoDuty 测试消息：如果你在手机上看到这条，说明机器人通路是好的。";
    const target = this.lastChat.get(kind);
    if (!target) {
      throw new Error("还没有人给这个机器人发过消息，先发一句「/status」再试");
    }
    if (kind === "feishu") {
      if (!this.feishuBridge) throw new Error("飞书桥未就绪");
      await this.feishuBridge.sendText(target.chatId, body, target.replyToMessageId);
    } else {
      if (!this.wechatBridge) throw new Error("微信桥未就绪");
      await this.wechatBridge.sendText(target.chatId, body, target.contextToken ?? "");
    }
  }
}

export const botManager = new BotManager();
