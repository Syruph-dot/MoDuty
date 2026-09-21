/**
 * 微信 iLink Bot 桥（扫码登录 + 长轮询收发）。
 *
 * 协议（与 Proma 的 wechat-bridge 同源，官方 iLink Bot API）：
 *   GET  /ilink/bot/get_bot_qrcode?bot_type=3      → { qrcode, qrcode_img_content(扫码 URL) }
 *   GET  /ilink/bot/get_qrcode_status?qrcode=<id>  → { status: wait|scaned|confirmed|expired,
 *                                                      bot_token, ilink_bot_id, ilink_user_id, baseurl }
 *   POST /ilink/bot/getupdates   { get_updates_buf, base_info:{channel_version} }  → { msgs, get_updates_buf }
 *   POST /ilink/bot/sendmessage  { msg:{ from_user_id, to_user_id, client_id, message_type:2,
 *                                        message_state:2, item_list:[{type:1,text_item:{text}}],
 *                                        context_token }, base_info:{} }
 *   请求头：AuthorizationType: ilink_bot_token / Authorization: Bearer <botToken> / X-WECHAT-UIN
 *
 * 只做文本：图片/文件/语音收到就回「暂不支持」，等真有人用再说（避免把 AES 解密那套搬进来）。
 */
import crypto from "node:crypto";
import QRCode from "qrcode";
import type { WechatBotSettings } from "../bot-config.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const LONG_POLL_TIMEOUT_MS = 45_000;
const SEND_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 3_000;
/** iLink 约定：会话过期错误码 */
const SESSION_EXPIRED_CODE = -14;

/** iLink 消息项类型 / 消息类型 / 消息状态（官方常量） */
const ITEM_TEXT = 1;
const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

export type WechatLoginStatus = "idle" | "waiting_scan" | "scanned" | "confirmed" | "expired" | "error";

export interface WechatIncoming {
  fromUserId: string;
  text: string;
  contextToken: string;
  /** 非文本消息（图片/文件…）时为 true，正文为空 */
  unsupportedMedia: boolean;
}

