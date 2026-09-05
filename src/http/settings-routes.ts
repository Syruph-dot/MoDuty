import type { IncomingMessage, ServerResponse } from "node:http";

import { loadSettings, saveSettings, type ModelPoolEntry, type TierDefaults } from "../settings-store.js";
import { describeEnvProviderDiagnostics, fetchUpstreamModels, resolveModelConfig, UpstreamHttpError } from "../model-client.js";
import { json, readJsonBody, send } from "./http-utils.js";
import type { RouteContext } from "./route-context.js";

/**
 * 设置/诊断类路由：health、config、settings、models、sandbox、directories。
 * 这些是桌面端与遗留视图共用的基础设施，不属于任何一条业务轨道。
 *
 * 防腐边界：provider 探测（OpenAI / Zen）与上游 models 拉取一律委托
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
    const diagnostics = await describeEnvProviderDiagnostics();
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
    // v2：返回模型池 + tier 默认指针（本地单用户配置，apiKey 与磁盘文件一致直接可编辑）
    const settings = await loadSettings();
    json(response, 200, {
      sandbox_enabled: ctx.agent.getSandboxEnabled(),
      modelPool: settings.modelPool,
      tierDefaults: settings.tierDefaults,
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(request) as {
      modelPool?: ModelPoolEntry[];
      tierDefaults?: Partial<TierDefaults>;
      // v1 兼容：不再支持单组写入，收到时给出指引
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
    if (body.apiKey !== undefined || body.baseUrl !== undefined || body.model !== undefined) {
      json(response, 400, {
        error: "旧版单组设置已由“模型池”取代：请使用 { modelPool, tierDefaults } 保存，或删除 ~/.momoka/settings.json 后重新在设置页配置",
      });
      return true;
    }
    const patch: { modelPool?: ModelPoolEntry[]; tierDefaults?: Partial<TierDefaults> } = {};
    if (Array.isArray(body.modelPool)) {
      patch.modelPool = body.modelPool.map((item) => ({ ...item, baseUrl: item.baseUrl?.trim() ?? "", model: item.model?.trim() ?? "" }));
    }
    if (body.tierDefaults && typeof body.tierDefaults === "object") {
      patch.tierDefaults = {};
      for (const key of ["high", "low", "exact"] as const) {
        if (key in body.tierDefaults) {
          const value = body.tierDefaults[key];
          patch.tierDefaults[key] = typeof value === "string" && value.trim() ? value.trim() : null;
        }
      }
    }
    await saveSettings(patch);
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/models") {
    // 支持用当前表单未保存的 Base URL / API Key 覆盖拉取（?base_url=&api_key=），
    // 便于用户在设置页粘贴新配置后直接验证；缺省回落已保存配置。
    const config = await resolveModelConfig({
      baseUrl: url.searchParams.get("base_url") ?? undefined,
      apiKey: url.searchParams.get("api_key") ?? undefined,
    });
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
