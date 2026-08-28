import type { IncomingMessage, ServerResponse } from "node:http";

import { saveSettings } from "../settings-store.js";
import { describeEnvProviderDiagnostics, fetchUpstreamModels, resolveModelConfig, UpstreamHttpError } from "../model-client.js";
import { json, readJsonBody, send } from "./http-utils.js";
import type { RouteContext } from "./route-context.js";

/**
 * 设置/诊断类路由：health、config、settings、models、sandbox、directories。
 * 这些是桌面端与遗留视图共用的基础设施，不属于任何一条业务轨道。
 *
 * 防腐边界：provider 探测（DashScope / OpenAI / Zen）与上游 models 拉取一律委托
 * model-client.ts 导出的辅助函数，本文件不出现 provider 细节。
 */
export async function handleSettingsRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/health") {
    send(response, 200, "MOMOKA OK", "text/plain; charset=utf-8");
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    const diagnostics = describeEnvProviderDiagnostics();
    json(response, 200, {
      info: {
        provider: diagnostics.provider,
        key_prefix: diagnostics.keyPrefix,
        model: diagnostics.model,
      },
      issues: diagnostics.issues,
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    const config = await resolveModelConfig();
    json(response, 200, {
      sandbox_enabled: ctx.agent.getSandboxEnabled(),
      apiKey_masked: config.apiKey ? `${config.apiKey.slice(0, 8)}...` : "",
      baseUrl: config.baseUrl,
      model: config.model,
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(request);
    const patch: { apiKey?: string; baseUrl?: string; model?: string } = {};
    if (typeof body.apiKey === "string") patch.apiKey = body.apiKey;
    if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl.replace(/\/+$/u, "");
    if (typeof body.model === "string") patch.model = body.model;
    await saveSettings(patch);
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/models") {
    const config = await resolveModelConfig();
    try {
      json(response, 200, { models: await fetchUpstreamModels(config.baseUrl, config.apiKey) });
    } catch (error) {
      const status = error instanceof UpstreamHttpError ? error.status : 502;
      json(response, status, { error: error instanceof Error ? error.message : String(error), models: [] });
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/settings/sandbox") {
    const body = await readJsonBody(request);
    await ctx.agent.setSandboxEnabled(Boolean(body.enabled));
    json(response, 200, { sandbox_enabled: ctx.agent.getSandboxEnabled() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/directories") {
    json(response, 200, await ctx.agent.listDirectories(url.searchParams.get("path") ?? ""));
    return true;
  }
  return false;
}
