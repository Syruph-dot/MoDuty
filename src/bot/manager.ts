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
  type BotLastChat,
  type BotsFile,
  type FeishuBotSettings,
  type WechatBotSettings,
} from "../bot-config.js";
import { classifyBotCommand, runBotCommand } from "./command.js";
import { splitReplyForDelivery } from "./reply-format.js";
import { FeishuBridge } from "./feishu.js";
import { WeChatBridge, type WechatLoginStatus } from "./wechat.js";
import type { QuestionAnswer, QuestionItem } from "../question-store.js";

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

/**
 * 手机端的「待答问题」镜像。
 *
 * Agent 的 ask_question 只会生成桌面卡片（question-store → 前端渲染），手机上既看不到选项也无法点选。
 * 这里把它降级成一套纯文本协议：编号选项发出去、用户回数字（或选项文字）作答、全部答完再回填 answer 接口。
 */
interface PendingAsk {
  agentId: string;
  setId: string;
  questions: QuestionItem[];
  /** 已作答的题：questionIndex → 答案 */
  answered: Map<number, QuestionAnswer>;
  askedAt: number;
}

/** 待答问题有效期：超过就当作老师已经不要这件事了，不再拦截消息 */
const ASK_TTL_MS = 24 * 60 * 60 * 1000;

function selfBaseUrl(): string {
  return process.env.MOMOKA_URL ?? `http://127.0.0.1:${process.env.PORT ?? 7238}`;
}

