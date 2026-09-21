/**
 * 远程机器人配置（手机操控 MoDuty）。
 *
 * 落盘：`~/.momoka/bots.json`（与 settings.json 同目录，纯本机文件、不上传）。
 * 这里只负责「配置的读 / 写 / 校验 / 脱敏」；
 * 连接生命周期（长连接、长轮询、扫码登录）见 src/bot/manager.ts。
 *
 * 密钥策略：appSecret / botToken 明文存本机文件（MoDuty 没有 electron safeStorage 那层），
 * 但**任何 HTTP 响应都不返回明文**，只回 `hasSecret: true`——前端用「留空 = 不修改」约定编辑。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type BotKind = "feishu" | "wechat";

/** 飞书自建应用（机器人长连接） */
export interface FeishuBotSettings {
  enabled: boolean;
  appId: string;
  appSecret: string;
  /** feishu（国内版）| lark（国际版） */
  domain: "feishu" | "lark";
}

/** 微信 iLink Bot（扫码登录后拿到凭证） */
export interface WechatBotSettings {
  enabled: boolean;
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  /** 登录时服务端返回的 baseUrl（空则用默认 ilinkai.weixin.qq.com） */
  baseUrl: string;
  /** iLink 增量拉取游标，跨重启续传（避免重复收历史消息） */
  syncBuf: string;
  /** 扫码人昵称（仅展示用，iLink 目前不一定返回） */
  displayName?: string;
  loggedInAt?: number;
}

/** 裸文本（不带 / 命令）时的默认去处 */
export interface BotDefaultTarget {
  /** dispatcher = 交给值日生；session = 固定转发给某个会话 */
  kind: "dispatcher" | "session";
  sessionId?: string;
}

export interface BotsFile {
  version: 1;
  feishu: FeishuBotSettings;
  wechat: WechatBotSettings;
  defaultTarget: BotDefaultTarget;
}

/** HTTP 响应里的脱敏形态（永不返回 appSecret / botToken 明文） */
export interface PublicBotsConfig {
  feishu: { enabled: boolean; appId: string; domain: "feishu" | "lark"; hasSecret: boolean };
  wechat: {
    enabled: boolean;
    ilinkBotId: string;
    ilinkUserId: string;
    baseUrl: string;
    hasToken: boolean;
    displayName?: string;
    loggedInAt?: number;
  };
  defaultTarget: BotDefaultTarget;
}

const BOTS_DIR = path.join(os.homedir(), ".momoka");
const BOTS_PATH = path.join(BOTS_DIR, "bots.json");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function emptyConfig(): BotsFile {
  return {
    version: 1,
    feishu: { enabled: false, appId: "", appSecret: "", domain: "feishu" },
    wechat: {
      enabled: false,
      botToken: "",
      ilinkBotId: "",
      ilinkUserId: "",
      baseUrl: "",
      syncBuf: "",
    },
    defaultTarget: { kind: "dispatcher" },
  };
}

function normalize(raw: unknown): BotsFile {
  const base = emptyConfig();
  if (!raw || typeof raw !== "object") return base;
  const file = raw as Record<string, unknown>;

  const feishu = (file.feishu ?? {}) as Record<string, unknown>;
  base.feishu = {
    enabled: feishu.enabled === true,
    appId: text(feishu.appId),
    appSecret: typeof feishu.appSecret === "string" ? feishu.appSecret : "",
    domain: feishu.domain === "lark" ? "lark" : "feishu",
  };

  const wechat = (file.wechat ?? {}) as Record<string, unknown>;
  base.wechat = {
    enabled: wechat.enabled === true,
    botToken: typeof wechat.botToken === "string" ? wechat.botToken : "",
    ilinkBotId: text(wechat.ilinkBotId),
    ilinkUserId: text(wechat.ilinkUserId),
    baseUrl: text(wechat.baseUrl),
    syncBuf: typeof wechat.syncBuf === "string" ? wechat.syncBuf : "",
    ...(text(wechat.displayName) ? { displayName: text(wechat.displayName) } : {}),
    ...(typeof wechat.loggedInAt === "number" ? { loggedInAt: wechat.loggedInAt } : {}),
  };

  const target = (file.defaultTarget ?? {}) as Record<string, unknown>;
  const sessionId = text(target.sessionId);
  base.defaultTarget = {
    kind: target.kind === "session" && sessionId ? "session" : "dispatcher",
    ...(sessionId ? { sessionId } : {}),
  };
  return base;
}

export async function loadBotConfig(): Promise<BotsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(BOTS_PATH, "utf8"));
    return normalize(raw);
  } catch {
    return emptyConfig();
  }
}

/**
 * 合并保存（局部补丁语义）。
 * 密钥字段的特殊约定：`undefined` = 不动；空字符串 = 清除；非空 = 覆盖。
 * 前端的「留空不改」由调用方（路由）把空串转成 undefined 决定。
 */
export async function saveBotConfig(patch: {
  feishu?: Partial<FeishuBotSettings>;
  wechat?: Partial<WechatBotSettings>;
  defaultTarget?: Partial<BotDefaultTarget>;
}): Promise<BotsFile> {
  const current = await loadBotConfig();
  const next = normalize({
    ...current,
    feishu: { ...current.feishu, ...(patch.feishu ?? {}) },
    wechat: { ...current.wechat, ...(patch.wechat ?? {}) },
    defaultTarget: { ...current.defaultTarget, ...(patch.defaultTarget ?? {}) },
  });
  if (next.defaultTarget.kind === "session" && !next.defaultTarget.sessionId) {
    next.defaultTarget = { kind: "dispatcher" };
  }
  await fs.mkdir(BOTS_DIR, { recursive: true });
  await fs.writeFile(BOTS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function publicBotsConfig(config: BotsFile): PublicBotsConfig {
  return {
    feishu: {
      enabled: config.feishu.enabled,
      appId: config.feishu.appId,
      domain: config.feishu.domain,
      hasSecret: Boolean(config.feishu.appSecret),
    },
    wechat: {
      enabled: config.wechat.enabled,
      ilinkBotId: config.wechat.ilinkBotId,
      ilinkUserId: config.wechat.ilinkUserId,
      baseUrl: config.wechat.baseUrl,
      hasToken: Boolean(config.wechat.botToken),
      ...(config.wechat.displayName ? { displayName: config.wechat.displayName } : {}),
      ...(config.wechat.loggedInAt ? { loggedInAt: config.wechat.loggedInAt } : {}),
    },
    defaultTarget: config.defaultTarget,
  };
}

export const BOTS_CONFIG_PATH = BOTS_PATH;
