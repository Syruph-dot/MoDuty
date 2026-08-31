import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ApprovalStore, type ApprovalToolName, parseWhitelistedCommand } from "./approvals.js";
import { isFullyAutomatic } from "./permission-mode.js";
import { appendTraceEvent } from "./trace.js";
import { createSandboxShellRunner } from "./sandbox.js";
import { isSandboxEnabled } from "./settings.js";
import type { SessionManager } from "./session-manager.js";
import type { AgentRegistry } from "./agent-registry.js";

export interface WorkspaceManifest {
  name: string;
  readableDirs: string[];
  writableDirs: string[];
  env: string[];
  commandTimeoutMs: number;
  allowedShellStrategies: string[];
  /** 沙箱同步时排除的目录/文件（支持 `build-*` 前缀通配；默认已排除 .git/.omc/node_modules 等） */
  sandboxExcludes?: string[];
}

export const DEFAULT_WORKSPACE_MANIFEST: WorkspaceManifest = {
  name: "default",
  readableDirs: ["."],
  writableDirs: ["."],
  env: [],
  commandTimeoutMs: 120_000,
  allowedShellStrategies: ["parameterized"],
};

export function loadWorkspaceManifest(workDir?: string): WorkspaceManifest {
  if (workDir) {
    const manifestFile = path.join(path.resolve(workDir), "workspace-manifest.json");
    try {
      const content = readFileSync(manifestFile, "utf8");
      return { ...DEFAULT_WORKSPACE_MANIFEST, ...(JSON.parse(content) as Partial<WorkspaceManifest>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`无法加载工作区清单: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { ...DEFAULT_WORKSPACE_MANIFEST };
}

function isPathInDirs(targetPath: string, allowedDirs: string[], baseDir: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  for (const allowedDir of allowedDirs) {
    const allowedPath = path.resolve(baseDir, allowedDir);
    const relative = path.relative(allowedPath, resolvedTarget);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

function checkWorkspaceAccess(operation: "read" | "write", requestedPath: string, workDir: string, manifest: WorkspaceManifest): void {
  const baseDir = path.resolve(workDir);
  const allowedDirs = operation === "read" ? manifest.readableDirs : manifest.writableDirs;
  if (!isPathInDirs(requestedPath, allowedDirs, baseDir)) {
    throw new Error(`路径 '${requestedPath}' 不在 ${operation === "read" ? "可读" : "可写"} 目录清单中，已拒绝访问。`);
  }
}

function recordWorkspaceViolation(tracePath: string | undefined, operation: "read" | "write", requestedPath: string, workDir: string): void {
  if (tracePath) {
    appendTraceEvent(tracePath, "workspace_violation", {
      operation,
      requestedPath,
      workDir,
      timestamp: new Date().toISOString(),
    });
  }
}

export interface WorkspaceToolInput {
  workDir?: string;
  workspace?: string;
}

export function resolveWorkspacePath(workDir: string | undefined, requestedPath: string, operation: "read" | "write" = "read", tracePath?: string): string {
  if (!workDir) {
    throw new Error("未设置会话工作目录，文件操作已被禁用。");
  }
  const base = path.resolve(workDir);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(base, requestedPath);
  const relative = path.relative(base, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    // 基础 workDir 边界检查通过，继续检查 manifest
    const manifest = loadWorkspaceManifest(workDir);
    try {
      checkWorkspaceAccess(operation, candidate, workDir, manifest);
    } catch (error) {
      recordWorkspaceViolation(tracePath, operation, requestedPath, workDir);
      throw error;
    }
    return candidate;
  }
  throw new Error(`路径 '${requestedPath}' 超出了工作目录 '${base}' 的范围，已拒绝访问。`);
}

export interface ApprovalOrigin {
  sessionId?: string;
  runId?: string;
}

export async function readFileTool(input: WorkspaceToolInput & { path: string }, tracePath?: string): Promise<string> {
  try {
    const filePath = resolveWorkspacePath(input.workDir, input.path, "read", tracePath);
    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats) {
      return `错误：文件 '${input.path}' 不存在。`;
    }
    if (fileStats.isDirectory()) {
      return `错误：'${input.path}' 是一个目录，请指定文件路径。`;
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    return formatToolError(error, "读取文件失败");
  }
}

export async function writeFileTool(input: WorkspaceToolInput & { path: string; content: string }, tracePath?: string): Promise<string> {
  try {
    const filePath = resolveWorkspacePath(input.workDir, input.path, "write", tracePath);
    const existed = await stat(filePath).then(() => true, () => false);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.content, "utf8");
    const size = Buffer.byteLength(input.content, "utf8");
    return `${existed ? "覆盖写入" : "创建写入"}成功：'${input.path}' (${size} 字节)`;
  } catch (error) {
    return formatToolError(error, "写入文件失败");
  }
}

export async function appendFileTool(input: WorkspaceToolInput & { path: string; content: string }, tracePath?: string): Promise<string> {
  try {
    const filePath = resolveWorkspacePath(input.workDir, input.path, "write", tracePath);
    const existed = await stat(filePath).then(() => true, () => false);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, input.content, "utf8");
    const size = Buffer.byteLength(input.content, "utf8");
    return `${existed ? "追加写入" : "创建并写入"}成功：'${input.path}' (+${size} 字节)`;
  } catch (error) {
    return formatToolError(error, "追加写入失败");
  }
}

export async function listFilesTool(input: WorkspaceToolInput & { directory?: string }, tracePath?: string): Promise<string> {
  const directory = input.directory ?? ".";
  try {
    const dirPath = resolveWorkspacePath(input.workDir, directory, "read", tracePath);
    const dirStats = await stat(dirPath).catch(() => null);
    if (!dirStats) {
      return `错误：目录 '${directory}' 不存在。`;
    }
    if (!dirStats.isDirectory()) {
      return `错误：'${directory}' 不是目录。`;
    }
    const entries = await readdir(dirPath, { withFileTypes: true });
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    const lines = await Promise.all(sorted.map(async (entry) => {
      if (entry.isDirectory()) {
        return `  ${entry.name}/`;
      }
      try {
        const size = (await stat(path.join(dirPath, entry.name))).size;
        return `  ${entry.name} (${size} B)`;
      } catch {
        return `  ${entry.name}`;
      }
    }));
    return `目录 '${directory}' 包含 ${lines.length} 个项目：\n${lines.join("\n")}`;
  } catch (error) {
    return formatToolError(error, "列出目录失败");
  }
}

export function getCurrentTimeTool(): string {
  const now = new Date();
  const weekday = now.getDay();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日 ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} (星期${weekday})`;
}

export function runCommandEchoOnlyTool(input: { command: string }): string {
  return `Command preview only (not executed): ${input.command}`;
}

export async function runShellTool(
  input: WorkspaceToolInput & { command: string; tracePath?: string; approvalOrigin?: ApprovalOrigin },
  approvals = createDefaultApprovalStore(requireWorkspace(input.workDir)),
): Promise<string> {
  const workspace = requireWorkspace(input.workDir);
  if (!parseWhitelistedCommand(input.command)) {
    // 完全自动模式：非白名单命令直接放行执行（不再产生人工审批）
    if (isFullyAutomatic()) {
      try {
        const autoResult = await approvals.runApproved(input.command, workspace);
        return [autoResult.stdout, autoResult.stderr].filter(Boolean).join("\n") || `Command exited with code ${autoResult.code}`;
      } catch (error) {
        return formatToolError(error, "执行命令失败");
      }
    }
    // 白名单之外一律人工审批（测试期：不对语法/路径形式做硬拒绝）
    const approval = await approvals.request({
      targetWorkspace: workspace,
      toolName: "run_shell",
      args: { command: input.command },
      tracePath: input.tracePath,
      ...input.approvalOrigin,
    });
    return `Command pending approval: ${approval.id}`;
  }
  try {
    const result = await approvals.runWhitelisted(input.command);
    return [result.stdout, result.stderr].filter(Boolean).join("\n") || `Command exited with code ${result.code}`;
  } catch (error) {
    return formatToolError(error, "执行白名单命令失败");
  }
}

const TOOL_ARGUMENT_SCHEMAS = {
  get_current_time: z.object({}).strict(),
  read_file: z.object({ path: z.string().min(1), workspace: z.string().min(1).optional() }).strict(),
  write_file: z.object({ path: z.string().min(1), content: z.string(), workspace: z.string().min(1).optional() }).strict(),
  list_files: z.object({ directory: z.string().optional(), workspace: z.string().min(1).optional() }).strict(),
  append_file: z.object({ path: z.string().min(1), content: z.string(), workspace: z.string().min(1).optional() }).strict(),
  run_command_echo_only: z.object({ command: z.string().min(1) }).strict(),
  run_shell: z.object({ command: z.string().min(1), workspace: z.string().min(1).optional() }).strict(),
  inspect_session: z.object({ id: z.string().min(1) }).strict(),
  search_sessions: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(50).optional() }).strict(),
  read_session: z.object({ id: z.string().min(1), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }).strict(),
  search_content: z.object({ id: z.string().min(1).optional(), query: z.string().min(1) }).strict(),
  search_files: z.object({ query: z.string().min(1), scope: z.string().optional() }).strict(),
};

export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "返回当前日期和时间（北京时间）。不需要任何参数。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取会话工作目录内的文本文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          workspace: { type: "string", minLength: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "将内容写入会话工作目录内的文本文件（覆盖模式）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
          workspace: { type: "string", minLength: 1 },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出会话工作目录内指定子目录中的文件和子目录。",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string" },
          workspace: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_file",
      description: "向会话工作目录内的文本文件追加内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
          workspace: { type: "string", minLength: 1 },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command_echo_only",
      description: "Returns a command preview without executing it.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run an allow-listed command automatically (npm test / dir / pytest / rg / ls), or have any other command executed after human approval once an approval is granted.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", minLength: 1 }, workspace: { type: "string", minLength: 1 } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_session",
      description: "检视一个历史会话的元数据（标题/目标/主题/turn 数/时间范围）。把 &ses_<id> 或 &tile_<agentId> 当作资源句柄，不要整段读取。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", minLength: 1, description: "会话句柄：ses_<id> 或 tile_<agentId>" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_sessions",
      description: "跨会话检索，按相关度排序返回命中会话与匹配 turn 区间。用于在不读取全文的情况下定位相关历史。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "number", description: "返回上限，默认 5，最大 50" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_session",
      description: "读取指定会话的 turn 区间（from..to，1-based 闭区间）明文切片。只读相关片段，禁止全量后整段粘贴。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          from: { type: "number", description: "起始 turn（含），默认 1" },
          to: { type: "number", description: "结束 turn（含），默认末尾" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_content",
      description: "在会话 transcript 内按内容 grep（rg 侧）。id 省略时跨所有会话检索。返回命中行。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "可选：限定会话 ses_<id> / tile_<agentId>" },
          query: { type: "string", minLength: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "按文件名/路径检索工作目录下的文件（everything 侧）。返回匹配的相对路径列表。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          scope: { type: "string", description: "可选子目录范围" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeToolCall(
  name: string,
  rawArguments: string,
  workDir?: string,
  tracePath?: string,
  approvalOrigin?: ApprovalOrigin,
  sessionManager?: SessionManager,
  agentRegistry?: AgentRegistry,
): Promise<string> {
  const schema = TOOL_ARGUMENT_SCHEMAS[name as keyof typeof TOOL_ARGUMENT_SCHEMAS];
  if (!schema) {
    return `Error: unknown tool '${name}'.`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments) as unknown;
  } catch {
    return formatArgumentValidationMessage("expected valid JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return formatArgumentValidationMessage("expected a JSON object");
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return formatArgumentValidationError(validated.error);
  }
  const args = validated.data as Record<string, unknown>;
  if (name === "get_current_time") {
    return getCurrentTimeTool();
  }
  if (name === "run_command_echo_only") {
    return runCommandEchoOnlyTool({ command: String(args.command ?? "") });
  }
  const sourceWorkspace = requireWorkspace(workDir);
  const targetWorkspace = resolveTargetWorkspace(sourceWorkspace, typeof args.workspace === "string" ? args.workspace : undefined);
  const toolName = name as ApprovalToolName;
  if (isApprovalTool(toolName) && targetWorkspace !== sourceWorkspace) {
    return await deferCrossWorkspaceTool(toolName, args, sourceWorkspace, targetWorkspace, tracePath, approvalOrigin);
  }
  if (name === "read_file") {
    return await readFileTool({ workDir: targetWorkspace, path: String(args.path ?? "") }, tracePath);
  }
  if (name === "write_file") {
    return await writeFileTool({ workDir: targetWorkspace, path: String(args.path ?? ""), content: String(args.content ?? "") }, tracePath);
  }
  if (name === "list_files") {
    return await listFilesTool({ workDir: targetWorkspace, directory: typeof args.directory === "string" ? args.directory : "." }, tracePath);
  }
  if (name === "append_file") {
    return await appendFileTool({ workDir: targetWorkspace, path: String(args.path ?? ""), content: String(args.content ?? "") }, tracePath);
  }
  if (name === "inspect_session") {
    if (!sessionManager) return "错误：会话检索工具不可用（缺少 sessionManager）。";
    try {
      const sid = await resolveSessionId(String(args.id ?? ""), sessionManager, agentRegistry);
      return JSON.stringify(await sessionManager.inspectSession(sid));
    } catch (error) {
      return formatToolError(error, "检视会话失败");
    }
  }
  if (name === "search_sessions") {
    if (!sessionManager) return "错误：会话检索工具不可用（缺少 sessionManager）。";
    const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 5;
    try {
      return JSON.stringify(await sessionManager.searchSessions(String(args.query ?? ""), limit));
    } catch (error) {
      return formatToolError(error, "跨会话检索失败");
    }
  }
  if (name === "read_session") {
    if (!sessionManager) return "错误：会话检索工具不可用（缺少 sessionManager）。";
    try {
      const sid = await resolveSessionId(String(args.id ?? ""), sessionManager, agentRegistry);
      const from = Number(args.from ?? 1);
      const to = Number(args.to ?? 0);
      return await sessionManager.readSessionTranscript(sid, from, to);
    } catch (error) {
      return formatToolError(error, "读取会话区间失败");
    }
  }
  if (name === "search_content") {
    if (!sessionManager) return "错误：内容检索工具不可用（缺少 sessionManager）。";
    try {
      const idRaw = typeof args.id === "string" ? args.id : undefined;
      const sid = idRaw ? await resolveSessionId(idRaw, sessionManager, agentRegistry) : undefined;
      return JSON.stringify(await sessionManager.searchContentInSession(sid, String(args.query ?? "")));
    } catch (error) {
      return formatToolError(error, "内容检索失败");
    }
  }
  if (name === "search_files") {
    try {
      return await searchFilesTool(workDir, String(args.query ?? ""), typeof args.scope === "string" ? args.scope : undefined);
    } catch (error) {
      return formatToolError(error, "文件检索失败");
    }
  }
  if (name === "run_shell") {
    return await runShellTool({ workDir: targetWorkspace, tracePath, command: String(args.command ?? ""), approvalOrigin });
  }
  return `错误：未知工具 '${name}'。`;
}

export async function executeApprovedToolCall(toolName: ApprovalToolName, args: Record<string, string>, targetWorkspace: string): Promise<string> {
  if (toolName === "read_file") return await readFileTool({ workDir: targetWorkspace, path: args.path ?? "" });
  if (toolName === "write_file") return await writeFileTool({ workDir: targetWorkspace, path: args.path ?? "", content: args.content ?? "" });
  if (toolName === "list_files") return await listFilesTool({ workDir: targetWorkspace, directory: args.directory || "." });
  if (toolName === "append_file") return await appendFileTool({ workDir: targetWorkspace, path: args.path ?? "", content: args.content ?? "" });
  const store = isSandboxEnabled()
    ? new ApprovalStore(targetWorkspace, {
        run: createSandboxShellRunner(targetWorkspace, { manifest: loadWorkspaceManifest(targetWorkspace) }),
      })
    : new ApprovalStore(targetWorkspace);
  try {
    const result = await store.runApproved(args.command ?? "", targetWorkspace);
    return [result.stdout, result.stderr].filter(Boolean).join("\n") || `Command exited with code ${result.code}`;
  } catch (error) {
    return formatToolError(error, "执行已批准命令失败");
  }
}

function createDefaultApprovalStore(workspace: string): ApprovalStore {
  if (isSandboxEnabled()) {
    return new ApprovalStore(workspace, {
      run: createSandboxShellRunner(workspace, { manifest: loadWorkspaceManifest(workspace) }),
    });
  }
  // 沙箱关闭（默认）：宿主白名单执行，与第二周行为一致
  return new ApprovalStore(workspace);
}

function requireWorkspace(workDir: string | undefined): string {
  if (!workDir) throw new Error("未设置会话工作目录，shell 操作已被禁用。");
  return path.resolve(workDir);
}

function resolveTargetWorkspace(sourceWorkspace: string, requestedWorkspace: string | undefined): string {
  return requestedWorkspace ? path.resolve(requestedWorkspace) : sourceWorkspace;
}

function isApprovalTool(value: string): value is ApprovalToolName {
  return ["read_file", "list_files", "write_file", "append_file", "run_shell"].includes(value);
}

async function deferCrossWorkspaceTool(
  toolName: ApprovalToolName,
  rawArgs: Record<string, unknown>,
  sourceWorkspace: string,
  targetWorkspace: string,
  tracePath?: string,
  approvalOrigin?: ApprovalOrigin,
): Promise<string> {
  const targetStats = await stat(targetWorkspace).catch(() => null);
  if (!targetStats?.isDirectory()) return `错误：目标工作目录不存在或不是目录：${targetWorkspace}`;
  const args = Object.fromEntries(Object.entries(rawArgs)
    .filter(([key]) => key !== "workspace")
    .map(([key, value]) => [key, String(value)]));
  // 完全自动模式：跨工作区操作直接执行（不再产生人工审批）
  if (isFullyAutomatic()) {
    return await executeApprovedToolCall(toolName, args, targetWorkspace);
  }
  const approval = await new ApprovalStore(sourceWorkspace).request({ targetWorkspace, toolName, args, tracePath, ...approvalOrigin });
  return `Cross-workspace operation pending approval: ${approval.id}`;
}

function formatArgumentValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return formatArgumentValidationMessage("arguments do not match the tool schema");
  }

  const argument = typeof issue.path[0] === "string" ? issue.path[0] : "";
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return formatArgumentValidationMessage(`unknown argument \"${issue.keys[0] ?? ""}\"`);
  }
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === "undefined") {
      return formatArgumentValidationMessage(`missing required argument \"${argument}\"`);
    }
    return formatArgumentValidationMessage(`argument \"${argument}\" must be a ${issue.expected}`);
  }
  if (issue.code === z.ZodIssueCode.too_small && issue.type === "string") {
    return formatArgumentValidationMessage(`argument \"${argument}\" must not be empty`);
  }
  return formatArgumentValidationMessage(`argument \"${argument}\" is invalid`);
}

