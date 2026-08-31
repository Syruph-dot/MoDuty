#!/usr/bin/env node
/**
 * proma2momoka —— 将 Proma 会话 JSONL 转换为 MOMOKA 消息格式（独立工具，不集成进软件）。
 *
 * 用法：
 *   node scripts/proma2momoka.mjs <promaSession.jsonl> [--out <输出目录>] [--summary]
 *   node scripts/proma2momoka.mjs                  # 列出最近会话并退出
 *   node scripts/proma2momoka.mjs <file> --stdout  # 只打印转换后的 messages 数组
 *
 * Proma JSONL 行（~/.proma/agent-sessions/<id>.jsonl）：
 *   {type: "user"|"assistant"|"result", uuid, message:{content:[...]}, parent_tool_use_id, _createdAt}
 *   content 块: {type:"text",text} | {type:"thinking",thinking} | {type:"tool_use",id,name,input} | {type:"tool_result",tool_use_id,content,is_error}
 *
 * 输出 MOMOKA 消息（与 memory/.sessions/ses_xxx/messages.json 形状一致）：
 *   {id, role:"user"|"agent", content, timestamp, tool_calls:[{tool,args,result}], timeline:["text"|number,...]}
 *
 * 转换规则：
 *   - user 行：text 块 → user 消息；tool_result 块不回填为新消息，而是回填到对应 agent 消息的 tool_calls[].result
 *   - assistant 行：thinking 块丢弃；text 块拼接为 content；tool_use 块按出现顺序进 tool_calls，并生成 timeline（文本/工具交错）
 *   - tool_result 按 tool_use_id 精确回填；未匹配的计数并忽略
 *   - 默认只生成待审 JSON（不写回 MOMOKA）；合并需另行操作
 */
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const PROMa_DIR = path.join(homedir(), ".proma", "agent-sessions");
const DEFAULT_OUT = "C:/Users/17206/.proma/agent-workspaces/syrvault/fd465852-9280-4030-8f3c-c43789cd22b1/pending/proma2momoka";

function shortId(seed) {
  const h = seed
    ? [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)
    : Math.random().toString(16).slice(2, 14);
  return `msg_${h.padEnd(12, "0").slice(0, 12)}`;
}

function iso(ms) {
  if (!ms) return new Date().toISOString();
  const n = typeof ms === "number" ? ms : Number(ms);
  try {
    return new Date(Number.isFinite(n) ? n : ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function parseContentBlocks(message) {
  const m = message ?? {};
  const content = m.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => !!b && typeof b === "object");
}

export async function convert(promaFile) {
  const raw = await readFile(promaFile, "utf8");
  const rows = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const stats = {
    userRows: 0,
    assistantRows: 0,
    resultRows: 0,
    thinkingDropped: 0,
    textBlocks: 0,
    imageBlocksDropped: 0,
    toolUses: 0,
    toolResults: 0,
    toolResultsMatched: 0,
    toolResultsUnmatched: 0,
  };

  const messages = [];
  const resultIndex = new Map(); // tool_use_id -> {result, isError}
  // 预扫：tool_result（Anthropic 风格携带在紧随的 user 行）先全部入索引，再生成消息
  for (const row of rows) {
    if (String(row.type ?? "") !== "user") continue;
    const blocks = parseContentBlocks(row.message);
    for (const block of blocks) {
      if (block.type === "tool_result") {
        stats.toolResults += 1;
        const tid = String(block.tool_use_id ?? "");
        if (!tid) continue;
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        resultIndex.set(tid, { result: content, isError: !!block.is_error });
      }
    }
  }

  for (const row of rows) {
    const type = String(row.type ?? "");
    const uuid = String(row.uuid ?? "");
    const blocks = parseContentBlocks(row.message);

    if (type === "result") {
      stats.resultRows += 1;
      continue;
    }

    if (type === "user") {
      stats.userRows += 1;
      // 纯文本 = 真实用户输入 → user 消息（tool_result 已预扫，此分支不再处理）
      const texts = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
          stats.textBlocks += 1;
        } else if (block.type === "image" || block.type === "image_url") {
          stats.imageBlocksDropped += 1;
        }
      }
      if (texts.length > 0) {
        messages.push({
          id: shortId(uuid),
          role: "user",
          content: texts.join("\n\n"),
          timestamp: iso(row._createdAt),
        });
      }
      continue;
    }

    if (type === "assistant") {
      stats.assistantRows += 1;
      const texts = [];
      const toolCalls = [];
      const timeline = [];
      let toolIdx = 0;
      for (const block of blocks) {
        switch (block.type) {
          case "text":
            if (typeof block.text === "string") {
              texts.push(block.text);
              stats.textBlocks += 1;
              timeline.push("text");
            }
            break;
          case "thinking":
            stats.thinkingDropped += 1;
            break;
          case "tool_use": {
            stats.toolUses += 1;
            const tid = String(block.id ?? "");
            const name = String(block.name ?? "unknown");
            const args = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
            const known = resultIndex.get(tid);
            const item = { tool: name, args };
            if (known) {
              item.result = known.result;
              item.isError = known.isError;
              stats.toolResultsMatched += 1;
            } else {
              stats.toolResultsUnmatched += 1;
            }
            toolCalls.push(item);
            timeline.push(toolIdx);
            toolIdx += 1;
            break;
          }
          case "image":
          case "image_url":
            stats.imageBlocksDropped += 1;
            break;
          default:
            break;
        }
      }
      const message = {
        id: shortId(uuid),
        role: "agent",
        content: texts.join("\n\n"),
        timestamp: iso(row._createdAt),
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        message.timeline = timeline.length > 0 ? timeline : toolCalls.map((_, i) => i);
      }
      messages.push(message);
      continue;
    }
  }

  return {
    meta: {
      promaFile,
      promaSessionId: path.basename(promaFile, ".jsonl"),
      mappingVersion: 1,
      generatedAt: new Date().toISOString(),
      stats,
      messagesCount: messages.length,
      note: "待审文件：尚未写入 MOMOKA。合并需另行指示。",
    },
    messages,
  };
}

