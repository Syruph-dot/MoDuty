import type { Agent, BrowserInfo, QuestionSetView } from "../types";

/**
 * API base 解析（异步）：
 * - 优先级：
 *   1) VITE_MOMOKA_API 显式覆盖（构建期注入）—— 同步值，立即返回
 *   2) Tauri webview → 调用 Rust 命令 get_momoka_port 拿真实端口，拼出 http://127.0.0.1:{port}
 *      （后端 sidecar 启动时端口会从 8888 起递增找空位）
 *   3) 浏览器 dev → 空串（走 Vite dev proxy /api → :8888）
 *
 * 结果按 Promise 缓存：整个应用生命周期只解析一次。
 */
let _apiBasePromise: Promise<string> | null = null;

function readEnvBase(): string | undefined {
  if (typeof import.meta === "undefined") return undefined;
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  const value = env?.VITE_MOMOKA_API;
  return value ? String(value) : undefined;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

function inMomokaShell(): boolean {
  return typeof window !== "undefined" && "__MOMOKA_SHELL__" in window;
}

export function awaitApiBase(): Promise<string> {
  if (_apiBasePromise) return _apiBasePromise;
  _apiBasePromise = (async () => {
    const envBase = readEnvBase();
    if (envBase) return envBase;
    if (inTauri()) {
      // 动态 import：避免 vite 浏览器构建时拉 @tauri-apps/api 失败
      try {
        const { invoke } = await import("@tauri-apps/api/tauri");
        const port = await invoke<number>("get_momoka_port");
        return `http://127.0.0.1:${port}`;
      } catch (err) {
        // 端口读取失败（后端还没起来）时重试：让上层业务去 retry，不要在这里阻塞
        console.error("[api] failed to resolve momoka port from Tauri:", err);
        throw err;
      }
    }
    if (inMomokaShell()) {
      // momoka-shell (WebKitGTK) 固定连 8888
      return "http://127.0.0.1:8888";
    }
    return ""; // 浏览器 dev：Vite dev proxy
  })();
  return _apiBasePromise;
}

/** 测试注入：强制固定 API base（供 node:test 直接打到临时后端）。仅测试使用，生产代码不要调。 */
export function setApiBaseForTests(base: string): void {
  _apiBasePromise = Promise.resolve(base);
}

/** 已弃用的同步兜底值：仅用于日志/UI 提示；不要用于实际 fetch。 */
export const apiBaseHint = (() => {
  if (readEnvBase()) return readEnvBase();
  if (inTauri()) return "tauri://(await port)";
  return "(vite dev proxy)";
})();

async function jsonOrThrow(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

export async function listAgents(): Promise<Agent[]> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(await fetch(`${base}/api/agents`), "GET /api/agents")) as { agents: Agent[] };
  return data.agents;
}

export async function createAgent(input: { name: string; workspace_dir?: string; model?: string }): Promise<Agent> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    "POST /api/agents",
  )) as { agent: Agent };
  return data.agent;
}

export async function deleteAgent(id: string): Promise<void> {
  const base = await awaitApiBase();
  await jsonOrThrow(await fetch(`${base}/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }), "DELETE /api/agents/:id");
}

/**
 * 桌面问答：拉取某 Agent 的问题集。
 * - 缺省只回待答（值日生页「待老师拍板」用）；
 * - includeAnswered=true 额外带回最近已答集合（含 answers），供会话里的问答卡回看题目与作答。
 */
export async function fetchAgentQuestions(
  agentId: string,
  options?: { includeAnswered?: boolean; answeredLimit?: number },
): Promise<QuestionSetView[]> {
  const base = await awaitApiBase();
  const params = new URLSearchParams();
  if (options?.includeAnswered) params.set("include", "answered");
  if (options?.answeredLimit) params.set("answeredLimit", String(options.answeredLimit));
  const query = params.toString();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/questions${query ? `?${query}` : ""}`),
    "GET /api/agents/:id/questions",
  )) as { questions: QuestionSetView[] };
  return data.questions ?? [];
}

