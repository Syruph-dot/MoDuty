/**
 * 手机消息 → CLI 动词。桥（飞书 / 微信）只负责收与发，真正干活的是 CLI。
 *
 * 约定（与用户拍板一致）：
 * - 裸文本 → 默认目标（值日生，或固定某个会话）；
 * - `/xxx …` → 命令：`/help` `/status` `/sessions [词]` `/chat <会话|关键词> <文本>`
 *   `/agent <名字|id> <文本>` `/dispatch <名字|id> <文本>` `/new <名字>`；
 *   命令族（agent / session / dispatch）原样透传，等于在手机上直接敲 CLI。
 * - 执行走 `runMomokaCliTool({ scope: "remote" })`：与 Agent 侧同一条路径，
 *   白名单 + 超时 + 输出截断复用；remote 口径多放行 `agent dispatcher` / `session chat`。
 */
import { runMomokaCliTool } from "../tools.js";
import type { BotDefaultTarget } from "../bot-config.js";

export interface BotCommandResult {
  text: string;
  /** 是否真的驱动了一次 Agent 运行（用于桥决定是否先回「收到，处理中…」） */
  ran: boolean;
}

/** 单条回复的硬上限（跑飞时兜底；正常不再截断——投递时拆成多条消息，见 bot/reply-format.ts） */
const MAX_REPLY_CHARS = 60_000;
/** 驱动 Agent 的那类命令（chat / dispatcher / dispatch）允许跑很久 */
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_TIMEOUT_MS = 60 * 1000;

const USAGE = [
  "MoDuty 远程助手 —— 手机上这样用：",
  "  直接说一句话 → 交给值日生",
  "/status 现在怎么样（服务 + 值日生 + 台账未结单）",
  "/sessions [关键词] 列最近会话",
  "/chat <会话|关键词> <一句话> 找某个会话聊",
  "/agent <名字|id> <一句话> 找某个 Agent 聊",
  "/dispatch <名字|id> <任务> 派活（异步，立即返回）",
  "/new <名字> 新建 Agent",
  "/help 看这份说明",
].join("\n");

interface AgentBrief {
  id: string;
  name?: string;
  state?: string;
  session_id?: string;
  last_active_at?: string;
}

function selfBaseUrl(): string {
  return process.env.MOMOKA_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8888}`;
}

async function fetchJson<T>(pathname: string): Promise<T | null> {
  try {
    const res = await fetch(`${selfBaseUrl()}${pathname}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 把「名字或 id」解析成 Agent（精确 id → 去掉 agt_ 前缀 → 名字：完全相等优先，其次包含，取最近活动） */
export async function resolveAgentBrief(handle: string): Promise<AgentBrief | null> {
  const wanted = handle.trim();
  if (!wanted) return null;
  const data = await fetchJson<{ agents?: AgentBrief[] }>("/api/agents");
  const agents = Array.isArray(data?.agents) ? data!.agents! : [];
  if (agents.length === 0) return null;
  const byRecency = (list: AgentBrief[]): AgentBrief[] =>
    [...list].sort((a, b) =>
      String(b.last_active_at ?? "").localeCompare(String(a.last_active_at ?? "")),
    );
  const bare = wanted.replace(/^agt_/, "").toLowerCase();
  return (
    byRecency(agents.filter((agent) => agent.id === wanted))[0] ??
    byRecency(agents.filter((agent) => agent.id.replace(/^agt_/, "").toLowerCase() === bare))[0] ??
    byRecency(agents.filter((agent) => (agent.name ?? "").trim() === wanted))[0] ??
    byRecency(agents.filter((agent) => (agent.name ?? "").toLowerCase().includes(wanted.toLowerCase())))[0] ??
    null
  );
}

/** 整理 CLI 输出给手机看：去掉运行噪声（done 行、工具起止、默认目标的箭头行），统计工具调用次数，截断超长 */
export function polishCliOutput(raw: string): string {
  const kept: string[] = [];
  let tools = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (/^\[done run=/.test(trimmed)) continue;
    if (/^\[工具 .*运行中\]$/.test(trimmed)) continue;
    if (/^\[工具 .*完成\]/.test(trimmed)) {
      tools += 1;
      continue;
    }
    if (/^→ 值日生 /.test(trimmed)) continue;
    kept.push(trimmed);
  }
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // 有工具调用但一句正文都没有：不要只回一句「（期间调用了 N 个工具）」——那不是回复
  if (!text && tools > 0) {
    return `（本轮调用了 ${tools} 个工具，但没有生成回复：上游只回了工具调用/空流。可以再说一遍，或换个模型重试。）`;
  }
  if (tools > 0) text = `${text}\n\n（期间调用了 ${tools} 个工具）`.trim();
  if (text.length > MAX_REPLY_CHARS) {
    // 只做跑飞兜底；正常长度不再截断，由投递层拆成多条消息发完（见 bot/reply-format.ts）
    text = `${text.slice(0, MAX_REPLY_CHARS)}\n…（输出异常过长，已在 ${MAX_REPLY_CHARS} 字处停止读取）`;
  }
  return text || "（没有输出）";
}

/**
 * 这条消息会不会真的驱动一次 Agent 运行（决定要不要先回「收到，处理中…」）。
 * 只读命令（help/status/列表/新建）秒回，不用打扰；驱动 Agent 的（裸文本、chat、dispatcher）会跑很久。
 */
