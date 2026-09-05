import type { IncomingMessage, ServerResponse } from "node:http";
import { readDailyGenMeta, markDailyGenStart, getChangedSessionsSince } from "../daily-meta.js";
import type { RouteContext } from "./route-context.js";
import { json, readJsonBody, corsHeaders } from "./http-utils.js";
import { createOpenAICompatibleModelClient } from "../model-client.js";

/**
 * 日报相关路由：
 * - GET  /api/daily/meta          -> 返回 { lastGenAt, updatedAt }
 * - POST /api/daily/mark-start    -> 标记日报生成开始，返回新的 lastGenAt
 * - GET  /api/daily/changed-sessions?since=ISO -> 返回自 since 以来的新建/变更会话
 * - POST /api/daily/generate      -> 触发生成日报（body: { since, modelTier? }），异步返回 runId
 */
export async function handleDailyRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/daily/")) return false;

  const agent = ctx.agent;
  const sessionManager = agent.sessionManager;

  // GET /api/daily/meta
  if (url.pathname === "/api/daily/meta" && request.method === "GET") {
    const meta = await readDailyGenMeta();
    json(response, 200, meta);
    return true;
  }

  // POST /api/daily/mark-start
  if (url.pathname === "/api/daily/mark-start" && request.method === "POST") {
    const newGenAt = await markDailyGenStart();
    json(response, 200, { lastGenAt: newGenAt });
    return true;
  }

  // GET /api/daily/changed-sessions?since=ISO
  if (url.pathname === "/api/daily/changed-sessions" && request.method === "GET") {
    const since = url.searchParams.get("since");
    if (!since) {
      json(response, 400, { error: "缺少 since 参数（ISO 时间戳）" });
      return true;
    }
    try {
      const result = await getChangedSessionsSince(since, sessionManager);
      json(response, 200, result);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  // GET /api/daily/entries?date=YYYY-MM-DD
  if (url.pathname === "/api/daily/entries" && request.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) {
      json(response, 400, { error: "缺少 date 参数 (YYYY-MM-DD)" });
      return true;
    }
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const file = path.join(process.cwd(), "memory", "dailies", `${date}.md`);
      const content = await fs.readFile(file, "utf8").catch(() => null);
      if (content) {
        response.writeHead(200, { "content-type": "text/markdown; charset=utf-8", ...corsHeaders() });
        response.end(content);
      } else {
        json(response, 404, { error: "日报不存在" });
      }
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  // POST /api/daily/generate
  if (url.pathname === "/api/daily/generate" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { since, modelTier } = body as { since?: string; modelTier?: "high" | "low" | "exact" };

    if (!since) {
      json(response, 400, { error: "缺少 since 参数" });
      return true;
    }

    // 标记新一轮生成开始
    const newGenAt = await markDailyGenStart();

    // 获取变更会话
    const changed = await getChangedSessionsSince(since, sessionManager);

    // 启动异步生成
    const runId = `daily_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    void generateDailyReport(runId, since, newGenAt, changed, modelTier ?? "low");

    json(response, 202, { runId, status: "generating", message: "日报生成已启动，请轮询状态" });
    return true;
  }

  return false;
}

async function generateDailyReport(
  runId: string,
  since: string,
  genAt: string,
  changed: Awaited<ReturnType<typeof getChangedSessionsSince>>,
  modelTier: "high" | "low" | "exact",
) {
  try {
    // 读取日报生成 Prompt 模板
    const promptTemplate = await loadDailyPromptTemplate();

    // 构建输入
    const input = buildDailyPrompt(promptTemplate, since, changed);

    // 创建低成本模型客户端
    const lowCostClient = createOpenAICompatibleModelClient({ tier: modelTier });

    // 调用模型生成日报
    const result = await lowCostClient.run(input, {
      systemPrompt: "你是专业的日报生成助手，擅长从会话变更中提炼关键进展，生成结构化日报。",
      topic: "日报生成",
      workDir: process.cwd(),
      tracePath: undefined,
      sessionId: null,
      runId,
      matchedSkills: [],
      requestKind: "chat",
    });

    // 保存生成结果到 daily 存储
    await saveDailyReport(genAt, result.output);

    console.log(`[DailyGen] ${runId} completed`);
  } catch (error) {
    console.error(`[DailyGen] ${runId} failed:`, error);
  }
}

async function loadDailyPromptTemplate(): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const templatePath = path.join(process.cwd(), "prompts", "daily-generation.md");
  try {
    return await fs.readFile(templatePath, "utf8");
  } catch {
    // 内置默认模板
    return `# 日报生成指令

你是专业的日报生成助手。根据提供的会话变更数据，生成结构化的日报。

## 输入数据
- since: {since}（上次日报生成开始时间）
- newSessions: 新建的会话列表
- changedSessions: 发生变更的会话列表，含变更 turn 区间与内容片段

## 输出格式（Markdown）
### {date} 日报

#### 上午 (08:00-12:00)
- **会话名称** (&ses_xxx): 一句话摘要。变更位置：turns X-Y

#### 下午 (14:00-18:00)
...

#### 晚上 (20:00-24:00)
...

## 要求
1. 按时段分组（凌晨/上午/下午/晚上），按会话最后消息时间归属
2. 每条必须包含会话链接 &ses_xxx
3. 变更会话必须标注变更 turn 区间
4. 语言简洁专业，避免冗余`;
  }
}

function buildDailyPrompt(template: string, since: string, changed: Awaited<ReturnType<typeof getChangedSessionsSince>>): string {
  const date = new Date().toLocaleDateString("zh-CN");
  const newSessionsText = changed.newSessions.length > 0
    ? changed.newSessions.map((s) => `- **${s.name}** (&ses_${s.id}): ${s.goal}`).join("\n")
    : "无";
  const changedSessionsText = changed.changedSessions.length > 0
    ? changed.changedSessions.map((s) => {
        const ranges = s.changedTurnRanges.map(([from, to]) => `turns ${from}-${to}`).join(", ");
        return `- **${s.name}** (&ses_${s.id}): ${s.snippet.split("\n")[0]}。变更位置：${ranges}`;
      }).join("\n")
    : "无";

  return template
    .replace(/{since}/g, since)
    .replace(/{date}/g, date)
    .replace(/{newSessions}/g, newSessionsText)
    .replace(/{changedSessions}/g, changedSessionsText);
}

async function saveDailyReport(date: string, content: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = path.join(process.cwd(), "memory", "dailies");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date.split("T")[0]}.md`);
  await fs.writeFile(file, content, "utf8");
}