/** 桌面问答：提交答案（answers 按问题下标逐题作答；choiceIndex=-1 表示自定义文本） */
export async function submitQuestionAnswers(
  agentId: string,
  setId: string,
  answers: Array<{ questionIndex: number; choiceIndex: number; customText?: string }>,
): Promise<void> {
  const base = await awaitApiBase();
  await jsonOrThrow(
    await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/questions/${encodeURIComponent(setId)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    }),
    "POST /api/agents/:id/questions/:qid/answer",
  );
}

/**
 * 显式取消该 agent 正在进行的 chat 流（停止按钮）。返回是否命中活跃流。
 * 任务被中止后，会话里对应的流式消息会标记为 stopped。
 */
export async function cancelAgentChat(agentId: string): Promise<boolean> {
  try {
    const base = await awaitApiBase();
    const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/chat/cancel`, { method: "POST" });
    if (!res.ok) return false;
    const data = (await res.json()) as { cancelled?: boolean };
    return Boolean(data.cancelled);
  } catch {
    return false; // 后端不可达时静默：前端已本地 abort，连接会随 fetch 取消而释放
  }
}

/**
 * 显式复位非运行态（窗口"重试"第一步）：error / waiting_approval / completed → idle。
 * running 时后端忽略（返回 success），前端不依赖返回值。
 */
export async function resetAgentChat(agentId: string): Promise<boolean> {
  try {
    const base = await awaitApiBase();
    const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/chat/reset`, { method: "POST" });
    if (!res.ok) return false;
    return true;
  } catch {
    return false;
  }
}

export async function renameAgent(id: string, name: string): Promise<Agent> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    "PUT /api/agents/:id",
  )) as { agent: Agent };
  return data.agent;
}

export interface ModelPoolEntryView {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  enabled: boolean;
}

export interface TierDefaultsView {
  high: string | null;
  low: string | null;
  exact: string | null;
}

export interface MomokaSettingsView {
  sandbox_enabled: boolean;
  modelPool: ModelPoolEntryView[];
  tierDefaults: TierDefaultsView;
  agent_persona?: string;
}

/** 读取当前设置（v2：模型池 + 默认指针 + 默认人格） */
export async function fetchSettings(): Promise<MomokaSettingsView> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/settings`),
    "GET /api/settings",
  )) as MomokaSettingsView;
  return data;
}

/** 保存设置（v2：整表保存模型池 / 默认指针 / 默认人格） */
export async function updateSettings(input: {
  modelPool?: ModelPoolEntryView[];
  tierDefaults?: Partial<TierDefaultsView>;
  agent_persona?: string | null;
}): Promise<void> {
  const base = await awaitApiBase();
  await jsonOrThrow(
    await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    "POST /api/settings",
  );
}

/** 切换沙箱模式（运行时工具执行约束） */
export async function updateSandbox(enabled: boolean): Promise<boolean> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/settings/sandbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
    "POST /api/settings/sandbox",
  )) as { sandbox_enabled: boolean };
  return data.sandbox_enabled;
}

export interface ShellVerbKeyStatusView {
  registered: boolean;
  command: string | null;
}

export interface ShellVerbStatusView {
  supported: boolean;
  registered: boolean;
  partial: boolean;
  keys: {
    file: ShellVerbKeyStatusView;
    directory: ShellVerbKeyStatusView;
    background: ShellVerbKeyStatusView;
  };
  script_exists: boolean;
  launcher_exists: boolean;
  bridge_exists: boolean;
  detail?: string;
}

/** 读取资源管理器右键菜单（Shell Verb）注册状态 */
export async function fetchShellVerbStatus(): Promise<ShellVerbStatusView> {
  const base = await awaitApiBase();
  return (await jsonOrThrow(
    await fetch(`${base}/api/settings/shell-verb`),
    "GET /api/settings/shell-verb",
  )) as ShellVerbStatusView;
}

/** 注册 / 注销资源管理器右键菜单，返回操作后的最新状态 */
export async function updateShellVerb(action: "register" | "unregister"): Promise<ShellVerbStatusView> {
  const base = await awaitApiBase();
  return (await jsonOrThrow(
    await fetch(`${base}/api/settings/shell-verb`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
    "POST /api/settings/shell-verb",
  )) as ShellVerbStatusView;
}

/** 按当前 Base URL + Key 从官方拉取模型列表；overrides 用当前表单未保存的新值覆盖（走后端代理，避免 webview CORS） */
export async function fetchModels(overrides?: { baseUrl?: string; apiKey?: string }): Promise<string[]> {
  const base = await awaitApiBase();
  const params = new URLSearchParams();
  if (overrides?.baseUrl?.trim()) params.set("base_url", overrides.baseUrl.trim());
  if (overrides?.apiKey?.trim()) params.set("api_key", overrides.apiKey.trim());
  const qs = params.toString();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/models${qs ? `?${qs}` : ""}`),
    "GET /api/models",
  )) as { models: string[] };
  return data.models ?? [];
}