async function listSessions() {
  let files;
  try {
    files = (await readdir(PROMa_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    console.error(`Proma 会话目录不存在: ${PROMa_DIR}`);
    process.exit(1);
  }
  const infos = await Promise.all(
    files.map(async (f) => {
      const p = path.join(PROMa_DIR, f);
      const s = await stat(p);
      return { name: f, size: s.size, mtime: s.mtime };
    }),
  );
  infos.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  console.log(`最近 Proma 会话（${PROMa_DIR}）：`);
  for (const info of infos.slice(0, 15)) {
    console.log(`  ${info.name}  ${(info.size / 1024).toFixed(0).padStart(6)} KB  ${info.mtime.toISOString()}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    await listSessions();
    return;
  }
  const promaFile = path.resolve(argv[0]);
  const outFlag = argv.indexOf("--out");
  const outDir = outFlag >= 0 ? path.resolve(argv[outFlag + 1] ?? DEFAULT_OUT) : DEFAULT_OUT;
  const toStdout = argv.includes("--stdout");
  const toSummary = argv.includes("--summary");

  const { meta, messages } = await convert(promaFile);
  const base = path.basename(promaFile, ".jsonl");

  if (toStdout) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  await mkdir(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `${base}.momoka.json`);
  await writeFile(jsonFile, JSON.stringify({ meta, messages }, null, 2), "utf8");

  const previewFile = path.join(outDir, `${base}.preview.md`);
  const lines = [
    `# proma2momoka 待审预览`,
    ``,
    `- 源文件: ${meta.promaFile}`,
    `- 会话: ${meta.promaSessionId}`,
    `- 生成: ${meta.generatedAt}`,
    `- 消息数: ${meta.messagesCount}`,
    `- 统计: ${JSON.stringify(meta.stats)}`,
    ``,
    `## 消息预览（前 6 条）`,
  ];
  for (const m of messages.slice(0, 6)) {
    lines.push(`### ${m.role} @${String(m.timestamp).slice(0, 19)}`);
    lines.push("```text");
    lines.push(String(m.content ?? "").slice(0, 400) || "(空)");
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      lines.push(`[工具 ${m.tool_calls.map((t) => t.tool).join(", ")}]`);
    }
    lines.push("```");
  }
  if (messages.length > 6) {
    lines.push(`…共 ${messages.length} 条`);
  }
  await writeFile(previewFile, lines.join("\n"), "utf8");
  if (toSummary) {
    console.log(JSON.stringify(meta.stats, null, 2));
    console.log(`消息示例: ${JSON.stringify(messages[0] ?? {}, null, 2).slice(0, 300)}`);
  }
  console.log(`已生成待审文件（未合并）:\n  ${jsonFile}\n  ${previewFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});