interface IlinkEnvelope {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

interface IlinkMessage extends IlinkEnvelope {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
}

interface GetUpdatesResponse extends IlinkEnvelope {
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
}

/** iLink 要求的 X-WECHAT-UIN：随机 4 字节小端整数 → 十进制字符串 → base64 */
function generateWechatUIN(): string {
  const buf = crypto.randomBytes(4);
  return Buffer.from(String(buf.readUInt32LE())).toString("base64");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WeChatBridgeDeps {
  getSettings: () => WechatBotSettings;
  saveSettings: (patch: Partial<WechatBotSettings>) => Promise<void>;
  /** 收到一条文本消息（桥不 await，交给上层排队） */
  onMessage: (input: WechatIncoming) => void;
  /** 状态变化（让上层广播 / 前端刷新） */
  onStatusChange: () => void;
  /** 登录成功（上层据此把 enabled 打开并启动长轮询） */
  onLoggedIn: () => void;
}

export class WeChatBridge {
  private client: { baseUrl: string; botToken: string; botId: string } | null = null;
  private polling = false;
  private stopping = false;
  private failures = 0;
  /** iLink 判定会话过期（errcode -14）：需重新扫码 */
  private expiredFlag = false;
  private readonly uin = generateWechatUIN();
  private readonly seenMessageIds = new Set<number>();
  private loginAbort: AbortController | null = null;

  readonly login: {
    status: WechatLoginStatus;
    qrDataUrl: string;
    scanUrl: string;
    error: string;
  } = { status: "idle", qrDataUrl: "", scanUrl: "", error: "" };

  constructor(private readonly deps: WeChatBridgeDeps) {}

  /** 长轮询是否在跑（连接状态以此为准） */
  get running(): boolean {
    return this.polling;
  }

  get lastError(): string {
    if (this.expiredFlag) return "登录已过期，请重新扫码";
    return this.failures >= 5 ? `连续 ${this.failures} 次拉取失败，仍在重试` : "";
  }

  get expired(): boolean {
    return this.expiredFlag;
  }

  connectedAt = 0;

  // ===== 生命周期 =====

  async start(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.botToken || !settings.ilinkBotId) {
      throw new Error("微信尚未扫码登录（先点「扫码登录」）");
    }
    this.client = {
      baseUrl: settings.baseUrl || DEFAULT_BASE_URL,
      botToken: settings.botToken,
      botId: settings.ilinkBotId,
    };
    this.stopping = false;
    this.failures = 0;
    this.expiredFlag = false;
    if (!this.polling) {
      this.polling = true;
      this.connectedAt = Date.now();
      void this.pollLoop();
    }
    this.deps.onStatusChange();
  }

  stop(): void {
    this.stopping = true;
    this.polling = false;
    this.client = null;
    this.deps.onStatusChange();
  }

  /** 退出登录：停轮询 + 清凭证 */
  async logout(): Promise<void> {
    this.stop();
    this.loginAbort?.abort();
    this.login.status = "idle";
    this.login.qrDataUrl = "";
    this.login.scanUrl = "";
    this.seenMessageIds.clear();
    await this.deps.saveSettings({
      botToken: "",
      ilinkBotId: "",
      ilinkUserId: "",
      syncBuf: "",
      enabled: false,
    });
    this.deps.onStatusChange();
  }

  // ===== 扫码登录 =====

  /** 取二维码并开始轮询状态（不阻塞：状态由 login 字段暴露给前端轮询） */
  async startLogin(): Promise<{ scanUrl: string; qrDataUrl: string }> {
    this.loginAbort?.abort();
    const abort = new AbortController();
    this.loginAbort = abort;
    const res = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      signal: abort.signal,
    }).catch((error: unknown) => {
      throw new Error(`获取二维码失败：${error instanceof Error ? error.message : String(error)}`);
    });
    if (!res.ok) throw new Error(`获取二维码失败：HTTP ${res.status}`);
    const data = (await res.json()) as { qrcode?: string; qrcode_img_content?: string };
    const qrcode = data.qrcode ?? "";
    const scanUrl = data.qrcode_img_content ?? "";
    if (!qrcode || !scanUrl) throw new Error("二维码响应缺少 qrcode / qrcode_img_content");
    const qrDataUrl = await QRCode.toDataURL(scanUrl, { width: 280, margin: 2 });
    this.login.status = "waiting_scan";
    this.login.qrDataUrl = qrDataUrl;
    this.login.scanUrl = scanUrl;
    this.login.error = "";
    this.deps.onStatusChange();
    void this.pollLogin(qrcode, abort.signal);
    return { scanUrl, qrDataUrl };
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.login.status = "idle";
    this.login.qrDataUrl = "";
    this.login.scanUrl = "";
    this.login.error = "";
    this.deps.onStatusChange();
  }

  private async pollLogin(qrcode: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await fetch(
          `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]) },
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          status?: string;
          bot_token?: string;
          ilink_bot_id?: string;
          ilink_user_id?: string;
          baseurl?: string;
        };
        const status = data.status ?? "wait";
        if (status === "scaned") {
          if (this.login.status !== "scanned") {
            this.login.status = "scanned";
            this.deps.onStatusChange();
          }
          continue;
        }
        if (status === "expired") {
          this.login.status = "expired";
          this.login.qrDataUrl = "";
          this.login.error = "二维码已过期，请重新获取";
          this.deps.onStatusChange();
          return;
        }
        if (status === "confirmed") {
          if (!data.bot_token || !data.ilink_bot_id) {
            this.login.status = "error";
            this.login.error = "扫码成功但未拿到有效凭证";
            this.deps.onStatusChange();
            return;
          }
          await this.deps.saveSettings({
            botToken: data.bot_token,
            ilinkBotId: data.ilink_bot_id,
            ilinkUserId: data.ilink_user_id ?? "",
            baseUrl: data.baseurl ?? "",
            syncBuf: "",
            loggedInAt: Date.now(),
            enabled: true,
          });
          this.login.status = "confirmed";
          this.login.qrDataUrl = "";
          this.login.error = "";
          this.deps.onStatusChange();
          this.deps.onLoggedIn();
          return;
        }
        // wait / 其它：继续轮询
      } catch (error) {
        if (signal.aborted) return;
        // 40s 超时是正常的（服务端按住连接），继续轮询
        if (error instanceof Error && error.name === "TimeoutError") continue;
      }
    }
  }

  // ===== 收发 =====

  private async post<T>(
    pathname: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const client = this.client;
    if (!client) throw new Error("微信桥未启动");
    const res = await fetch(`${client.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${client.botToken}`,
        "X-WECHAT-UIN": this.uin,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async sendText(toUserId: string, text: string, contextToken: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("微信桥未启动");
    const res = await this.post<{ ret?: number; errmsg?: string }>(
      "/ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: client.botId,
          to_user_id: toUserId,
          client_id: `moduty_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{ type: ITEM_TEXT, text_item: { text } }],
          context_token: contextToken,
        },
        base_info: {},
      },
      SEND_TIMEOUT_MS,
    );
    if (typeof res.ret === "number" && res.ret !== 0) {
      throw new Error(`发送失败：${res.errmsg ?? `ret=${res.ret}`}`);
    }
  }

  /** 「正在输入…」状态：失败无所谓，只为体感 */
  async sendTyping(userId: string, contextToken: string, status: 1 | 0): Promise<void> {
    try {
      const cfg = await this.post<{ typing_ticket?: string }>(
        "/ilink/bot/getconfig",
        { ilink_user_id: userId, context_token: contextToken, base_info: {} },
        10_000,
      );
      if (!cfg.typing_ticket) return;
      await this.post(
        "/ilink/bot/sendtyping",
        {
          ilink_user_id: userId,
          typing_ticket: cfg.typing_ticket,
          status,
          base_info: {},
        },
        10_000,
      );
    } catch {
      // 输入态是尽力而为
    }
  }

  private handleIncoming(msg: IlinkMessage): void {
    if (msg.message_type !== MSG_TYPE_USER || msg.message_state !== MSG_STATE_FINISH) return;
    const fromUserId = msg.from_user_id ?? "";
    if (!fromUserId || fromUserId === this.client?.botId) return;
    if (typeof msg.message_id === "number") {
      if (this.seenMessageIds.has(msg.message_id)) return;
      this.seenMessageIds.add(msg.message_id);
      if (this.seenMessageIds.size > 500) {
        // 简单上限：清掉一半（不需要严格 LRU，重复投递会重新入队也安全）
        const keep = [...this.seenMessageIds].slice(-250);
        this.seenMessageIds.clear();
        for (const id of keep) this.seenMessageIds.add(id);
      }
    }
    const items = msg.item_list ?? [];
    const text = items
      .filter((item) => item.type === ITEM_TEXT && item.text_item?.text)
      .map((item) => item.text_item?.text ?? "")
      .join("")
      .trim();
    const hasMedia = items.some((item) => item.type !== ITEM_TEXT);
    if (!text && !hasMedia) return;
    this.deps.onMessage({
      fromUserId,
      text,
      contextToken: msg.context_token ?? "",
      unsupportedMedia: !text && hasMedia,
    });
  }

  private async pollLoop(): Promise<void> {
    let buf = this.deps.getSettings().syncBuf ?? "";
    while (!this.stopping) {
      try {
        const res = await this.post<GetUpdatesResponse>(
          "/ilink/bot/getupdates",
          { get_updates_buf: buf, base_info: { channel_version: "1.0.0" } },
          LONG_POLL_TIMEOUT_MS,
        );
        if (res.errcode === SESSION_EXPIRED_CODE) {
          this.expiredFlag = true;
          this.polling = false;
          console.warn("[微信桥] 会话已过期，需重新扫码");
          this.deps.onStatusChange();
          return;
        }
        this.failures = 0;
        if (typeof res.get_updates_buf === "string" && res.get_updates_buf) {
          buf = res.get_updates_buf;
          await this.deps.saveSettings({ syncBuf: buf });
        }
        for (const msg of res.msgs ?? []) this.handleIncoming(msg);
      } catch (error) {
        if (this.stopping) return;
        this.failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (this.failures === 1 || this.failures % 5 === 0) {
          console.warn(`[微信桥] 拉取失败（第 ${this.failures} 次）：${message}`);
        }
        this.deps.onStatusChange();
        const backoff = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(this.failures, 5));
        await sleep(backoff);
      }
    }
  }
}
