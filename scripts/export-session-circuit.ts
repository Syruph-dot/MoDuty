/**
 * 导出 MoDuty 会话为 session-circuit 可视化数据（agent.session.trace/v1）。
 *
 * 用法：
 *   npx tsx scripts/export-session-circuit.ts                     # 列出全部会话（id / 名称 / 轮次）
 *   npx tsx scripts/export-session-circuit.ts <sessionId>         # 导出单个会话
 *   npx tsx scripts/export-session-circuit.ts <sessionId> --out <file> [--max-turns 60] [--raw]
 *
 * 输出默认写到 memory/session-circuit/<sessionId>.trace.json；
 * 该 JSON 即 session-circuit（可视化原型）的输入格式，不接入 UI、不触碰前端。
 *
 * 字段映射（MoDuty → agent.session.trace/v1）：
 *   session.id / name              → session.id / project.name
 *   session.folder_path            → session.project.id（工作区 = 地线）
 *   session.created_at             → session.started_at（早于首条消息时才用）
 *   Turn（user+agent）             → turns[]
 *   userMessage.content/timestamp  → turns[].user / .at
 *   agentMessage.content           → turns[].assistant（--raw 全量，默认截断 4000 字）
 *   agentMessage.tool_calls[]      → events[]{type:tool|web, name, detail(args), result, error}
 *   agentMessage.matched_skills[]  → events[]{type:skill, name}
 *   消息正文 &ses_xxx 引用          → events[]{type:ref_session, target}
 *   其他会话指向本会话的 &ses 引用  → in_edges[]{from, at, count, note}
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { SessionManager } from "../src/session-manager.js";
import type { StoredMessage } from "../src/serialization.js";
import { extractAmpersandRefs } from "../src/relation-graph.js";

/* agent.session.trace/v1 的最小结构定义（与 session-circuit 输入格式对齐） */
interface TraceEvent {
  type: "tool" | "web" | "mcp" | "skill" | "ref_session";
  name?: string;
  target?: string;
  detail?: string;
  result?: string;
  error?: boolean;
}
interface TraceTurn {
  id: string;
  at: string;
  user: string;
  assistant: string | { summary: string };
  events: TraceEvent[];
}
interface TraceJSON {
  session: {
    id: string;
    project: { id: string; name: string };
    started_at?: string;
    agent?: string;
  };
  in_edges: Array<{ from: string; at: string; count: number; note?: string }>;
  turns: TraceTurn[];
}

/* ---- 工具名 → 事件类型归类：mcp 前缀 / 浏览器·联网类归 web，其余归 tool ---- */
function classifyTool(name: string): "tool" | "web" | "mcp" {
  if (/^mcp[_:]/i.test(name)) return "mcp";
  if (/(web|search|browser|http|fetch|crawl)/i.test(name)) return "web";
  return "tool";
}

const USER_CAP = 2000;
const ASSISTANT_CAP = 4000;
const ARGS_CAP = 280;

const cap = (text: string, n: number): string =>
  text.length > n ? `${text.slice(0, n)}…[截断]` : text;

/**
 * 轮次分组（导出专用，与 serialization.buildTurns 的差异）：
 * buildTurns 每轮只保留最后一条 agent 消息；真实会话里一轮往往有多个
 * agent 消息（每个工具批次一条），这里聚合全部，工具调用与正文不丢。
 */
interface AggTurn {
  index: number;
  user: StoredMessage;
  agents: StoredMessage[];
}

function groupTurns(messages: StoredMessage[]): AggTurn[] {
  const turns: AggTurn[] = [];
  let current: AggTurn | null = null;
  for (const msg of messages) {
    if (msg.role === "user") {
      current = { index: turns.length + 1, user: msg, agents: [] };
      turns.push(current);
    } else if (msg.role === "agent" && current) {
      current.agents.push(msg);
    }
    // tool/system 消息归属当前轮次（工具明细已在 agent.tool_calls 中）
  }
  return turns;
}

function parseArgs(argv: string[]): { sessionId?: string; out?: string; maxTurns: number; raw: boolean } {
  const args = [...argv];
  const out: string[] = [];
  let maxTurns = 60;
  let raw = false;
  while (args.length) {
    const a = args.shift() as string;
    if (a === "--out") out.push(args.shift() ?? "");
    else if (a === "--max-turns") maxTurns = Math.max(1, Number(args.shift()) || 60);
    else if (a === "--raw") raw = true;
    else out.push(a);
  }
  return { sessionId: out[0], out: out[1], maxTurns, raw };
}