export function classifyBotCommand(text: string): "quick" | "agent" {
  const raw = text.trim();
  if (!raw) return "quick";
  if (!raw.startsWith("/") && !raw.startsWith("／")) return "agent";
  const tokens = raw.replace(/^[/／]\s*/, "").split(" ").filter(Boolean);
  const head = (tokens[0] ?? "").toLowerCase();
  const second = (tokens[1] ?? "").toLowerCase();
  if (head === "help" || head === "?" || head === "帮助") return "quick";
  if (head === "status" || head === "状态") return "quick";
  if (head === "sessions" || head === "会话") return "quick";
  if (head === "new" || head === "新建") return "quick";
  if (head === "session") return ["list", "inspect"].includes(second) ? "quick" : "agent";
  if (head === "dispatch") return ["list", "show", "cancel"].includes(second) ? "quick" : "quick";
  if (head === "agent") {
    if (second === "list") return "quick";
    if (second === "create" || second === "reset" || second === "stop") return "quick";
    return "agent";
  }
  return "agent";
}

async function runCli(args: string[], timeoutMs: number): Promise<BotCommandResult> {
  const raw = await runMomokaCliTool({
    args,
    scope: "remote",
    commandTimeoutMs: timeoutMs,
    // 手机上要发完整回应：输出上限调大（投递层会拆成多条消息，不截断）
    maxOutputChars: 60_000,
  });
  return { text: polishCliOutput(raw), ran: true };
}

/** 手机文本 → CLI 动词并执行 */
export async function runBotCommand(input: {
  text: string;
  defaultTarget: BotDefaultTarget;
}): Promise<BotCommandResult> {
  const raw = input.text.trim().replace(/\s+/g, " ");
  if (!raw) return { text: USAGE, ran: false };

  // 裸文本：交给默认目标（值日生 / 固定会话）
  if (!raw.startsWith("/") && !raw.startsWith("／")) {
    return input.defaultTarget.kind === "session" && input.defaultTarget.sessionId
      ? runCli(["session", "chat", input.defaultTarget.sessionId, raw], CHAT_TIMEOUT_MS)
      : runCli(["agent", "dispatcher", raw], CHAT_TIMEOUT_MS);
  }

  const body = raw.replace(/^[/／]\s*/, "");
  const tokens = body.split(" ").filter(Boolean);
  const head = (tokens[0] ?? "").toLowerCase();
  const rest = tokens.slice(1);
  const restText = rest.join(" ").trim();

  // 命令族原样透传（等于在手机上直接敲 CLI）：/agent list、/session list --query X、/status …
  if (head === "help" || head === "?" || head === "帮助") return runCli(["help"], QUICK_TIMEOUT_MS);
  if (head === "status" || head === "状态") return runCli(["status"], QUICK_TIMEOUT_MS);
  if (head === "sessions" || head === "会话") {
    return runCli(restText ? ["session", "list", "--query", restText] : ["session", "list"], QUICK_TIMEOUT_MS);
  }
  if (head === "agent" && (rest[0] ?? "").toLowerCase() === "list") {
    return runCli(["agent", "list"], QUICK_TIMEOUT_MS);
  }
  if (head === "session" || head === "dispatch") {
    // /session list|inspect|chat …、/dispatch list|show|cancel …：CLI 口径，直接透传
    if (rest[0] === "list" || rest[0] === "show" || rest[0] === "cancel" || rest[0] === "inspect") {
      return runCli([head, ...rest], QUICK_TIMEOUT_MS);
    }
    if (head === "dispatch") return runCli(["dispatch", ...rest], QUICK_TIMEOUT_MS);
    return runCli(["session", ...rest], CHAT_TIMEOUT_MS);
  }

  // /chat <会话|关键词> <文本>
  if (head === "chat" || head === "聊") {
    const [handle, ...words] = rest;
    const text = words.join(" ").trim();
    if (!handle || !text) return { text: "用法：/chat <会话|关键词> <要说的话>", ran: false };
    return runCli(["session", "chat", handle, text], CHAT_TIMEOUT_MS);
  }

  // /agent dispatch <名字|id> <任务> 与 /dispatch <名字|id> <任务>：异步派活，立即返回
  if (head === "派" || (head === "agent" && rest[0] === "dispatch")) {
    const args = head === "派" ? rest : rest.slice(1);
    const [handle, ...words] = args;
    const task = words.join(" ").trim();
    if (!handle || !task) return { text: "用法：/dispatch <名字|id> <任务>", ran: false };
    const agent = await resolveAgentBrief(handle);
    if (!agent) return { text: `找不到 Agent：${handle}`, ran: false };
    return runCli(["agent", "dispatch", agent.id, task], QUICK_TIMEOUT_MS);
  }

  // /agent <名字|id> <文本>
  if (head === "agent" || head === "ask" || head === "问") {
    const [handle, ...words] = rest;
    const text = words.join(" ").trim();
    if (!handle || !text) return { text: "用法：/agent <名字|id> <要说的话>", ran: false };
    const agent = await resolveAgentBrief(handle);
    if (!agent) return { text: `找不到 Agent：${handle}（/sessions 看会话，或用 agt_ id）`, ran: false };
    return runCli(["agent", "chat", agent.id, text], CHAT_TIMEOUT_MS);
  }

  // /new <名字>：新建执行者
  if (head === "new" || head === "新建") {
    if (!restText) return { text: "用法：/new <名字>", ran: false };
    return runCli(["agent", "create", "--name", restText], QUICK_TIMEOUT_MS);
  }

  // 其余命令族透传（agent / session / dispatch），由 CLI 白名单再兜一层
  if (head === "agent" || head === "session" || head === "dispatch") {
    return runCli([head, ...rest], CHAT_TIMEOUT_MS);
  }

  return { text: `不认识的命令：/${head}\n\n${USAGE}`, ran: false };
}
