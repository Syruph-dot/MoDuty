/**
 * 远程机器人路由（/api/bots）：手机操控 MoDuty 的配置与状态。
 *
 * 前端设置页「远程机器人」区块全部走这里：
 *   GET    /api/bots                     配置（脱敏）+ 状态 + 最近收发活动
 *   GET    /api/bots/status              只取状态（页面打开时轮询用）
 *   PUT    /api/bots/feishu              App ID / Secret / 域 / 启用
 *   PUT    /api/bots/wechat              启用开关
 *   PUT    /api/bots/target              裸文本默认去处（值日生 / 指定会话）
 *   POST   /api/bots/:kind/enable|disable|restart|test
 *   POST   /api/bots/wechat/login        开始扫码登录（返回二维码 data URL）
 *   GET    /api/bots/wechat/login        登录状态（含二维码）
 *   DELETE /api/bots/wechat/login        取消扫码
 *   POST   /api/bots/wechat/logout       退出登录（清凭证）
 *
 * 密钥永不回传：appSecret / botToken 只以 hasSecret / hasToken 表示；
 * 编辑时「留空 = 不修改」，要清除得显式传 clearSecret。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MomokaHttpError } from "../http-error.js";
import { BOTS_CONFIG_PATH, loadBotConfig, publicBotsConfig, saveBotConfig } from "../bot-config.js";
import { botManager } from "../bot/manager.js";
import { json, readJsonBody } from "./http-utils.js";

function botKindOf(value: string): "feishu" | "wechat" {
  if (value === "feishu" || value === "wechat") return value;
  throw new MomokaHttpError(400, `未知渠道：${value}（只支持 feishu / wechat）`);
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export async function handleBotRoutes(
  _ctx: unknown,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/bots")) return false;

  // 配置 + 状态
  if (request.method === "GET" && pathname === "/api/bots") {
    const config = await loadBotConfig();
    json(response, 200, {
      config: publicBotsConfig(config),
      statuses: botManager.statuses(),
      activity: botManager.activity,
      configPath: BOTS_CONFIG_PATH,
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/bots/status") {
    json(response, 200, { statuses: botManager.statuses(), activity: botManager.activity });
    return true;
  }

  // 飞书配置
  if (request.method === "PUT" && pathname === "/api/bots/feishu") {
    const body = await readJsonBody(request);
    const patch: {
      enabled?: boolean;
      appId?: string;
      appSecret?: string;
      domain?: "feishu" | "lark";
    } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.appId === "string") patch.appId = body.appId.trim();
    if (typeof body.domain === "string") patch.domain = body.domain === "lark" ? "lark" : "feishu";
    if (body.clearSecret === true) {
      patch.appSecret = "";
    } else if (typeof body.appSecret === "string" && body.appSecret.trim()) {
      patch.appSecret = body.appSecret.trim();
    }
    await saveBotConfig({ feishu: patch });
    await botManager.applyAll();
    const config = await loadBotConfig();
    json(response, 200, { config: publicBotsConfig(config), statuses: botManager.statuses() });
    return true;
  }

  // 微信配置（凭证只由扫码写入，这里只放开关）
  if (request.method === "PUT" && pathname === "/api/bots/wechat") {
    const body = await readJsonBody(request);
    const enabled = asBool(body.enabled);
    if (enabled === undefined) throw new MomokaHttpError(400, "缺少 enabled");
    await saveBotConfig({ wechat: { enabled } });
    await botManager.applyAll();
    const config = await loadBotConfig();
    json(response, 200, { config: publicBotsConfig(config), statuses: botManager.statuses() });
    return true;
  }

  // 裸文本默认去处
  if (request.method === "PUT" && pathname === "/api/bots/target") {
    const body = await readJsonBody(request);
    const kind = body.kind === "session" ? "session" : "dispatcher";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (kind === "session" && !sessionId) throw new MomokaHttpError(400, "选择会话时必须给 sessionId");
    const saved = await saveBotConfig({ defaultTarget: { kind, ...(sessionId ? { sessionId } : {}) } });
    await botManager.applyAll();
    json(response, 200, { config: publicBotsConfig(saved) });
    return true;
  }

  // 微信扫码登录
  if (pathname === "/api/bots/wechat/login") {
    if (request.method === "POST") {
      const result = await botManager.startWechatLogin();
      json(response, 200, { ...result, statuses: botManager.statuses() });
      return true;
    }
    if (request.method === "GET") {
      const status = botManager.status("wechat");
      json(response, 200, { status, statuses: botManager.statuses() });
      return true;
    }
    if (request.method === "DELETE") {
      botManager.cancelWechatLogin();
      json(response, 200, { status: botManager.status("wechat") });
      return true;
    }
  }

  if (request.method === "POST" && pathname === "/api/bots/wechat/logout") {
    await botManager.logoutWechat();
    const config = await loadBotConfig();
    json(response, 200, { config: publicBotsConfig(config), statuses: botManager.statuses() });
    return true;
  }

  // 渠道动作：enable / disable / restart / test
  const actionMatch = pathname.match(/^\/api\/bots\/([^/]+)\/(enable|disable|restart|test)$/);
  if (actionMatch && request.method === "POST") {
    const kind = botKindOf(decodeURIComponent(actionMatch[1] ?? ""));
    const action = actionMatch[2];
    if (action === "enable" || action === "disable") {
      await botManager.enable(kind, action === "enable");
      const config = await loadBotConfig();
      json(response, 200, { config: publicBotsConfig(config), statuses: botManager.statuses() });
      return true;
    }
    if (action === "restart") {
      await botManager.restart(kind);
      json(response, 200, { statuses: botManager.statuses() });
      return true;
    }
    const body = await readJsonBody(request);
    await botManager.testSend(kind, typeof body.text === "string" ? body.text : undefined);
    json(response, 200, { success: true, statuses: botManager.statuses() });
    return true;
  }

  json(response, 404, { error: "Not found" });
  return true;
}
