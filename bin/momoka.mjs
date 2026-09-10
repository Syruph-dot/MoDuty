#!/usr/bin/env node
/**
 * MOMOKA CLI —— 让 Agent 用 Agent 应用（也是被 run_momoka_cli 工具调用的二进制入口）。
 * v1 最小集（只读/受控；无删除）：
 *   momoka agent list
 *   momoka agent create --name <名称> [--workspace <目录>] [--model <模型>] [--system <提示词>]
 *   momoka agent chat <agentId> <消息…>（同步等待结果；消息可含 &ses_<id> 句柄）
 *   momoka agent dispatch <agentId> <消息…>（异步派发，立即返回；适合值日生懒调度）
 *   momoka agent reset <agentId>
 *   momoka agent stop <agentId>
 *   momoka session list
 *   momoka session inspect <ses_<id>>
 *
 * 无第三方依赖（Node 18+ 原生 fetch）。环境变量 MOMOKA_URL 可覆盖后端地址（默认 http://localhost:8888）。
 * --mono 强制纯文本输出（工具调用时自动加）；默认 TTY 时彩色。
 */
import { spawn } from "node:child_process";

const BASE = process.env.MOMOKA_URL ?? "http://localhost:8888";
const MONO = process.argv.includes("--mono");

function println(text) {
  process.stdout.write(`${text}\n`);
}
function errln(text) {
  process.stderr.write(`${text}\n`);
}

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = data && typeof data === "object" && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return { status: res.status, data };
}

/**
 * 异步下发：POST /api/agents/:id/chat 后不等 SSE 结束即返回（连接断开不中止任务，
 * 完成后由服务端把结果链接投递回值日生会话）。适合“派发即回 idle”的懒调度语义。
 */
async function dispatchChat(agentId, message) {
  const res = await fetch(`${BASE}/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
    const text = await res.text().catch(() => "");
    throw new Error(`dispatch 失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  // 不等流：读完头即可认为已受理。连接关闭后任务由服务端继续后台执行。
  await res.body?.cancel().catch(() => undefined);
  return `已派发 ${agentId}（任务后台执行中，完成/出错会通过值日生会话投递链接）`;
}

async function runStreamingChat(agentId, message) {
  const res = await fetch(`${BASE}/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
    const text = await res.text().catch(() => "");
    throw new Error(`chat 失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const evt = JSON.parse(raw);
        if (evt.type === "text" && typeof evt.text === "string") parts.push(evt.text);
        if (evt.type === "tool" && evt.name) {
          parts.push(`\n[工具 ${evt.name} ${evt.status === "running" ? "运行中" : "完成"}]`);
        }
        if (evt.type === "done") parts.push(`\n[done run=${evt.run_id ?? ""}]`);
        if (evt.type === "error") parts.push(`\n[error ${evt.message ?? ""}]`);
      } catch {
        /* 非 JSON 事件忽略 */
      }
    }
  }
  return parts.join("").trim();
}

function parseArgs(argv, sub) {
  const args = argv.slice(argv.indexOf(sub) + 1);
  const named = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        named[key] = true;
      } else {
        named[key] = value;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { named, positional };
}

function tokenizeChatMessage(positional) {
  // 支持 --link 只在 named 中；这里 positional 为 [agentId, ...消息词]
  const [agentId, ...words] = positional;
  const message = words.join(" ");
  return { agentId, message };
}

