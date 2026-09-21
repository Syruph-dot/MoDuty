import type { IncomingMessage, ServerResponse } from "node:http";

import { MomokaHttpError } from "../http-error.js";
import { DISPATCHER_SYSTEM_PROMPT } from "../agent-registry.js";
import { buildAgentRelations } from "../agent-relations.js";
import { buildDispatchTaskMessage } from "../dispatch-message.js";
import { matchStateFilter, sortDispatchViews, toDispatchView } from "../dispatch-view.js";
import type { DispatchEntryState } from "../dispatch-ledger.js";
import type { AgentRecord, StreamEvent } from "../types.js";
import { corsHeaders, json, readJsonBody, sseData } from "./http-utils.js";
import { ensureAgents, requireAgent, type RouteContext } from "./route-context.js";
import { driveAgentTurn, driveQuestionAnswered, handleDispatchBridge, orchestrationOf } from "./agent-orchestration.js";
import { abortChatStreamByAgent, registerChatStream, unregisterChatStream } from "./chat-streams.js";
import { agentToSnake, chatToSnake } from "./serialization.js";

/**
 * Agent 轨道路由（MOMOKA Agent Desktop）：注册表 CRUD、消息读取、
 * /api/agents/events SSE、/api/agents/:id/chat 流式对话，以及旧轨道数据的
 * 清理入口（legacy-sessions）。
 */