async function getJson<T>(pathname: string): Promise<T | null> {
  try {
    const res = await fetch(`${selfBaseUrl()}${pathname}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(pathname: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${selfBaseUrl()}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 一道题在手机上的样子：题干 + 编号选项 */
function formatQuestion(index: number, question: QuestionItem): string {
  const options = question.options.map((option, i) => `  ${i + 1}) ${option}`).join("\n");
  return `Q${index + 1}: ${question.prompt}\n${options}`;
}

/**
 * 把手机上的一句话解析成某一题的答案：先认序号（1/2/3、第2题、2. 都算），
 * 再认选项原文，最后认「选项与这句话互相包含」（老师常常只打关键词）。
 * 都不是则返回 null——调用方应当把它当新指令处理，不能吞掉消息。
 */
function matchAnswer(question: QuestionItem, index: number, text: string): QuestionAnswer | null {
  const raw = text.trim();
  if (!raw) return null;
  const numbered = raw.match(/^(?:第\s*)?(\d{1,2})\s*(?:题|项|个)?[.、)）:：]?$/u);
  if (numbered) {
    const n = Number(numbered[1]);
    return n >= 1 && n <= question.options.length ? { questionIndex: index, choiceIndex: n - 1 } : null;
  }
  const exact = question.options.findIndex((option) => option.trim() === raw);
  if (exact >= 0) return { questionIndex: index, choiceIndex: exact };
  if (raw.length >= 2) {
    const loose = question.options.findIndex((option) => option.includes(raw) || raw.includes(option.trim()));
    if (loose >= 0) return { questionIndex: index, choiceIndex: loose };
  }
  return null;
}

interface PendingQuestionSet {
  id: string;
  agentId: string;
  questions: QuestionItem[];
}

/**
 * 找出当前「待老师拍板」的提问。
 *
 * 手机侧不知道这一轮落在哪个 Agent 上（裸文本交给默认目标、/agent 交给指定 Agent），
 * 所以直接问列表里谁处于 requiring_input——那正是 ask_question 之后的挂起态。
 */
async function findPendingQuestionSet(): Promise<PendingQuestionSet | null> {
  const data = await getJson<{ agents?: Array<{ id: string; state?: string; last_active_at?: string }> }>("/api/agents");
  const waiting = (data?.agents ?? []).filter((agent) => agent.state === "requiring_input");
  waiting.sort((a, b) => String(b.last_active_at ?? "").localeCompare(String(a.last_active_at ?? "")));
  for (const agent of waiting.slice(0, 3)) {
    const sets = await getJson<{ questions?: Array<{ id: string; agentId?: string; questions: QuestionItem[] }> }>(
      `/api/agents/${encodeURIComponent(agent.id)}/questions`,
    );
    const set = (sets?.questions ?? [])[0];
    if (set && Array.isArray(set.questions) && set.questions.length > 0) {
      return { id: set.id, agentId: agent.id, questions: set.questions };
    }
  }
  return null;
}

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
  /** 手机端待答问题：`<kind>:<chatId>` → 最近一次桌面提问的镜像 */
  private readonly pendingAsk = new Map<string, PendingAsk>();
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
    this.restoreLastChat(config);

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
        this.rememberLastChat("feishu", { chatId: input.chatId, replyToMessageId: input.messageId });
        this.noteInbound(input.text);
        this.enqueue(`feishu:${input.chatId}`, () =>
          this.runPipeline("feishu", input.chatId, input.text, async (text) => {
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
        this.rememberLastChat("wechat", { chatId: input.fromUserId, contextToken: input.contextToken });
        this.noteInbound(input.unsupportedMedia ? "(非文本消息)" : input.text);
        this.enqueue(`wechat:${input.fromUserId}`, () =>
          this.runPipeline(
            "wechat",
            input.fromUserId,
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

  /** 一条消息的完整处理：先看是不是在答上一个问题 → 即时反馈 → 执行 CLI → 回正文 → 把新提问搬到手机 */
  private async runPipeline(
    kind: BotKind,
    chatId: string,
    text: string,
    reply: (text: string) => Promise<void>,
    typing?: (on: boolean) => Promise<void>,
    mediaOnly = false,
  ): Promise<void> {
    if (mediaOnly) {
      await this.safeReply(reply, "目前只支持文字消息（图片/文件先不在手机上处理）");
      return;
    }
    const askKey = `${kind}:${chatId}`;
    // 手机上作答只能靠「回一句话」，所以入站消息要先问一句：这是不是在答上一个问题？
    if (await this.tryAnswerPending(askKey, text, reply)) return;

    const quick = classifyBotCommand(text) === "quick";
    try {
      if (!quick) {
        await this.safeReply(reply, "收到，处理中…");
        void typing?.(true);
      }
      const result = await runBotCommand({ text, defaultTarget: this.defaultTarget });
      void typing?.(false);
      await this.safeReply(reply, result.text);
      // Agent 这一轮如果抛出了问题，把它从「桌面卡片」降级成手机能读能答的文本
      await this.surfacePendingAsk(askKey, reply);
    } catch (error) {
      void typing?.(false);
      const message = error instanceof Error ? error.message : String(error);
      await this.safeReply(reply, `出错了：${message}`);
    }
  }

  /**
   * 这条消息是不是在回答上一次提问？是则记下答案并返回 true（不再当新指令跑）。
   * 不像答案就返回 false，让消息照原路走——宁可问题多挂一会儿，也不能把老师的新任务吞掉。
   */
  private async tryAnswerPending(
    askKey: string,
    text: string,
    reply: (text: string) => Promise<void>,
  ): Promise<boolean> {
    const pending = this.pendingAsk.get(askKey);
    if (!pending) return false;
    if (Date.now() - pending.askedAt > ASK_TTL_MS) {
      this.pendingAsk.delete(askKey);
      return false;
    }
    const index = pending.questions.findIndex((_, i) => !pending.answered.has(i));
    if (index < 0) {
      this.pendingAsk.delete(askKey);
      return false;
    }
    const answer = matchAnswer(pending.questions[index], index, text);
    if (!answer) return false;
    pending.answered.set(index, answer);

    const rest = pending.questions.findIndex((_, i) => !pending.answered.has(i));
    if (rest >= 0) {
      await this.safeReply(
        reply,
        `收到（第 ${index + 1} 题）。还有一题要你定：\n${formatQuestion(rest, pending.questions[rest])}`,
      );
      return true;
    }

    const answers = pending.questions
      .map((_, i) => pending.answered.get(i))
      .filter((item): item is QuestionAnswer => Boolean(item));
    this.pendingAsk.delete(askKey);
    const submitted = await postJson<{ autoDispatched?: boolean; dispatchId?: string }>(
      `/api/agents/${encodeURIComponent(pending.agentId)}/questions/${encodeURIComponent(pending.setId)}/answer`,
      { answers },
    );
    if (!submitted) {
      await this.safeReply(reply, "作答没提交成功（服务端没认），可以再说一次。");
      return true;
    }
    await this.safeReply(
      reply,
      submitted.autoDispatched
        ? `已按你的选择派发（台账 ${submitted.dispatchId ?? "?"}），完成/出错会通知你。`
        : "已收到你的作答，值日生继续处理中。",
    );
    return true;
  }

  /** 跑完一轮后把待答问题镜像到手机：有则记进待答表并发出编号选项 */
  private async surfacePendingAsk(askKey: string, reply: (text: string) => Promise<void>): Promise<void> {
    if (this.pendingAsk.has(askKey)) return;
    const found = await findPendingQuestionSet();
    if (!found) return;
    this.pendingAsk.set(askKey, {
      agentId: found.agentId,
      setId: found.id,
      questions: found.questions,
      answered: new Map(),
      askedAt: Date.now(),
    });
    const lines = ["【需要你定一下】"];
    found.questions.forEach((question, index) => lines.push(formatQuestion(index, question)));
    lines.push("回复序号即可（也可以直接回选项文字）。");
    await this.safeReply(reply, lines.join("\n"));
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

  /**
   * 主动推送：给「最后一次说过话的那个会话」发文本（交付通知这类没有入站消息触发的场景）。
   * 没有任何会话记录时静默跳过——还不知道该发给谁是正常状态，不该报错。
   */
  /** 记住「这个渠道最后跟谁说过话」并落盘：交付通知这类主动推送的收件人，重启也不能丢 */
  private rememberLastChat(
    kind: BotKind,
    value: { chatId: string; replyToMessageId?: string; contextToken?: string },
  ): void {
    this.lastChat.set(kind, value);
    void saveBotConfig({ lastChat: this.lastChatSnapshot() }).catch(() => undefined);
  }

  /** 把上次对话位置从配置恢复（重启后主动推送不至于失忆） */
  private restoreLastChat(config: BotsFile): void {
    for (const kind of ["feishu", "wechat"] as const) {
      const saved = config.lastChat?.[kind];
      if (saved?.chatId && !this.lastChat.has(kind)) this.lastChat.set(kind, saved);
    }
  }

  private lastChatSnapshot(): { feishu?: BotLastChat; wechat?: BotLastChat } {
    const snapshot: { feishu?: BotLastChat; wechat?: BotLastChat } = {};
    for (const [kind, value] of this.lastChat) {
      snapshot[kind] = value;
    }
    return snapshot;
  }

  async notify(text: string): Promise<void> {
    const body = (text ?? "").trim();
    if (!body) return;
    // 与 safeReply 同一口径：一条回应拆成多条消息发完，绝不截断（长报告在手机上也要能读全）
    const parts = splitReplyForDelivery(body);
    for (const kind of ["feishu", "wechat"] as const) {
      const target = this.lastChat.get(kind);
      if (!target) continue;
      try {
        for (const [index, part] of parts.entries()) {
          if (kind === "feishu") {
            if (!this.feishuBridge?.connected) break;
            await this.feishuBridge.sendText(target.chatId, part, target.replyToMessageId);
          } else {
            if (!this.wechatBridge?.running) break;
            await this.wechatBridge.sendText(target.chatId, part, target.contextToken ?? "");
          }
          this.activity.lastOutboundAt = Date.now();
          if (index < parts.length - 1) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (error) {
        console.warn(`[机器人] 主动推送失败（${kind}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export const botManager = new BotManager();