async function main() {
  const argv = process.argv.slice(2).filter((token) => token !== "--mono");
  const [cmd, sub] = argv;
  if (!cmd || !sub) {
    println("MOMOKA CLI v1 — 让 Agent 用 Agent 应用");
    println("用法：");
    println("  momoka agent list");
    println("  momoka agent create --name <名称> [--workspace <目录>] [--model <模型>] [--system <提示词>]");
    println("  momoka agent chat <agentId> <消息…>");
    println("  momoka agent dispatch <agentId> <消息…>");
    println("  momoka agent reset <agentId>");
    println("  momoka agent stop <agentId>");
    println("  momoka session list");
    println("  momoka session inspect <ses_<id>>");
    process.exit(cmd ? 2 : 0);
  }

  if (cmd === "agent") {
    const { named, positional } = parseArgs(argv, sub);
    if (sub === "list") {
      const { data } = await api("GET", "/api/agents");
      let agents = Array.isArray(data?.agents) ? data.agents : [];
      if (agents.length === 0) {
        println("(无 Agent)");
        return;
      }
      // 收口：未筛就用过滤 + 截断，避免把全量 Agent（数百个）灌进模型上下文，
      // 也避免“列表顺序固定 → 永远取第一个”的退化行为。
      const query = String(named.query ?? "").trim().toLowerCase();
      const limitRaw = Number(named.limit ?? 0);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : query ? 0 : 30;
      if (query) {
        agents = agents.filter((agent) => {
          const haystack = `${agent.id} ${agent.name} ${agent.session?.goal ?? ""}`.toLowerCase();
          return haystack.includes(query);
        });
        if (agents.length === 0) {
          println(`(无匹配 Agent：${named.query}) —— 考虑 agent create 新建执行者`);
          return;
        }
      } else {
        // 未给查询词：按最近活动排序（至少不再是固定的“注册顺序第一”）。
        const lastOf = (agent) => String(agent.session?.last_message_at ?? agent.last_active_at ?? "");
        agents = [...agents].sort((a, b) => lastOf(b).localeCompare(lastOf(a)));
      }
      const total = agents.length;
      if (limit > 0) agents = agents.slice(0, limit);
      for (const agent of agents) {
        const last = agent.session?.last_message_at ?? agent.last_active_at ?? "-";
        println(`${agent.id}\t${agent.name}\t${agent.state}\t${agent.kind ?? "worker"}\t最后活动 ${last}\t会话 ${agent.session_id}`);
      }
      if (limit > 0 && total > limit) {
        println(`（已截断：共 ${total} 个，列出前 ${limit} 个；请用 --query <主题> 精确筛选）`);
      }
      if (!query) {
        println("（提示：未提供 --query，已按最近活动排序；建议先用 search_sessions 检索，或 agent list --query <主题>）");
      }
      return;
    }
    if (sub === "create") {
      const name = named.name ?? "";
      if (!name.trim()) throw new Error("--name 必填");
      const { data } = await api("POST", "/api/agents", {
        name: name.trim(),
        ...(named.workspace ? { workspace_dir: named.workspace } : {}),
        ...(named.model ? { model: named.model } : {}),
        ...(named.system ? { system: named.system } : {}),
      });
      const agent = data.agent;
      println(`created ${agent.id} 「${agent.name}」 会话 ${agent.session_id}`);
      return;
    }
    if (sub === "chat") {
      const { agentId, message } = tokenizeChatMessage(positional);
      if (!agentId) throw new Error("chat 需要 agentId");
      if (!message.trim()) throw new Error("chat 需要消息文本");
      println(`→ ${agentId}: ${message}`);
      println((await runStreamingChat(agentId, message)) || "(无输出)");
      return;
    }
    if (sub === "dispatch") {
      // 异步派发：POST 后立即返回（后台执行，适合值日生“派发完回 idle”）
      const { agentId, message } = tokenizeChatMessage(positional);
      if (!agentId) throw new Error("dispatch 需要 agentId");
      if (!message.trim()) throw new Error("dispatch 需要消息文本");
      println(`→ ${agentId}: ${message}`);
      println(await dispatchChat(agentId, message));
      return;
    }
    if (sub === "reset") {
      const agentId = positional[0];
      if (!agentId) throw new Error("reset 需要 agentId");
      await api("POST", `/api/agents/${agentId}/chat/reset`);
      println(`reset ${agentId}`);
      return;
    }
    if (sub === "stop") {
      const agentId = positional[0];
      if (!agentId) throw new Error("stop 需要 agentId");
      await api("POST", `/api/agents/${agentId}/chat/cancel`);
      println(`stop ${agentId}`);
      return;
    }
    throw new Error(`未知子命令 agent ${sub}`);
  }

  if (cmd === "session") {
    const { positional } = parseArgs(argv, sub);
    if (sub === "list") {
      const { data } = await api("GET", "/api/sessions");
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (sessions.length === 0) {
        println("(无会话)");
        return;
      }
      for (const s of sessions.slice(0, 50)) {
        println(`${s.id}\t${s.name ?? ""}\t${s.goal ?? ""}${s.updated_at ? `\t${s.updated_at}` : ""}`);
      }
      return;
    }
    if (sub === "inspect") {
      const handle = positional[0] ?? "";
      const sessionId = handle.replace(/^ses_/, "");
      if (!sessionId) throw new Error("inspect 需要会话句柄（ses_<id>）");
      const { data } = await api("GET", `/api/sessions/${sessionId}/inspect`);
      println(JSON.stringify(data, null, 2));
      return;
    }
    throw new Error(`未知子命令 session ${sub}`);
  }

  throw new Error(`未知命令 ${cmd}`);
}

main().catch((error) => {
  errln(`MOMOKA CLI 错误：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});