function formatArgumentValidationMessage(message: string): string {
  return `错误：工具参数无效：Invalid tool arguments: ${message}.`;
}

function formatToolError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("工作目录") || message.includes("超出了工作目录")) {
    return `错误：${message}`;
  }
  return `错误：${fallback} — ${message}`;
}

/** 把 &ses_<id> / &tile_<agentId> 句柄解析为真实 sessionId。 */
async function resolveSessionId(ref: string, sessionManager: SessionManager, agentRegistry?: AgentRegistry): Promise<string> {
  const id = ref.trim();
  if (id.startsWith("tile_")) {
    if (!agentRegistry) throw new Error("agent registry 不可用，无法解析 &tile_ 句柄");
    const agent = await agentRegistry.getAgent(id.slice("tile_".length));
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent.sessionId;
  }
  return id; // ses_<id> 或原始 session id
}

/** everything 侧：按文件名/路径在工作目录内检索文件。 */
async function searchFilesTool(workDir: string | undefined, query: string, scope?: string): Promise<string> {
  if (!workDir) return "错误：未设置工作目录，文件检索已禁用。";
  const base = path.resolve(workDir, scope && scope !== "." ? scope : "");
  const needle = query.toLowerCase();
  const matches: string[] = [];
  let scanned = 0;
  const maxScan = 4000;
  async function walk(dir: string): Promise<void> {
    if (matches.length > 200 || scanned > maxScan) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned > maxScan || matches.length > 200) return;
      scanned += 1;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.name.toLowerCase().includes(needle)) matches.push(full);
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(base);
  if (matches.length === 0) return `未找到匹配 "${query}" 的文件（已扫描 ${scanned} 项）。`;
  return `匹配 "${query}" 的文件（${matches.length} 个）：\n${matches.slice(0, 200).map((match) => `- ${match}`).join("\n")}`;
}
