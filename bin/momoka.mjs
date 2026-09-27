#!/usr/bin/env node
/**
 * MOMOKA CLI —— 让 Agent 用 Agent 应用（也是被 run_momoka_cli 工具调用的二进制入口）。
 * v1 最小集（只读/受控；无删除）：
 *   momoka agent list
 *   momoka agent create --name <名称> [--workspace <目录>] [--model <模型>] [--system <提示词>]
 *   momoka agent chat <agentId> <消息…>（同步等待结果；消息可含 &ses_<id> 句柄）
 *   momoka agent dispatch <agentId> <消息…>（异步派发，立即返回；适合值日生懒调度）
 *   momoka agent dispatcher <消息…>（对值日生说一句，同步等回复——手机/外部渠道默认走这条）
 *   momoka agent reset <agentId>
 *   momoka agent stop <agentId>
 *   momoka session list [--query <词>] [--limit <n>]（默认按最近活动排序，限 30 条）
 *   momoka session chat <ses_id|关键词> <消息…>（解析到该会话绑定的 Agent 并同步对话）
 *   momoka session inspect <ses_<id>>
 *   momoka status（服务健康 + 各状态 Agent 数 + 台账未结单）
 *   momoka help
 *
 * 无第三方依赖（Node 18+ 原生 fetch）。环境变量 MOMOKA_URL 可覆盖后端地址（默认 http://localhost:8888）。
 * --mono 强制纯文本输出（工具调用时自动加）；默认 TTY 时彩色。
 */
import { spawn } from "node:child_process";

const BASE = process.env.MOMOKA_URL ?? "http://localhost:8888";
const MONO = process.argv.includes("--mono");
/** 是否把 reasoning 流也打出来（默认关：手机/工具输出里太吵） */
const SHOW_REASONING = process.argv.includes("--reasoning");

function println(text) {
  process.stdout.write(`${text}\n`);
}
function errln(text) {
  process.stderr.write(`${text}\n`);
}