/* ============================================================
 * 受控浏览器 API
 * ============================================================ */

export async function listBrowsers(): Promise<BrowserInfo[]> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(await fetch(`${base}/api/browsers`), "GET /api/browsers")) as { browsers: BrowserInfo[] };
  return data.browsers;
}

export async function createBrowser(input: { name?: string; mode?: "persistent" | "incognito" }): Promise<BrowserInfo> {
  const base = await awaitApiBase();
  const data = (await jsonOrThrow(
    await fetch(`${base}/api/browsers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    "POST /api/browsers",
  )) as { browser: BrowserInfo };
  return data.browser;
}

export async function deleteBrowser(id: string): Promise<void> {
  const base = await awaitApiBase();
  await jsonOrThrow(await fetch(`${base}/api/browsers/${encodeURIComponent(id)}`, { method: "DELETE" }), "DELETE /api/browsers/:id");
}

export async function browserAction<T>(id: string, action: string, body?: Record<string, unknown>): Promise<T> {
  const base = await awaitApiBase();
  const res = await fetch(`${base}/api/browsers/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${action}: ${res.status} ${text.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

/* ============================================================
 * 日报 API (Phase 1)
 * ============================================================ */

export interface DailyMeta {
  lastGenAt: string | null;
  updatedAt: string;
}

export interface ChangedSessionsResult {
  newSessions: Array<{ id: string; name: string; goal: string; createdAt: string }>;
  changedSessions: Array<{
    id: string;
    name: string;
    goal: string;
    lastMessageAt: string;
    changedTurnRanges: Array<[number, number]>;
    snippet: string;
  }>;
}

export interface DailyGenerateResult {
  runId: string;
  status: string;
  message: string;
}

async function dailyRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = await awaitApiBase();
  const res = await fetch(`${base}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Daily API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const dailyApi = {
  /** 获取日报元数据 */
  getMeta: () => dailyRequest<DailyMeta>("/api/daily/meta"),

  /** 标记日报生成开始 */
  markStart: () => dailyRequest<{ lastGenAt: string }>("/api/daily/mark-start", { method: "POST" }),

  /** 获取自指定时间以来的变更会话 */
  getChangedSessions: (since: string) =>
    dailyRequest<ChangedSessionsResult>(`/api/daily/changed-sessions?since=${encodeURIComponent(since)}`),

  /** 触发生成日报 */
  generate: (since: string, modelTier: "high" | "low" | "exact" = "low") =>
    dailyRequest<DailyGenerateResult>("/api/daily/generate", {
      method: "POST",
      body: JSON.stringify({ since, modelTier }),
    }),

  /** 获取指定日期的日报内容 (Markdown 文本) */
  getDaily: (date: string) =>
    dailyRequest<string>(`/api/daily/entries?date=${encodeURIComponent(date)}`).catch(() => ""),
};
// ===== 远程机器人（手机操控 MoDuty）=====

export type BotKind = "feishu" | "wechat";

export type BotConnectionState =
  | "disabled"
  | "not_configured"
  | "connecting"
  | "connected"
  | "waiting_scan"
  | "scanned"
  | "expired"
  | "error";

export interface BotStatusView {
  kind: BotKind;
  state: BotConnectionState;
  label: string;
  error?: string;
  connectedAt?: number;
  login?: { status: string; qrDataUrl: string; scanUrl: string; error: string };
}

export interface BotsConfigView {
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
  defaultTarget: { kind: "dispatcher" | "session"; sessionId?: string };
}

export interface BotActivityView {
  lastInboundAt: number;
  lastOutboundAt: number;
  lastInboundPreview: string;
}

export interface BotsView {
  config: BotsConfigView;
  statuses: BotStatusView[];
  activity: BotActivityView;
  configPath: string;
}

async function botRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
  const base = await awaitApiBase();
  const res = await fetch(`${base}${pathname}`, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // 忽略非 JSON 错误体
    }
    throw new Error(`机器人接口失败：${detail}`);
  }
  return (await res.json()) as T;
}

export function fetchBots(): Promise<BotsView> {
  return botRequest<BotsView>("/api/bots");
}

export function fetchBotStatus(): Promise<{ statuses: BotStatusView[]; activity: BotActivityView }> {
  return botRequest<{ statuses: BotStatusView[]; activity: BotActivityView }>("/api/bots/status");
}

/** appSecret 省略/留空 = 不修改；clearSecret = 清空 */
export function saveFeishuBot(patch: {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  domain?: "feishu" | "lark";
  clearSecret?: boolean;
}): Promise<BotsView> {
  return botRequest<BotsView>("/api/bots/feishu", { method: "PUT", body: JSON.stringify(patch) });
}

export function setWechatBotEnabled(enabled: boolean): Promise<BotsView> {
  return botRequest<BotsView>("/api/bots/wechat", { method: "PUT", body: JSON.stringify({ enabled }) });
}

export function saveBotTarget(target: {
  kind: "dispatcher" | "session";
  sessionId?: string;
}): Promise<{ config: BotsConfigView }> {
  return botRequest<{ config: BotsConfigView }>("/api/bots/target", {
    method: "PUT",
    body: JSON.stringify(target),
  });
}

export function botAction(
  kind: BotKind,
  action: "enable" | "disable" | "restart" | "test",
  body?: Record<string, unknown>,
): Promise<BotsView> {
  return botRequest<BotsView>(`/api/bots/${kind}/${action}`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function startWechatBotLogin(): Promise<{
  scanUrl: string;
  qrDataUrl: string;
  statuses: BotStatusView[];
}> {
  return botRequest("/api/bots/wechat/login", { method: "POST", body: JSON.stringify({}) });
}

export function fetchWechatBotLogin(): Promise<{ status: BotStatusView; statuses: BotStatusView[] }> {
  return botRequest("/api/bots/wechat/login");
}

export function cancelWechatBotLogin(): Promise<{ status: BotStatusView }> {
  return botRequest("/api/bots/wechat/login", { method: "DELETE" });
}

export function logoutWechatBot(): Promise<BotsView> {
  return botRequest("/api/bots/wechat/logout", { method: "POST", body: JSON.stringify({}) });
}

export interface SessionOptionView {
  id: string;
  name: string;
  goal: string;
  last_message_at: string;
}

export async function listSessionOptions(): Promise<SessionOptionView[]> {
  const base = await awaitApiBase();
  const res = await fetch(`${base}/api/sessions`);
  const data = (await jsonOrThrow(res, "list sessions")) as { sessions?: SessionOptionView[] };
  return data.sessions ?? [];
}
