import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { assessmentToSnake, evolutionProposalToSnake, reflectionToSnake } from "./casing.js";
import { LIKERT_LABELS } from "./config.js";
import { MomokaAgentCore, MomokaHttpError } from "./agent.js";
import type { ChatResponse, JudgeResponse, MomokaHttpHandler, RunRecord } from "./types.js";

export function createMomokaHttpHandler(agent: MomokaAgentCore): MomokaHttpHandler {
  return (request: IncomingMessage, response: ServerResponse) => {
    void route(agent, request, response);
  };
}

async function route(agent: MomokaAgentCore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/api/health") {
      send(response, 200, "MOMOKA OK", "text/plain; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      json(response, 200, {
        info: {
          provider: process.env.ALIYUN_API_KEY ? "DashScope" : (process.env.OPENAI_BASE_URL ?? "OpenAI"),
          key_prefix: `${(process.env.ALIYUN_API_KEY ?? process.env.OPENAI_API_KEY ?? "").slice(0, 8)}...`,
          skills_loaded: (await agent.skillRouter.listSkills()).length,
        },
        issues: process.env.ALIYUN_API_KEY || process.env.OPENAI_API_KEY
          ? []
          : ["ALIYUN_API_KEY not configured. Set ALIYUN_API_KEY or OPENAI_API_KEY."],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/skills") {
      json(response, 200, { skills: await agent.skillRouter.listSkills() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/memory") {
      json(response, 200, {
        daily: await agent.memoryStore.readDaily(7),
        long_term: (await agent.memoryStore.readLongTerm()).slice(0, 2000),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/directories") {
      json(response, 200, await agent.listDirectories(url.searchParams.get("path") ?? ""));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      json(response, 200, { sessions: (await agent.sessionManager.listSessions()).map(sessionToSnake) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonBody(request);
      const session = await agent.createSession(String(body.goal ?? ""), String(body.folder_path ?? ""));
      json(response, 200, { session: sessionToSnake(session) });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
    if (sessionMatch && request.method === "GET" && sessionMatch[2] === "/messages") {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      if (!await agent.sessionManager.getSession(sessionId)) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      json(response, 200, { messages: await agent.sessionManager.getMessages(sessionId) });
      return;
    }
    if (sessionMatch && request.method === "GET") {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      const session = await agent.sessionManager.getSession(sessionId);
      if (!session) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      json(response, 200, { session: sessionToSnake(session) });
      return;
    }
    if (sessionMatch && request.method === "DELETE") {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      if (!await agent.sessionManager.deleteSession(sessionId)) {
        throw new MomokaHttpError(404, `Unknown session: ${sessionId}`);
      }
      json(response, 200, { success: true });
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && request.method === "GET") {
      const runId = decodeURIComponent(runMatch[1] ?? "");
      const run = await agent.getRun(runId);
      if (!run) {
        throw new MomokaHttpError(404, `Unknown run_id: ${runId}`);
      }
      json(response, 200, runToSnake(run));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/approvals") {
      const workspace = url.searchParams.get("work_dir") ?? "";
      json(response, 200, { approvals: await agent.listApprovals(workspace) });
      return;
    }
    const approvalDecisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (request.method === "POST" && approvalDecisionMatch) {
      const body = await readJsonBody(request);
      const decision = body.decision;
      if (decision !== "approved" && decision !== "rejected") {
        throw new MomokaHttpError(400, "Decision must be approved or rejected");
      }
      const operator = typeof body.operator === "string" ? body.operator : "";
      if (!operator.trim()) throw new MomokaHttpError(400, "Approval operator is required");
      const workspace = typeof body.work_dir === "string" ? body.work_dir : "";
      const outcome = await agent.decideApproval(workspace, decodeURIComponent(approvalDecisionMatch[1] ?? ""), decision, operator);
      json(response, 200, outcome);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(request);
      const result = await agent.chat({
        message: String(body.message ?? ""),
        sessionId: typeof body.session_id === "string" ? body.session_id : null,
        outputId: typeof body.output_id === "string" ? body.output_id : undefined,
        topic: typeof body.topic === "string" ? body.topic : undefined,
        workDir: typeof body.work_dir === "string" ? body.work_dir : undefined,
      });
      json(response, 200, chatToSnake(result));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/judge") {
      const body = await readJsonBody(request);
      const result = await agent.judge({
        outputId: String(body.output_id ?? ""),
        score: Number(body.score ?? 0),
        context: typeof body.context === "string" ? body.context : "",
        comment: typeof body.comment === "string" ? body.comment : "",
        continue: Boolean(body.continue),
      });
      json(response, 200, judgeToSnake(result));
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (await serveStatic(agent.projectRoot, url.pathname, response, request.method === "HEAD")) {
        return;
      }
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof MomokaHttpError) {
      json(response, error.statusCode, { error: error.message, ...error.details });
      return;
    }
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function serveStatic(projectRoot: string, urlPathname: string, response: ServerResponse, headOnly: boolean): Promise<boolean> {
  const staticRoot = path.join(projectRoot, "static");
  const decoded = decodeURIComponent(urlPathname);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
  const candidate = path.resolve(staticRoot, relativePath);
  const relative = path.relative(staticRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const fileStats = await stat(candidate).catch(() => null);
  const filePath = fileStats?.isDirectory() ? path.join(candidate, "index.html") : candidate;
  const finalStats = await stat(filePath).catch(() => null);
  if (!finalStats?.isFile()) {
    return false;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store",
  });
  if (headOnly) {
    response.end();
  } else {
    response.end(await readFile(filePath));
  }
  return true;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new MomokaHttpError(400, "Request body must be JSON");
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, `${JSON.stringify(payload)}\n`, "application/json; charset=utf-8");
}

function send(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function chatToSnake(payload: ChatResponse): Record<string, unknown> {
  return {
    run_id: payload.runId,
    output_id: payload.outputId,
    topic: payload.topic,
    response: payload.response,
    annotation_runtime_context: payload.annotationRuntimeContext,
    output_assessment: assessmentToSnake(payload.outputAssessment),
    tool_calls: payload.toolCalls,
    matched_skills: payload.matchedSkills,
    skill_reasons: payload.skillReasons,
    session_id: payload.sessionId ?? null,
  };
}

function judgeToSnake(payload: JudgeResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {
    run_id: payload.runId,
    output_id: payload.outputId,
    score: payload.score,
    label: payload.label,
    analysis: payload.analysis,
    reflection: reflectionToSnake(payload.reflection),
    annotated_text: payload.annotatedText,
    comment: payload.comment,
    preference_update: payload.preferenceUpdate,
    evolution_proposals: payload.evolutionProposals.map(evolutionProposalToSnake),
  };
  if (payload.nextOutputId) {
    out.next_output_id = payload.nextOutputId;
    out.next_response = payload.nextResponse;
    out.next_annotation_runtime_context = payload.nextAnnotationRuntimeContext;
    out.next_output_assessment = payload.nextOutputAssessment
      ? assessmentToSnake(payload.nextOutputAssessment)
      : undefined;
    out.next_tool_calls = payload.nextToolCalls ?? [];
    out.next_skill_reasons = payload.nextSkillReasons ?? [];
  }
  return out;
}

function runToSnake(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    kind: run.kind,
    session_id: run.sessionId,
    output_id: run.outputId,
    response: run.response,
    created_at: run.createdAt,
    state: run.state,
  };
}

function sessionToSnake(session: {
  id: string;
  name: string;
  goal: string;
  folderPath: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string;
}): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    goal: session.goal,
    folder_path: session.folderPath,
    created_at: session.createdAt,
    message_count: session.messageCount,
    last_message_at: session.lastMessageAt,
  };
}

export { LIKERT_LABELS };