export async function handleAgentRoutes(
  ctx: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const agent = ctx.agent;

  if (request.method === "GET" && url.pathname === "/api/agents/events") {
    ensureAgents(ctx);
    ctx.broadcaster.open(response);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    const runtime = ensureAgents(ctx);
    const records = await runtime.registry.listAgents();
    const agents = [];
    for (const record of records) {
      agents.push(agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)));
    }
    json(response, 200, { agents });
    return true;
  }

  // 孤儿 session（旧 chat.html 时代残留）—— 数据级清理入口，无 UI
  const legacyMatch = url.pathname.match(/^\/api\/agents\/legacy-sessions$/);
  if (legacyMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    json(response, 200, { sessions: await runtime.registry.listLegacySessions() });
    return true;
  }
  if (legacyMatch && request.method === "DELETE") {
    const runtime = ensureAgents(ctx);
    json(response, 200, { removed: await runtime.registry.cleanupLegacySessions() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/agents") {
    const runtime = ensureAgents(ctx);
    const body = await readJsonBody(request);
    // name 可选：留空表示“自动生成”（首条对话后按标题回填）；role 与 workspace_dir 允许空，
    // 由 registry 补默认 system prompt / 默认 workspace。
    const name = String(body.name ?? "").trim();
    const role = String(body.system ?? body.role ?? "").trim();
    const workspaceDir = String(body.workspace_dir ?? "").trim();
    // 角色扮演人格 slug（可选）：对应 prompts/roleplay/<slug>.md，缺省则回落全局 prompts/ROLEPLAY.md
    const roleplay = String(body.roleplay ?? "").trim();
    const kind = body.kind === "dispatcher" || body.kind === "worker" ? (body.kind as "dispatcher" | "worker") : undefined;
    // 值日生唯一化：dispatcher（或重名"值日生"）已存在时复用现有记录，不创建第二个
    if (kind === "dispatcher") {
      const existing = await runtime.registry.findDispatcher();
      if (existing) {
        json(response, 200, { agent: agentToSnake(existing, await agent.sessionManager.getSession(existing.sessionId)), reused: true });
        return true;
      }
    }
    // 值日生单源：kind=dispatcher 的 Agent 忽略前端传入的 system，一律使用后端 DISPATCHER 常量，避免双源漂移。
    const effectiveRole = kind === "dispatcher" ? DISPATCHER_SYSTEM_PROMPT : role;
    const record = await runtime.registry.createAgent({
      name,
      role: effectiveRole,
      workspaceDir,
      model: typeof body.model === "string" ? body.model : undefined,
      kind,
      roleplay,
    });
    runtime.machine.seed(record.id, record.state, record.phase);
    json(response, 200, { agent: agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)) });
    return true;
  }

  const agentMessagesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
  if (agentMessagesMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMessagesMatch[1] ?? ""));
    json(response, 200, { messages: await agent.sessionManager.getMessages(record.sessionId) });
    return true;
  }

  // 桌面问答：拉取某 Agent 的待答问题集（RequiringInput 状态时磁贴/窗口调用）
  const agentQuestionsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/questions$/);
  if (agentQuestionsMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentQuestionsMatch[1] ?? ""));
    // 缺省只回待答（值日生页只关心“待老师拍板”）；?include=answered 额外回最近已答，供会话里的问答卡回看
    const includeAnswered = url.searchParams.get("include") === "answered";
    const rawLimit = Number(url.searchParams.get("answeredLimit") ?? "");
    const answeredLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : undefined;
    json(response, 200, {
      questions: includeAnswered
        ? await runtime.registry.questionsForAgent(record.id, answeredLimit)
        : await runtime.registry.pendingQuestionsForAgent(record.id),
    });
    return true;
  }

  // 提交答案：把答案以 user 消息写入会话（resume 历史完整）→ 驱动状态机脱离 requiring_input → 续跑
  const questionAnswerMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/questions\/([^/]+)\/answer$/);
  if (questionAnswerMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(questionAnswerMatch[1] ?? ""));
    const setId = decodeURIComponent(questionAnswerMatch[2] ?? "");
    const body = await readJsonBody(request) as { answers?: Array<{ questionIndex?: unknown; choiceIndex?: unknown; customText?: unknown }> };
    const raw = Array.isArray(body.answers) ? body.answers : [];
    const answers = raw.map((item) => ({
      questionIndex: Number(item.questionIndex ?? 0),
      choiceIndex: Number(item.choiceIndex ?? -1),
      ...(typeof item.customText === "string" ? { customText: item.customText } : {}),
    }));
    const set = await runtime.registry.answerQuestionSet(setId, answers);
    if (!set) throw new MomokaHttpError(409, "Question set not found or already answered");
    // 把问答摘要写入会话（user 角色）：后续 resume chat 会读到这些历史
    const lines = set.questions.map((question, index) => {
      const answer = answers.find((item) => item.questionIndex === index);
      const chosen = answer && answer.choiceIndex >= 0 && answer.choiceIndex < question.options.length
        ? question.options[answer.choiceIndex]
        : answer?.customText?.trim() ?? "（未作答）";
      return `Q${index + 1}: ${question.prompt}\n  答案: ${chosen}`;
    });
    await agent.sessionManager.addMessage(record.sessionId, "user", `用户对提问的回答：\n${lines.join("\n")}`);
    // Agent 联动：确认即执行（载荷流）或旧行为（续跑）
    const deps = orchestrationOf(ctx);
    const action = set.dispatch;
    const primaryAnswer = answers.find((item) => item.questionIndex === 0);
    const autoDispatchable =
      Boolean(action) &&
      set.questions.length === 1 &&
      Boolean(primaryAnswer) &&
      (primaryAnswer?.choiceIndex === 0 || primaryAnswer?.choiceIndex === 1);

    if (action && autoDispatchable) {
      // 确认即执行（2026-09-19 小微调拍板）：老师作答 → 系统自动派发，值日生不再消耗一轮 LLM。
      // 挂起态收尾：requiring_input → running → completed
      deps.machine.answerReceived(record.id);
      deps.machine.complete(record.id);
      const reuse = primaryAnswer?.choiceIndex === 0;
      try {
        let executorId = action.targetId;
        let executorLabel = action.targetId;
        if (!reuse) {
          if (!action.newName) throw new Error("载荷缺少 newName，无法自动新建执行者");
          const created = await runtime.registry.createAgent({ name: action.newName, role: "", workspaceDir: "" });
          runtime.machine.seed(created.id, created.state, created.phase);
          executorId = created.id;
          executorLabel = `${created.id}「${created.name}」`;
        }
        const result = await handleDispatchBridge(deps, {
          kind: "dispatch",
          executorId,
          task: action.task,
          confirm: reuse ? set.id : undefined,
          callerSessionId: set.sessionId,
        });
        if (!result.ok) throw new Error(result.output);
        // 留痕：区分“确认的候选”与“实际派发的执行者”（新建分支两者不同）
        await agent.sessionManager.addMessage(
          record.sessionId,
          "system",
          `【自动派发】老师已确认${reuse ? "复用" : "新建"}，实际派发给 ${executorLabel}（台账 ${result.dispatchId}）。执行者完成/出错/停转后系统会唤醒你判读。`,
        );
        json(response, 200, { success: true, question: set, autoDispatched: true, dispatchId: result.dispatchId });
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await agent.sessionManager.addMessage(
          record.sessionId,
          "system",
          `【自动派发失败】${reason.slice(0, 200)}。请按老师的选择手动完成派发。`,
        );
        // 失败回落：恢复旧续跑路径，让值日生自行处理
        void driveQuestionAnswered(deps, record).catch((err: unknown) => {
          console.error("[question] 自动派发失败回落续跑异常:", err);
        });
        json(response, 200, { success: true, question: set, autoDispatched: false });
        return true;
      }
    }

    // 无载荷（旧式提问）：答案已写入会话，续跑由值日生自主处理
    void driveQuestionAnswered(deps, record).catch((error: unknown) => {
      console.error("[question] 答案后驱失败:", error);
    });
    json(response, 200, { success: true, question: set });
    return true;
  }

  // 调度台账只读视图（值日生窗口的右栏数据源）：过滤 + 补执行者信息 + 截断 + 排序。
  // 台账 DispatchRecord 是唯一事实源，这里不改任何状态。
  if (request.method === "GET" && url.pathname === "/api/dispatches") {
    const { registry } = ensureAgents(ctx);
    const stateFilter = url.searchParams.get("state");
    const dispatcherId = url.searchParams.get("dispatcherId");
    const targetAgentId = url.searchParams.get("targetAgentId");
    const records = await registry.dispatches.listAll();
    const filtered = records.filter(
      (record) =>
        matchStateFilter(record.state as DispatchEntryState, stateFilter) &&
        (!dispatcherId || record.dispatcherId === dispatcherId) &&
        (!targetAgentId || record.targetAgentId === targetAgentId),
    );
    // 执行者信息按 id 去重查一次（同一执行者可能有多条历史派发）
    const targets = new Map<string, Awaited<ReturnType<typeof registry.getAgent>>>();
    for (const record of filtered) {
      if (targets.has(record.targetAgentId)) continue;
      targets.set(record.targetAgentId, await registry.getAgent(record.targetAgentId));
    }
    const views = sortDispatchViews(
      filtered.map((record) => {
        const target = targets.get(record.targetAgentId) ?? null;
        return toDispatchView(
          record,
          target
            ? {
                id: target.id,
                name: target.name,
                sessionId: target.sessionId,
                state: target.state,
                phase: target.phase ?? null,
              }
            : null,
        );
      }),
    );
    json(response, 200, { dispatches: views, total: views.length });
    return true;
  }

  // 窗口标签页条的数据源：出边（下属 = 引用过的人 + 派发过的人 + 浏览器）与入边（上级）。
  // 只读：不改任何状态；关系判定见 src/agent-relations.ts。
  const agentRelationsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/relations$/);
  if (agentRelationsMatch && request.method === "GET") {
    const { registry } = ensureAgents(ctx);
    const agentId = decodeURIComponent(agentRelationsMatch[1] ?? "");
    const relations = await buildAgentRelations({ agentId, registry, sessionManager: ctx.agent.sessionManager });
    if (!relations) throw new MomokaHttpError(404, `Unknown agent: ${agentId}`);
    json(response, 200, { relations });
    return true;
  }

  // 结构化派发（A5）：任务书 + 可选复用凭证 → 台账建条目 + 驱动执行者。
  // 本地受信 API（run_momoka_cli 进程内拦截之外给 CLI/外部工具的同口径入口）。
  const agentDispatchMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/dispatch$/);
  if (agentDispatchMatch && request.method === "POST") {
    ensureAgents(ctx);
    const executorId = decodeURIComponent(agentDispatchMatch[1] ?? "");
    const body = await readJsonBody(request) as { task?: unknown; confirm?: unknown; dispatcherSessionId?: unknown };
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) throw new MomokaHttpError(400, "task is required");
    const callerSessionId = typeof body.dispatcherSessionId === "string" ? body.dispatcherSessionId : "";
    if (!callerSessionId) throw new MomokaHttpError(400, "dispatcherSessionId is required");
    const deps = orchestrationOf(ctx);
    const result = await handleDispatchBridge(deps, {
      kind: "dispatch",
      executorId,
      task,
      confirm: typeof body.confirm === "string" ? body.confirm : undefined,
      callerSessionId,
    });
    json(response, result.ok ? 200 : 422, { success: result.ok, dispatchId: result.dispatchId, message: result.output });
    return true;
  }

  const agentChatMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
  if (agentChatMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentChatMatch[1] ?? ""));
    const body = await readJsonBody(request);
    const message = String(body.message ?? "").trim();
    if (!message) {
      throw new MomokaHttpError(400, "Message cannot be empty");
    }
    await streamAgentChat(ctx, response, record, message);
    return true;
  }

  // 显式取消该 agent 的活跃 chat 流（前端停止按钮调用）
  const agentChatCancelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat\/cancel$/);
  if (agentChatCancelMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentChatCancelMatch[1] ?? ""));
    const cancelled = abortChatStreamByAgent(record.id);
    json(response, 200, { cancelled });
    return true;
  }

  // 显式复位（窗口"重试"第一步）：error / waiting_approval / completed → idle；running 不动。
  const agentChatResetMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat\/reset$/);
  if (agentChatResetMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentChatResetMatch[1] ?? ""));
    runtime.machine.reset(record.id); // 转移经 wireAgentStatePersistence 自动落盘 state=idle
    json(response, 200, { success: true });
    return true;
  }

  // 分发文件给 Agent（Shell verb 桥进程调用）：接收文件路径列表 + 指令，写入会话并触发 chat
  const dispatchFilesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/dispatch-files$/);
  if (dispatchFilesMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(dispatchFilesMatch[1] ?? ""));
    const body = await readJsonBody(request) as { files?: unknown[]; message?: unknown };
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    const message = typeof body.message === "string" ? body.message : "";
    if (files.length === 0) {
      throw new MomokaHttpError(400, "files array is required");
    }
    // 构造任务书：全部路径逐行加引号 + 用户指令（一次选择 = 一条消息）
    const taskMessage = buildDispatchTaskMessage(files, message);
    await agent.sessionManager.addMessage(record.sessionId, "user", taskMessage);
    // 异步触发 chat（不阻塞响应）：右键菜单进来的是“全新任务”，驱动话术 transient 注入
    //（不落历史）；任务书本身已在上一行落盘。
    const deps = orchestrationOf(ctx);
    void driveAgentTurn(deps, record, {
      message:
        "用户刚刚通过资源管理器右键菜单发来了一条新的任务，内容就是上一条消息（文件路径列表 + 用户指示）。" +
        "请把它当作全新的用户指令：直接按这条消息里的路径和指示执行，" +
        "不要沿用、重复或继续之前对话中的旧任务；也不要再向用户复述任务内容。",
      transient: true,
    }).catch((error: unknown) => {
      console.error("[dispatch-files] 驱动失败:", error);
    });
    json(response, 200, { success: true, filesCount: files.length, message: "已分发给 Agent" });
    return true;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
    json(response, 200, {
      agent: agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)),
      messages: await agent.sessionManager.getMessages(record.sessionId),
    });
    return true;
  }
  if (agentMatch && request.method === "PUT") {
    const runtime = ensureAgents(ctx);
    let record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
    const body = await readJsonBody(request);
    // 本次是否携带 roleplay（人格 slug）字段：携带时允许只改人格，不带 name
    const hasRoleplay = Object.prototype.hasOwnProperty.call(body, "roleplay");
    const hasCapabilities = Object.prototype.hasOwnProperty.call(body, "capabilities");
    const newName = String(body.name ?? "").trim();
    if (!newName && !hasRoleplay && !hasCapabilities) {
      throw new MomokaHttpError(400, "name is required");
    }
    if (newName) {
      record = await runtime.registry.renameAgent(record.id, newName);
    }
    if (hasRoleplay) {
      const slug = body.roleplay == null ? "" : String(body.roleplay).trim();
      const updated = await runtime.registry.updateAgentRoleplay(record.id, slug || null);
      if (!updated) throw new MomokaHttpError(404, "Agent not found");
      record = updated;
    }
    // 能力标签（P9）：允许单独更新，供 DAG 编排做能力匹配
    if (Object.prototype.hasOwnProperty.call(body, "capabilities")) {
      const list = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
      const updated = await runtime.registry.updateAgentCapabilities(record.id, list);
      if (!updated) throw new MomokaHttpError(404, "Agent not found");
      record = updated;
    }
    json(response, 200, { agent: agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)) });
    return true;
  }
  if (agentMatch && request.method === "DELETE") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentMatch[1] ?? ""));
    await runtime.registry.deleteAgent(record.id);
    runtime.machine.drop(record.id);
    json(response, 200, { success: true });
    return true;
  }

  // 截断会话消息：从指定 messageId 开始删除后续消息（用于原地编辑分叉）
  const truncateMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages\/truncate$/);
  if (truncateMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(truncateMatch[1] ?? ""));
    const body = await readJsonBody(request) as { messageId?: unknown };
    const messageId = typeof body.messageId === "string" ? body.messageId : "";
    if (!messageId) {
      throw new MomokaHttpError(400, "messageId is required");
    }
    const truncated = await agent.sessionManager.truncateMessages(record.sessionId, messageId);
    json(response, 200, { success: true, messages: truncated });
    return true;
  }

  // Agent 归档/取消归档
  const agentArchiveMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/archive$/);
  if (agentArchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentArchiveMatch[1] ?? ""));
    const archived = await runtime.registry.archiveAgent(record.id);
    if (!archived) throw new MomokaHttpError(404, "Agent not found");
    json(response, 200, { success: true, agent: agentToSnake(archived, await agent.sessionManager.getSession(archived.sessionId)) });
    return true;
  }
  const agentUnarchiveMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/unarchive$/);
  if (agentUnarchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentUnarchiveMatch[1] ?? ""));
    const unarchived = await runtime.registry.unarchiveAgent(record.id);
    if (!unarchived) throw new MomokaHttpError(404, "Agent not found");
    json(response, 200, { success: true, agent: agentToSnake(unarchived, await agent.sessionManager.getSession(unarchived.sessionId)) });
    return true;
  }

  // System Prompt (Role) 获取/更新
  const agentRoleMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/role$/);
  if (agentRoleMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentRoleMatch[1] ?? ""));
    json(response, 200, { role: record.role });
    return true;
  }
  if (agentRoleMatch && request.method === "PUT") {
    const runtime = ensureAgents(ctx);
    const record = await requireAgent(runtime.registry, decodeURIComponent(agentRoleMatch[1] ?? ""));
    const body = await readJsonBody(request) as { role?: unknown };
    const role = typeof body.role === "string" ? body.role : "";
    if (!role.trim()) {
      throw new MomokaHttpError(400, "role is required");
    }
    const updated = await runtime.registry.updateAgentRole(record.id, role);
    if (!updated) throw new MomokaHttpError(404, "Agent not found");
    json(response, 200, { success: true, agent: agentToSnake(updated, await agent.sessionManager.getSession(updated.sessionId)) });
    return true;
  }

  // Session 归档/取消归档
  const sessionArchiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if (sessionArchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const archived = await agent.sessionManager.archiveSession(decodeURIComponent(sessionArchiveMatch[1] ?? ""));
    if (!archived) throw new MomokaHttpError(404, "Session not found");
    json(response, 200, { success: true, session: archived });
    return true;
  }
  const sessionUnarchiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/unarchive$/);
  if (sessionUnarchiveMatch && request.method === "POST") {
    const runtime = ensureAgents(ctx);
    const unarchived = await agent.sessionManager.unarchiveSession(decodeURIComponent(sessionUnarchiveMatch[1] ?? ""));
    if (!unarchived) throw new MomokaHttpError(404, "Session not found");
    json(response, 200, { success: true, session: unarchived });
    return true;
  }

  // 获取指定 turn 或 turn 区间（用于会话内跳转定位）
  const turnMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/(\d+)(?:\/(\d+))?$/);
  if (turnMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const sessionId = decodeURIComponent(turnMatch[1] ?? "");
    const from = parseInt(turnMatch[2] ?? "1", 10);
    const to = turnMatch[3] ? parseInt(turnMatch[3], 10) : from;
    const content = await agent.sessionManager.readSessionTranscript(sessionId, from, to);
    json(response, 200, { sessionId, from, to, content });
    return true;
  }

  // Transcript 多格式导出（JSON/MD/TXT），内容体较大直接返回字符串，由前端下载为文件
  const sessionExportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
  if (sessionExportMatch && request.method === "GET") {
    const runtime = ensureAgents(ctx);
    const sessionId = decodeURIComponent(sessionExportMatch[1] ?? "");
    const existing = await agent.sessionManager.getSession(sessionId);
    if (!existing) throw new MomokaHttpError(404, "Session not found");
    const formatParam = String(url.searchParams.get("format") ?? "md");
    const format = formatParam === "json" || formatParam === "txt" ? formatParam : "md";
    const exported = await agent.sessionManager.exportSession(sessionId, format);
    json(response, 200, exported);
    return true;
  }

  // 列表包含归档项
  if (request.method === "GET" && url.pathname === "/api/agents" && url.searchParams.get("include_archived") === "true") {
    const runtime = ensureAgents(ctx);
    const records = await runtime.registry.listAllAgents(true);
    const agents = [];
    for (const record of records) {
      agents.push(agentToSnake(record, await agent.sessionManager.getSession(record.sessionId)));
    }
    json(response, 200, { agents });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/sessions" && url.searchParams.get("include_archived") === "true") {
    const runtime = ensureAgents(ctx);
    const sessions = await agent.sessionManager.listAllSessions(true);
    json(response, 200, { sessions });
    return true;
  }

  return false;
}