async function main(): Promise<void> {
  const { sessionId, out, maxTurns, raw } = parseArgs(process.argv.slice(2));
  const memoryDir = path.resolve(import.meta.dirname ?? ".", "..", "memory");
  const manager = new SessionManager(memoryDir);

  const sessions = await manager.listAllSessions(true);
  if (!sessionId) {
    console.log("用法：npx tsx scripts/export-session-circuit.ts <sessionId> [--out file] [--max-turns N] [--raw]");
    console.log("\n可用会话：");
    for (const s of sessions.slice(0, 30)) {
      console.log(`  ${s.id}  ${s.name}  (turnIndex=${s.turnIndex ?? "-"}, msgs=${s.messageCount})`);
    }
    return;
  }

  const bundle = sessions.find((s) => s.id === sessionId);
  if (!bundle) throw new Error(`找不到会话：${sessionId}`);
  const messages = await manager.getStoredMessages(sessionId, null);
  const turns = groupTurns(messages);

  /* 本会话的出边：逐消息提取 &ses / &tile 引用 */
  const refByTurn = new Map<number, Array<{ target: string; kind: string }>>();
  for (const turn of turns) {
    const contents = [turn.user.content ?? "", ...turn.agents.map((a) => a.content ?? "")];
    const refs = new Set<string>();
    for (const content of contents) {
      for (const target of extractAmpersandRefs(content)) refs.add(target);
    }
    if (refs.size) {
      refByTurn.set(
        turn.index,
        [...refs].map((target) => ({ target, kind: target.startsWith("tile_") ? "tile" : "session" })),
      );
    }
  }

  const traceTurns: TraceTurn[] = turns.slice(-maxTurns).map((turn) => {
    const events: TraceEvent[] = [];
    for (const agent of turn.agents) {
      for (const call of agent.toolCalls ?? []) {
        events.push({
          type: classifyTool(call.tool),
          name: call.tool,
          detail: cap(String(call.args ?? ""), raw ? Number.MAX_SAFE_INTEGER : ARGS_CAP),
          result: call.isError === true || call.status === "error" ? "error" : "ok",
          error: call.isError === true || call.status === "error",
        });
      }
      for (const skill of agent.matchedSkills ?? []) {
        events.push({ type: "skill", name: skill });
      }
    }
    for (const ref of refByTurn.get(turn.index) ?? []) {
      if (ref.kind !== "session") continue; // tile 引用指向 Agent 实例，非会话
      const target = ref.target.startsWith("ses_") ? ref.target : `ses_${ref.target}`;
      events.push({ type: "ref_session", target, name: target });
    }
    const summary = turn.agents.map((a) => a.content ?? "").filter(Boolean).join("\n\n");
    return {
      id: `T${turn.index}`,
      at: turn.user.timestamp,
      user: cap(turn.user.content ?? "", raw ? Number.MAX_SAFE_INTEGER : USER_CAP),
      assistant: summary ? { summary: cap(summary, raw ? Number.MAX_SAFE_INTEGER : ASSISTANT_CAP) } : "",
      events,
    };
  });

  /* 入边：其他会话的消息里 &ses_<本会话> 的引用
     （extractAmpersandRefs 返回去前缀 id，比较时剥掉 ses_ 前缀） */
  const bareId = sessionId.replace(/^ses_/, "");
  const inEdges: Array<{ from: string; at: string; count: number; note: string }> = [];
  for (const other of sessions) {
    if (other.id === sessionId) continue;
    const others = await manager.getStoredMessages(other.id, null);
    let count = 0;
    let at = "";
    for (const msg of others) {
      const refs = extractAmpersandRefs(msg.content ?? "");
      if (refs.has(bareId)) {
        count += 1;
        at = at || msg.timestamp;
      }
    }
    if (count > 0) inEdges.push({ from: other.id, at, count, note: other.name });
  }

  const folder = bundle.folderPath ?? "";
  const firstAt = turns[0]?.user.timestamp ?? bundle.createdAt ?? "";
  const createdAt = bundle.createdAt && bundle.createdAt <= firstAt ? bundle.createdAt : firstAt;
  const trace: SessionTraceJSON = {
    session: {
      id: sessionId,
      project: {
        id: folder || "moduty",
        name: folder ? path.basename(folder) : "MoDuty",
      },
      started_at: createdAt,
      agent: bundle.name,
    },
    in_edges: inEdges,
    turns: traceTurns,
  };

  const outPath = out ?? path.resolve(memoryDir, "session-circuit", `${sessionId}.trace.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(trace, null, 2), "utf8");
  console.log(
    `已导出 ${traceTurns.length}/${turns.length} 轮（in_edges ${inEdges.length} 条）→ ${outPath}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
