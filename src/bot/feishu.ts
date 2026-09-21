/**
 * 飞书长连接桥（WSClient + EventDispatcher）。
 *
 * 为什么是长连接：飞书开放平台的事件订阅默认要填公网回调 URL，手机操控这种「个人自用」场景
 * 没有公网入口；长连接（WSClient）由 SDK 主动连飞书网关，本机即可收事件，不需要任何端口映射。
 *
 * 与 Proma 的差异：Proma 用较新的 `lark.createLarkChannel`（带卡片回调 / 群聊策略那套抽象），
 * 这里只做文本收发，用公开稳定的 `WSClient` + `EventDispatcher` + `Client` 三个原语。
 *
 * 使用前提（写进设置页提示）：飞书开放平台自建应用 → 开启「机器人」能力 →
 * 订阅方式选「长连接」→ 事件 `im.message.receive_v1` → 权限 `im:message`（接收与发送单聊/群聊消息）。
 */
import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuBotSettings } from "../bot-config.js";

export interface FeishuIncoming {
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  text: string;
}

export interface FeishuBridgeDeps {
  getSettings: () => FeishuBotSettings;
  onMessage: (input: FeishuIncoming) => void;
  onStatusChange: () => void;
}

/** 飞书事件里我们真正用到的字段（其余忽略；上游是 any，这里收窄成自己的类型） */
interface FeishuMessageEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
  };
}

export class FeishuBridge {
  private wsClient: lark.WSClient | null = null;
  private client: lark.Client | null = null;
  private startedAt = 0;
  private errorMessage = "";
  private ready = false;
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly deps: FeishuBridgeDeps) {}

  get connected(): boolean {
    return this.ready;
  }

  get lastError(): string {
    return this.errorMessage;
  }

  connectedAt(): number {
    return this.ready ? this.startedAt : 0;
  }

  async start(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.appId || !settings.appSecret) {
      throw new Error("请先填 App ID 与 App Secret");
    }
    const domain = settings.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.errorMessage = "";
    this.ready = false;

    this.client = new lark.Client({
      appId: settings.appId,
      appSecret: settings.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
    });

    this.wsClient = new lark.WSClient({
      appId: settings.appId,
      appSecret: settings.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
      onReady: () => {
        this.ready = true;
        this.startedAt = Date.now();
        this.errorMessage = "";
        console.log("[飞书桥] 长连接就绪");
        this.deps.onStatusChange();
      },
      onError: (error: Error) => {
        this.ready = false;
        this.errorMessage = error?.message ?? String(error);
        console.warn(`[飞书桥] 连接错误：${this.errorMessage}`);
        this.deps.onStatusChange();
      },
      onReconnecting: () => {
        this.ready = false;
        this.deps.onStatusChange();
      },
      onReconnected: () => {
        this.ready = true;
        this.startedAt = Date.now();
        this.deps.onStatusChange();
      },
    });

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      "im.message.receive_v1": async (event: unknown) => {
        try {
          this.handleEvent(event as FeishuMessageEvent);
        } catch (error) {
          console.warn(`[飞书桥] 处理消息异常：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  stop(): void {
    try {
      this.wsClient?.close({ force: true });
    } catch {
      // 关闭失败无所谓
    }
    this.wsClient = null;
    this.client = null;
    this.ready = false;
    this.deps.onStatusChange();
  }

  /** 回一条纯文本（优先 reply 到原消息，保持话题） */
  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("飞书桥未启动");
    const content = JSON.stringify({ text });
    if (replyToMessageId) {
      await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: "text", content },
      });
      return;
    }
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content },
    });
  }

  private handleEvent(event: FeishuMessageEvent): void {
    const message = event.message ?? {};
    const sender = event.sender ?? {};
    // 机器人自己发的不再处理（避免回环）
    if (sender.sender_type === "app") return;
    const messageId = message.message_id ?? "";
    if (!messageId) return;
    if (this.seenMessageIds.has(messageId)) return;
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 500) {
      const keep = [...this.seenMessageIds].slice(-250);
      this.seenMessageIds.clear();
      for (const id of keep) this.seenMessageIds.add(id);
    }
    const chatId = message.chat_id ?? "";
    const chatType: "p2p" | "group" = message.chat_type === "group" ? "group" : "p2p";
    if (!chatId) return;

    // 只处理文本；其它类型回一句说明（避免用户以为机器人坏了）
    if (message.message_type !== "text") {
      void this.sendText(chatId, "目前只支持文字消息（图片/文件先不在手机上处理）", messageId).catch(() => undefined);
      return;
    }

    let text = "";
    try {
      const parsed = JSON.parse(message.content ?? "{}") as { text?: string };
      text = parsed.text ?? "";
    } catch {
      text = "";
    }
    // 群聊里 @机器人 会留下 @_user_N 占位符；没有 @ 的群消息不理会（否则整群刷屏）
    const mentions = message.mentions ?? [];
    text = text.replace(/@_user_\d+/g, "").trim();
    if (chatType === "group" && mentions.length === 0) return;
    if (!text) return;

    this.deps.onMessage({ chatId, chatType, messageId, text });
  }
}