/**
 * /api/agents/:id/chat：SSE 流式薄壳。终点处理（complete/fail/cancel + pending 挂起）
 * 全部在统一驱动器 driveAgentTurn 内；这里只负责 SSE 转发与连接生命周期。
 */
async function streamAgentChat(
  ctx: RouteContext,
  response: ServerResponse,
  record: AgentRecord,
  message: string,
): Promise<void> {
  const deps = orchestrationOf(ctx);
  const startedAt = Date.now(); // 运行耗时：无论正常结束/异常/取消都记一次
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...corsHeaders(),
  });
  const controller = new AbortController();
  const streamId = `chat-${record.id}-${Date.now()}`;
  registerChatStream(streamId, { agentId: record.id, controller, response });
  // 连接只是在线投影：agent 输出已由 agent.chat 流式写入会话日志，
  // 客户端断开/收起磁贴**不中止任务**（任务与连接解耦）。
  // 显式停止走 POST /api/agents/:id/chat/cancel（abort）或服务退出。
  // 任务结束（finally）时才从注册表移除，保证 cancel/退出仍能找到它。
  try {
    const result = await driveAgentTurn(deps, record, {
      message,
      onEvent: (event) => sseData(response, event),
      signal: controller.signal,
    });
    sseData(response, { type: "done", ...chatToSnake(result.response) });
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      // 显式停止由驱动器记 cancel（无 error 帧）；其余失败已记 fail，这里补 error 帧
      sseData(response, { type: "error", error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    unregisterChatStream(streamId);
    // 记录本次运行耗时（不阻塞响应；写队列串行落盘）
    void deps.registry.updateLastRun(record.id, Date.now() - startedAt).catch(() => undefined);
    try {
      response.end();
    } catch {
      // 响应已关闭，忽略
    }
  }
}