/** 用法文本（bot 的「帮助」回复直接用它） */
function usage() {
  println("MOMOKA CLI v1 — 让 Agent 用 Agent 应用");
  println("用法：");
  println("  momoka help");
  println("  momoka status");
  println("  momoka agent list [--query <主题>] [--limit <n>]");
  println("  momoka agent create --name <名称> [--workspace <目录>] [--model <模型>] [--system <提示词>]");
  println("  momoka agent chat <agentId> <消息…>");
  println("  momoka agent dispatch <agentId> <消息…>");
  println("  momoka agent dispatcher <消息…>");
  println("  momoka agent reset <agentId>");
  println("  momoka agent stop <agentId>");
  println("  momoka session list [--query <词>] [--limit <n>]");
  println("  momoka session chat <ses_id|关键词> <消息…>");
  println("  momoka session inspect <ses_<id>>");
  println("  momoka session quickref list|get|add|update|delete|audit <ses_id> [entry_id] [--topic <主题>] [--content <正文>] [--sources <来源ID,...>] [--revision <n>]");
}

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "x-momoka-client": "cli", ...(body ? { "content-type": "application/json" } : {}) },
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
  /** 思考分片先收着：一整段思考最后只用一个【思考】块括起来 */
  const reasoning = [];
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
        // 服务端 SSE 事件名：token / reasoning / tool_start / tool_result / done / error
        // （旧版这里找的是 text / tool，与真实事件名对不上 → 正文一条也收不到，只剩 [done run=…]）
        if (evt.type === "token" && typeof evt.text === "string") parts.push(evt.text);
        if (evt.type === "reasoning" && typeof evt.text === "string") reasoning.push(evt.text);
        if (evt.type === "tool_start" && evt.name) {
          parts.push(`\n[工具 ${evt.name} 运行中]`);
        }
        if (evt.type === "tool_result" && evt.name) {
          const brief = String(evt.result ?? "").replace(/\s+/g, " ").slice(0, 160);
          parts.push(`\n[工具 ${evt.name} 完成] ${brief}`);
        }
        if (evt.type === "done") parts.push(`\n[done run=${evt.run_id ?? ""}]`);
        if (evt.type === "error") parts.push(`\n[error ${evt.message ?? evt.error ?? ""}]`);
      } catch {
        /* 非 JSON 事件忽略 */
      }
    }
  }
  const body = parts.join("").trim();
  // 思考：整段包在【思考】…【/思考】里（此前每个分片各占一行，手机上满屏 [思考]）
  if (SHOW_REASONING) {
    const thinking = reasoning.join("").trim();
    if (thinking) return [`【思考】\n${thinking}\n【/思考】`, body].filter(Boolean).join("\n\n");
  }
  return body;
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
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(cmd ? 0 : 2);
  }

  if (cmd === "status") {
    // 手机/外部渠道问「现在怎么样」的一句话总览：服务 + Agent 状态分布 + 台账未结单
    const healthRes = await fetch(`${BASE}/health`).catch(() => null);
    println(healthRes?.ok ? "服务：ok" : `服务：不可达（${BASE}）`);
    const { data: agentData } = await api("GET", "/api/agents");
    const agents = Array.isArray(agentData?.agents) ? agentData.agents : [];
    const byState = new Map();
    for (const agent of agents) byState.set(agent.state ?? "?", (byState.get(agent.state ?? "?") ?? 0) + 1);
    println(`Agent 共 ${agents.length}：${[...byState].map(([state, count]) => `${state} ${count}`).join(" / ")}`);
    const dispatcher = agents
      .filter((agent) => agent.kind === "dispatcher")
      .sort((a, b) => String(b.last_active_at ?? "").localeCompare(String(a.last_active_at ?? "")))[0];
    println(dispatcher ? `值日生：${dispatcher.name}（${dispatcher.state}）${dispatcher.id}` : "值日生：未创建");
    const { data: dispatchData } = await api("GET", "/api/dispatches?state=active");
    const active = Array.isArray(dispatchData?.dispatches) ? dispatchData.dispatches : [];
    println(`台账未结单：${active.length} 条`);
    for (const item of active.slice(0, 10)) {
      const label = item.target?.name ?? item.target?.agent_id ?? "?";
      println(`  ${item.id}\t${item.state}\t${label}\t${String(item.task ?? "").slice(0, 40)}`);
    }
    return;
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
    if (sub === "dispatcher") {
      // 对值日生说一句（手机/外部渠道的默认目标）：解析 kind=dispatcher → 同步等回复
      const message = positional.join(" ").trim();
      if (!message) throw new Error("dispatcher 需要消息文本");
      const { data } = await api("GET", "/api/agents");
      const agents = Array.isArray(data?.agents) ? data.agents : [];
      const dispatcher = agents
        .filter((agent) => agent.kind === "dispatcher")
        .sort((a, b) => String(b.last_active_at ?? "").localeCompare(String(a.last_active_at ?? "")))[0];
      if (!dispatcher) throw new Error("没有值日生（请先在桌面上创建调度者 Agent）");
      println(`→ 值日生 ${dispatcher.name} (${dispatcher.id})`);
      println((await runStreamingChat(dispatcher.id, message)) || "(无输出)");
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
    const { named, positional } = parseArgs(argv, sub);
    if (sub === "quickref") {
      const [operation, sessionId, entryId] = positional;
      if (!operation || !sessionId) throw new Error("session quickref 需要操作与 ses_id");
      const collection = "/api/sessions/" + encodeURIComponent(sessionId) + "/quickrefs";
      const item = entryId ? collection + "/" + encodeURIComponent(entryId) : "";
      const revision = Number(named.revision);
      const sources = typeof named.sources === "string"
        ? named.sources.split(",").map((value) => value.trim()).filter(Boolean)
        : [];
      let data;
      if (operation === "list") {
        ({ data } = await api("GET", collection));
      } else if (operation === "audit") {
        ({ data } = await api("GET", collection + "/audit"));
      } else if (operation === "get" && item) {
        ({ data } = await api("GET", item));
      } else if (operation === "add") {
        if (typeof named.topic !== "string" || typeof named.content !== "string") {
          throw new Error("quickref add 需要 --topic 与 --content");
        }
        ({ data } = await api("POST", collection, { topic: named.topic, content: named.content, source_refs: sources }));
      } else if (operation === "update" && item) {
        if (!Number.isInteger(revision) || revision < 1) throw new Error("quickref update 需要 --revision <n>");
        const patch = { expected_revision: revision };
        if (typeof named.topic === "string") patch.topic = named.topic;
        if (typeof named.content === "string") patch.content = named.content;
        if (named.sources !== undefined) patch.source_refs = sources;
        if (!("topic" in patch) && !("content" in patch) && !("source_refs" in patch)) {
          throw new Error("quickref update 至少需要 --topic、--content 或 --sources");
        }
        ({ data } = await api("PATCH", item, patch));
      } else if (operation === "delete" && item) {
        if (!Number.isInteger(revision) || revision < 1) throw new Error("quickref delete 需要 --revision <n>");
        ({ data } = await api("DELETE", item, { expected_revision: revision }));
      } else {
        throw new Error("未知 quickref 操作：" + operation);
      }
      println(JSON.stringify(data, null, 2));
      return;
    }
    if (sub === "list") {
      const { data } = await api("GET", "/api/sessions");
      let sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (sessions.length === 0) {
        println("(无会话)");
        return;
      }
      // 与 agent list 同口径：先按最近活动排序，再按关键词过滤，再截断（避免把上百条灌进手机/模型）
      const lastOf = (s) => String(s.updated_at ?? s.last_message_at ?? "");
      sessions = [...sessions].sort((a, b) => lastOf(b).localeCompare(lastOf(a)));
      const query = String(named.query ?? "").trim().toLowerCase();
      if (query) {
        sessions = sessions.filter((s) => `${s.id} ${s.name ?? ""} ${s.goal ?? ""}`.toLowerCase().includes(query));
        if (sessions.length === 0) {
          println(`(无匹配会话：${named.query})`);
          return;
        }
      }
      const limitRaw = Number(named.limit ?? 0);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : query ? 10 : 30;
      const total = sessions.length;
      for (const s of sessions.slice(0, limit)) {
        println(`${s.id}\t${s.name ?? ""}\t${s.goal ?? ""}${s.updated_at ? `\t${s.updated_at}` : ""}`);
      }
      if (total > limit) println(`（已截断：共 ${total} 个，列出前 ${limit} 个；请用 --query <词> 精确筛选）`);
      return;
    }
    if (sub === "chat") {
      // 会话句柄 → 绑定 Agent → 同步对话（手机可说「会话 <关键词>：<任务>」）
      const [handle, ...words] = positional;
      const message = words.join(" ").trim();
      if (!handle) throw new Error("session chat 需要 <ses_id|关键词> 与消息文本");
      if (!message) throw new Error("session chat 需要消息文本");
      const { data: sessionData } = await api("GET", "/api/sessions");
      const sessions = Array.isArray(sessionData?.sessions) ? sessionData.sessions : [];
      const bare = handle.replace(/^ses_/, "").toLowerCase();
      const matched =
        sessions.find((s) => s.id === handle) ??
        sessions.find((s) => String(s.id).replace(/^ses_/, "") === bare) ??
        [...sessions]
          .sort((a, b) => String(b.updated_at ?? b.last_message_at ?? "").localeCompare(String(a.updated_at ?? a.last_message_at ?? "")))
          .find((s) => `${s.name ?? ""} ${s.goal ?? ""}`.toLowerCase().includes(handle.toLowerCase()));
      if (!matched) throw new Error(`找不到会话：${handle}（可先 session list --query <词>）`);
      const { data: agentData } = await api("GET", "/api/agents");
      const agents = Array.isArray(agentData?.agents) ? agentData.agents : [];
      const bound = agents.find((agent) => agent.session_id === matched.id);
      if (!bound) throw new Error(`会话 ${matched.id} 没有绑定的 Agent（session inspect 可看内容）`);
      println(`→ 会话 ${matched.id}（${matched.name ?? matched.goal ?? ""}）→ ${bound.name} (${bound.id})`);
      println((await runStreamingChat(bound.id, message)) || "(无输出)");
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
