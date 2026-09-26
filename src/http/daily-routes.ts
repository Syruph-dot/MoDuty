import type { IncomingMessage, ServerResponse } from "node:http";
import { readDailyGenMeta, markDailyGenStart, markDailyGenComplete, restoreDailyGenStart, getChangedSessionsSince } from "../daily-meta.js";
import type { RouteContext } from "./route-context.js";
import { json, readJsonBody, corsHeaders } from "./http-utils.js";
import { createOpenAICompatibleModelClient } from "../model-client.js";

interface DailyRunStatus {
  runId: string;
  status: "generating" | "completed" | "failed";
  generatedAt: string;
  reportDate: string;
  since: string;
  error?: string;
}

const dailyRuns = new Map<string, DailyRunStatus>();

function storeDailyRun(run: DailyRunStatus): void {
  dailyRuns.set(run.runId, run);
  while (dailyRuns.size > 100) {
    const oldest = dailyRuns.keys().next().value as string | undefined;
    if (!oldest) break;
    dailyRuns.delete(oldest);
  }
}

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

  const dailyRunMatch = url.pathname.match(/^\/api\/daily\/runs\/([A-Za-z0-9_-]+)$/u);
  if (dailyRunMatch && request.method === "GET") {
    const run = dailyRuns.get(dailyRunMatch[1] ?? "");
    if (!run) {
      json(response, 404, { error: "日报生成任务不存在或已过期" });
      return true;
    }
    json(response, 200, run);
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

    if (!since || !Number.isFinite(new Date(since).getTime())) {
      json(response, 400, { error: "since 必须是有效的 ISO 时间戳" });
      return true;
    }

    // 获取变更会话
    const changed = await getChangedSessionsSince(since, sessionManager);

    // 记录本轮触发时间；后续日报仍按显式 since 快照生成。
    const newGenAt = await markDailyGenStart();

    // 启动异步生成
    const runId = `daily_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const run: DailyRunStatus = {
      runId,
      status: "generating",
      generatedAt: newGenAt,
      reportDate: newGenAt.slice(0, 10),
      since,
    };
    storeDailyRun(run);
    void generateDailyReport(runId, since, newGenAt, changed, modelTier ?? "low").then(() => {
      storeDailyRun({ ...run, status: "completed" });
    }).catch(async (error: unknown) => {
      await restoreDailyGenStart(newGenAt, since).catch(() => undefined);
      storeDailyRun({
        ...run,
        status: "failed",
        error: error instanceof Error ? error.message : "日报生成失败",
      });
    });

    json(response, 202, { ...run, message: "日报生成已启动，可查询任务状态" });
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
    const requiredSections = ["# ", "## 凌晨", "## 上午", "## 下午", "## 晚上"];
    const missingSections = requiredSections.filter((section) => !result.output.includes(section));
    if (missingSections.length > 0) {
      throw new Error(`日报模型输出缺少必需章节：${missingSections.join(", ")}；未写入日报文件。`);
    }

    // 保存生成结果到 daily 存储
    await saveDailyReport(genAt, result.output);
    await markDailyGenComplete();

    console.log(`[DailyGen] ${runId} completed`);
  } catch (error) {
    console.error(`[DailyGen] ${runId} failed:`, error);
    throw error;
  }
}

async function loadDailyPromptTemplate(): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const templatePath = path.join(process.cwd(), "prompts", "daily-generation.md");
  const template = await fs.readFile(templatePath, "utf8");
  if (!template.trim()) throw new Error(`日报提示词为空：${templatePath}`);
  return template;
}

function buildDailyPrompt(template: string, since: string, changed: Awaited<ReturnType<typeof getChangedSessionsSince>>): string {
  const date = new Date().toLocaleDateString("zh-CN");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const requiredPlaceholders = ["{since}", "{date}", "{timezone}", "{newSessions}", "{changedSessions}"];
  const missingPlaceholders = requiredPlaceholders.filter((placeholder) => !template.includes(placeholder));
  if (missingPlaceholders.length > 0) {
    throw new Error(`日报提示词缺少必需占位符：${missingPlaceholders.join(", ")}`);
  }
  const newSessionsText = changed.newSessions.length > 0
    ? changed.newSessions.map((s) => {
        const ranges = s.changedTurnRanges.map(([from, to]) => `turns ${from}-${to}`).join(", ") || "未知";
        return [
          `- **${s.name}** (&ses_${s.id})`,
          `  目标：${s.goal || "未提供"}`,
          `  创建时间：${s.createdAt}`,
          `  最后消息时间：${s.lastMessageAt || "未知"}`,
          `  变更 Turns：${ranges}`,
          `  新增内容摘录：${s.snippet || "无可用文本摘录"}${s.snippetTruncated ? "（摘录已达长度上限，未展示部分未知）" : ""}`,
        ].join("\n");
      }).join("\n")
    : "无";
  const changedSessionsText = changed.changedSessions.length > 0
    ? changed.changedSessions.map((s) => {
        const ranges = s.changedTurnRanges.map(([from, to]) => `turns ${from}-${to}`).join(", ") || "未知";
        return [
          `- **${s.name}** (&ses_${s.id})`,
          `  最后消息时间：${s.lastMessageAt || "未知"}`,
          `  变更 Turns：${ranges}`,
          `  新增内容摘录：${s.snippet || "无可用文本摘录"}${s.snippetTruncated ? "（摘录已达长度上限，未展示部分未知）" : ""}`,
        ].join("\n");
      }).join("\n")
    : "无";

  return template
    .replace(/{since}/g, since)
    .replace(/{date}/g, date)
    .replace(/{timezone}/g, timeZone)
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
