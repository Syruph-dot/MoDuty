import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ApprovalStore, type ApprovalToolName, parseWhitelistedCommand } from "./approvals.js";
import { decodeNodeOutput } from "./exec-encoding.js";
import { isFullyAutomatic } from "./permission-mode.js";
import { appendTraceEvent } from "./trace.js";
import { createSandboxShellRunner } from "./sandbox.js";
import { isSandboxEnabled } from "./settings.js";
import { browserService, toBrowserFriendlyError } from "./browser-service.js";
import { getDispatchHandler } from "./dispatch-bridge.js";
import { isDispatcherAgent } from "./agent-registry.js";
import type { SessionManager } from "./session-manager.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { AgentKind } from "./types.js";

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

/**
 * 改造型 / 破坏型命令：即使处于完全自动模式（permissionMode=auto）也必须人工审批。
 * 背景：执行者在无审批情况下跑过 conda install，直接改了用户的 anaconda base 环境。
 * 这里只做「不自动放行」，不代替用户的判断。
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  // 包管理器安装/卸载/升级
  /\b(?:pip|pip3|conda|mamba|npm|pnpm|yarn|poetry|uv)\b[^|]{0,120}\b(?:install|add|remove|uninstall|update|upgrade|create)\b/i,
  /\b(?:winget|choco|scoop)\s+(?:install|uninstall|upgrade|update)\b/i,
  // 版本控制改写历史 / 强推
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\b[^|]{0,60}--force|push\s+-f\b|checkout\s+--\s)/i,
  // 递归删除
  /\b(?:rm|rmdir|del|erase|Remove-Item)\b[^|]{0,40}(?:-r\b|-rf\b|\/s\b|\/q\b)/i,
  // 系统级
  /\b(?:format|diskpart|mkfs)\b/i,
  /\b(?:reg\s+(?:add|delete)|sc\s+(?:config|delete)|net\s+(?:stop|start))\b/i,
  /\b(?:shutdown|reboot)\b/i,
  // 管道下载执行 / 放宽执行策略
  /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^|]{0,200}\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd)\b/i,
  /\bSet-ExecutionPolicy\b/i,
];

/** 是否为改造型/破坏型命令（需永久人工审批） */
function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export async function runShellTool(
  input: WorkspaceToolInput & { command: string; tracePath?: string; approvalOrigin?: ApprovalOrigin },
  approvals = createDefaultApprovalStore(requireWorkspace(input.workDir)),
): Promise<string> {
  const workspace = requireWorkspace(input.workDir);
  if (!parseWhitelistedCommand(input.command)) {
    // 改造型/破坏型命令：不受完全自动模式放行，一律先拿人工审批（不再直接跑）
    if (isDangerousCommand(input.command)) {
      const approval = await approvals.request({
        targetWorkspace: workspace,
        toolName: "run_shell",
        args: { command: input.command },
        tracePath: input.tracePath,
        ...input.approvalOrigin,
      });
      return `改造型命令已拦下，等待人工审批（id: ${approval.id}）：${input.command}\n批准后由审批面板执行；未批准前不会运行。`;
    }
    // 完全自动模式：其余非白名单命令直接放行执行（不再产生人工审批）
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

/**
 * MOMOKA CLI 工具：让 Agent 通过 CLI 驱动/管理其它 Agent 应用（Agent 用 Agent 应用）。
 * 白名单校验只放行文档化子命令；执行走参数化 spawn（无 shell 注入面），有超时与输出截断。
 */
const MOMOKA_CLI_PATH = fileURLToPath(new URL("../bin/momoka.mjs", import.meta.url));
const MOMOKA_CLI_COMMANDS: Record<string, Set<string>> = {
  agent: new Set(["list", "create", "chat", "dispatch", "reset", "stop"]),
  session: new Set(["list", "inspect"]),
  // dispatch 子命令（全部进程内处理，见 interceptDispatchCli）：
  //   verdict <dsp_id> deliver|continue [备注]  收尾判读结论
  //   list [--state active|all]                 台账概览（只读）
  //   show <dsp_id>                             单条台账详情（只读，含完整任务书）
  //   cancel <dsp_id> [备注]                     放弃条目：结单但不交付
  dispatch: new Set(["verdict", "list", "show", "cancel"]),
};

/**
 * 远程渠道（手机机器人 bridge）额外放行的动词。
 * 为什么不给 Agent 用：`agent dispatcher` 找的是调度者本身、`session chat` 是按会话驱动——
 * Agent 互相唤醒会成环（值日生 → 自己 / 执行者 → 值日生 → 执行者），所以只在 bot 侧放行。
 */
const MOMOKA_CLI_REMOTE_ONLY: Record<string, Set<string>> = {
  agent: new Set(["dispatcher"]),
  session: new Set(["chat"]),
};

/** 无子命令的动词：help（用法文本）/ status（服务 + Agent 状态分布 + 台账未结单） */
const MOMOKA_CLI_SOLO_COMMANDS = new Set(["help", "status"]);

export type MomokaCliScope = "agent" | "remote";

export function validateMomokaCliArgs(args: string[], scope: MomokaCliScope = "agent"): string | null {
  if (args.length === 0 || args.length > 64) return "参数数量非法（0 或超过 64 项）";
  const [cmd, sub, ...rest] = args;
  if (MOMOKA_CLI_SOLO_COMMANDS.has(cmd)) {
    return args.length === 1 ? null : `${cmd} 不接受参数`;
  }
  const allowed = MOMOKA_CLI_COMMANDS[cmd];
  const remoteOnly = scope === "remote" ? MOMOKA_CLI_REMOTE_ONLY[cmd] : undefined;
  if (!allowed) return `未知命令 '${cmd}'（仅允许 ${[...Object.keys(MOMOKA_CLI_COMMANDS), ...MOMOKA_CLI_SOLO_COMMANDS].join("/")}）`;
  const subAllowed = allowed.has(sub) || Boolean(remoteOnly?.has(sub));
  if (!subAllowed) {
    const all = new Set([...allowed, ...(scope === "remote" ? [...(MOMOKA_CLI_REMOTE_ONLY[cmd] ?? [])] : [])]);
    return `未知子命令 '${sub}'（${cmd} 允许 ${[...all].join("/")}）`;
  }
  if (cmd === "agent" && sub === "create") {
    const nameIdx = rest.indexOf("--name");
    if (nameIdx === -1 || !rest[nameIdx + 1]?.trim()) return "agent create 必须提供 --name <名称>";
  }
  if (cmd === "agent" && ["chat", "dispatch", "reset", "stop"].includes(sub) && rest.length === 0) {
    return `${sub} 需要 agentId`;
  }
  if (cmd === "dispatch" && sub === "verdict" && rest.length < 2) return "dispatch verdict 需要 <dsp_id> 与 deliver|continue";
  if (cmd === "dispatch" && (sub === "show" || sub === "cancel") && rest.length === 0) return `dispatch ${sub} 需要 <dsp_id>`;
  if (cmd === "session" && sub === "inspect" && rest.length === 0) return "inspect 需要会话句柄（ses_<id>）";
  if (cmd === "agent" && sub === "dispatcher" && rest.length === 0) return "agent dispatcher 需要消息文本";
  if (cmd === "session" && sub === "chat" && rest.length < 2) return "session chat 需要 <ses_id|关键词> 与消息文本";
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) return "包含非法控制字符";
  }
  return null;
}

/**
 * 收尾单链拦截：值日生（dispatcher）发起的 agent chat/dispatch 与 dispatch verdict
 * 不再走「spawn CLI → HTTP 回环」，直接进编排层 handleDispatchBridge——
 * 台账创建、复用校验、判读回路都在那里结构化完成。
 * 返回 null 表示不拦截（桥未接线 / 非 dispatcher / 其余子命令），沿用旧 CLI 路径。
 */
async function interceptDispatchCli(
  cliArgs: string[],
  approvalOrigin: { sessionId?: string; runId?: string } | undefined,
  agentRegistry: AgentRegistry | undefined,
): Promise<string | null> {
  const handler = getDispatchHandler();
  if (!handler || !approvalOrigin?.sessionId || !agentRegistry) return null;

  // dispatch verdict <dsp_id> deliver|continue [备注...]
  if (cliArgs[0] === "dispatch" && cliArgs[1] === "verdict") {
    const [entryId, rawChoice, ...noteWords] = cliArgs.slice(2);
    const choice = rawChoice === "deliver" || rawChoice === "continue" ? rawChoice : undefined;
    if (!entryId || !choice) {
      return "错误：dispatch verdict 需要 <dsp_id> 与 deliver|continue。";
    }
    const result = await handler({
      kind: "verdict",
      entryId,
      choice,
      note: noteWords.join(" ").trim(),
      callerSessionId: approvalOrigin.sessionId,
    });
    return result.output;
  }

  // dispatch list [--state active|all] / show <dsp_id> / cancel <dsp_id> [备注...]
  // 值日生的“眼睛”：台账原本没有读接口，模型只能靠会话历史猜在途状态。
  if (cliArgs[0] === "dispatch" && ["list", "show", "cancel"].includes(cliArgs[1] ?? "")) {
    const sub = cliArgs[1];
    if (sub === "list") {
      const stateIdx = cliArgs.indexOf("--state");
      const rawState = stateIdx >= 0 ? cliArgs[stateIdx + 1] : undefined;
      const state = rawState === "all" ? "all" : "active";
      const result = await handler({ kind: "ledger", op: "list", state, callerSessionId: approvalOrigin.sessionId });
      return result.output;
    }
    const entryId = cliArgs[2];
    if (!entryId) return `错误：dispatch ${sub} 需要 <dsp_id>。`;
    const result = await handler({
      kind: "ledger",
      op: sub === "show" ? "show" : "cancel",
      entryId,
      note: cliArgs.slice(3).join(" ").trim(),
      callerSessionId: approvalOrigin.sessionId,
    });
    return result.output;
  }

  if (cliArgs[0] !== "agent" || (cliArgs[1] !== "chat" && cliArgs[1] !== "dispatch")) return null;
  const targetId = cliArgs[2];
  if (!targetId || !targetId.startsWith("agt_")) return null;
  // 只拦值日生：普通 Agent 之间的 agent chat 不属于收尾单链，保持原路径
  const caller = await agentRegistry.agentBySessionId(approvalOrigin.sessionId);
  if (!caller || !isDispatcherAgent(caller)) return null;

  // 任务书 = 目标 id 之后的参数；--confirm/--link 开关及其取值剔除
  const taskWords: string[] = [];
  let confirm: string | undefined;
  for (let i = 3; i < cliArgs.length; i += 1) {
    const token = cliArgs[i];
    if (token === "--confirm") {
      confirm = cliArgs[i + 1];
      i += 1;
      continue;
    }
    if (token === "--link") {
      i += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      taskWords.push(token);
    }
  }
  const result = await handler({
    kind: cliArgs[1] === "chat" ? "chat" : "dispatch",
    executorId: targetId,
    task: taskWords.join(" ").trim(),
    confirm,
    callerSessionId: approvalOrigin.sessionId,
  });
  return result.output;
}

/**
 * 值日生「复用既有执行者」的**硬约束**（返回非 null 则拒绝本次派发）。
 *
 * 为什么必须做成机制：提示词早已要求“复用前先问老师”，但实测被完全无视——
 * 三次主题完全不同的任务都派给了同一个 agent（名字还叫「MoDuty README 摘要」）。
 *
 * 判定口径：
 * - 只约束 dispatcher 发起的 agent dispatch/chat；
 * - 目标会话已有消息（> 0）→ 视为「复用」；消息为 0 → 视为刚新建，放行；
 * - 复用必须带 --confirm <qst_id>，且该提问属于本会话、已作答、
 *   第一题选了第一项（choiceIndex === 0，即“复用”）、题干里含目标 agentId。
 */
async function validateDispatcherReuse(
  cliArgs: string[],
  approvalOrigin: { sessionId?: string } | undefined,
  agentRegistry: AgentRegistry | undefined,
): Promise<string | null> {
  if (!agentRegistry || !approvalOrigin?.sessionId) return null;
  if (cliArgs[0] !== "agent" || cliArgs[1] !== "dispatch") return null;
  const targetId = cliArgs[2];
  if (!targetId || !targetId.startsWith("agt_")) return null;

  const caller = await agentRegistry.agentBySessionId(approvalOrigin.sessionId);
  if (!caller || !isDispatcherAgent(caller)) return null;

  const target = await agentRegistry.getAgent(targetId);
  if (!target) return null;
  const existingMessages = await agentRegistry.sessionMessageCount(target.sessionId);
  if (existingMessages === 0) return null; // 刚新建的执行者，不需要确认

  const confirmIndex = cliArgs.indexOf("--confirm");
  const confirmId = confirmIndex >= 0 ? String(cliArgs[confirmIndex + 1] ?? "").trim() : "";
  if (!confirmId) {
    return [
      "【已拦截】复用既有执行者必须先获得老师确认。",
      `目标 ${target.id}「${target.name}」已有 ${existingMessages} 条历史消息，属于复用而不是新建。`,
      "请改用带载荷的 ask_question：选项依次为 [\"复用\",\"新建\"]、题干里包含目标 id，并附 dispatch 载荷 { targetId: \"" + target.id + "\", task: <任务书>, newName: <新建名字> }：",
      `  复用 ${target.id}「${target.name}」吗？`,
      "老师作答后系统会自动派发（无需 --confirm）；CLI 人工派发仍可用 --confirm <qst_id>。",
    ].join("\n");
  }

  const sets = await agentRegistry.questions.listAll().catch(() => []);
  const set = sets.find((item) => item.id === confirmId);
  const questionText = set?.questions?.[0]?.prompt ?? "";
  const reuseAnswer = set?.answers?.find((item) => item.questionIndex === 0);
  const valid =
    Boolean(set) &&
    set?.sessionId === caller.sessionId &&
    set?.status === "answered" &&
    reuseAnswer?.choiceIndex === 0 &&
    questionText.includes(targetId);
  if (!valid) {
    return [
      `【已拦截】确认凭证无效：${confirmId || "(缺失)"}。`,
      `要求：该 qst_ 提问属于本会话、已作答、第一题选了第一项（“复用”）、且题干包含目标 id ${targetId}。`,
      "请重新 ask_question 确认，或改用 agent create 新建执行者。",
    ].join("\n");
  }
  return null;
}

export async function runMomokaCliTool(input: {
  args: string[];
  workDir?: string;
  commandTimeoutMs?: number;
  /** 输出保留上限（字符）。默认 12000（喂给模型够用）；手机机器人那边调大，因为回复要发完不能截断 */
  maxOutputChars?: number;
  /** 白名单口径：agent（工具调用，默认）| remote（手机机器人 bridge，多放行两个动词） */
  scope?: MomokaCliScope;
}): Promise<string> {
  const invalid = validateMomokaCliArgs(input.args, input.scope ?? "agent");
  if (invalid) return `MOMOKA CLI 调用被拒绝：${invalid}`;
  const timeoutMs = input.commandTimeoutMs ?? 60_000;
  // 打包版（bun --compile）里 bin/momoka.mjs 不存在，且 process.execPath 就是 sidecar 自己；
  // 这时直接以 CLI 模式调用自身（sidecar 入口按有无参数分流，见 scripts/release-sidecar.ts）。
  // 旧实现在打包版会把“CLI 子命令”变成“再起一个后端”，被占用的端口直接报错。
  const cliArgs = fs.existsSync(MOMOKA_CLI_PATH)
    ? [MOMOKA_CLI_PATH, "--mono", ...input.args]
    : ["--mono", ...input.args];
  return await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: input.workDir ?? process.cwd(),
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(`MOMOKA CLI 启动失败：${error.message}`);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = [Buffer.concat(stdout), Buffer.concat(stderr)]
        .map((buffer) => decodeNodeOutput(buffer))
        .filter(Boolean)
        .join("\n");
      const cap = input.maxOutputChars ?? 12_000;
      const trimmed = output.length > cap ? `${output.slice(0, cap)}\n…(输出过长已截断，共 ${output.length} 字符)` : output;
      resolve(trimmed || `MOMOKA CLI 退出码 ${code}`);
    });
  });
}

const TOOL_ARGUMENT_SCHEMAS = {
  get_current_time: z.object({}).strict(),
  read_file: z.object({ path: z.string().min(1), workspace: z.string().min(1).optional() }).strict(),
  write_file: z.object({ path: z.string().min(1), content: z.string(), workspace: z.string().min(1).optional() }).strict(),
  list_files: z.object({ directory: z.string().optional(), workspace: z.string().min(1).optional() }).strict(),
  append_file: z.object({ path: z.string().min(1), content: z.string(), workspace: z.string().min(1).optional() }).strict(),
  run_command_echo_only: z.object({ command: z.string().min(1) }).strict(),
  run_shell: z.object({ command: z.string().min(1), workspace: z.string().min(1).optional() }).strict(),
  run_momoka_cli: z.object({ args: z.array(z.string()).min(1).max(64) }).strict(),
  browse_create: z.object({ name: z.string().min(1).optional(), mode: z.enum(["persistent", "incognito"]).optional() }).strict(),
  browse_list: z.object({}).strict(),
  browse_navigate: z.object({ browser_id: z.string().min(1), url: z.string().min(1), wait_until: z.enum(["load", "domcontentloaded", "commit"]).optional() }).strict(),
  browse_observe: z.object({ browser_id: z.string().min(1) }).strict(),
  browse_click: z.object({ browser_id: z.string().min(1), selector: z.string().min(1).optional(), ref: z.string().min(1).optional() }).strict(),
  browse_fill: z.object({ browser_id: z.string().min(1), selector: z.string().min(1), text: z.string() }).strict(),
  browse_press: z.object({ browser_id: z.string().min(1), key: z.string().min(1) }).strict(),
  browse_dom_action: z.object({ browser_id: z.string().min(1), action: z.enum(["focus", "fill", "click", "inspect"]), selector: z.string().min(1), text: z.string().optional() }).strict(),
  browse_wait_for: z.object({ browser_id: z.string().min(1), kind: z.enum(["url", "text", "selector"]), value: z.string().min(1), timeout_ms: z.number().int().positive().max(60_000).optional() }).strict(),
  browse_execute_js: z.object({ browser_id: z.string().min(1), script: z.string().min(1) }).strict(),
  browse_screenshot: z.object({ browser_id: z.string().min(1) }).strict(),
  browse_close: z.object({ browser_id: z.string().min(1) }).strict(),
  web_search: z.object({ query: z.string().min(1), max_results: z.number().int().positive().max(20).optional() }).strict(),
  inspect_session: z.object({ id: z.string().min(1) }).strict(),
  search_sessions: z.object({
    query: z.string().min(1),
    keywords: z.array(z.string().min(1)).max(10).optional(),
    limit: z.number().int().positive().max(50).optional(),
  }).strict(),
  read_session: z.object({ id: z.string().min(1), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }).strict(),
  search_content: z.object({ id: z.string().min(1).optional(), query: z.string().min(1) }).strict(),
  search_files: z.object({ query: z.string().min(1), scope: z.string().optional() }).strict(),
  ask_question: z.object({
    questions: z.array(z.object({
      prompt: z.string().min(1),
      options: z.array(z.string()).min(1).max(8),
    })).min(1).max(6),
    /** 确认即执行载荷：单题集 + 老师选「复用/新建」后系统自动派发，无需 Agent 再调 dispatch */
    dispatch: z.object({
      targetId: z.string().min(1),
      task: z.string().min(1),
      newName: z.string().min(1).optional(),
    }).optional(),
  }).strict(),
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
      name: "run_momoka_cli",
      description:
        "调用 MOMOKA CLI 驱动/管理其它 Agent 应用（让 Agent 用 Agent 应用）。" +
        "参数 args 是参数数组：help（看用法）与 status（服务健康 + Agent 状态分布 + 台账未结单）为单命令；" +
        "其余首个元素为命令族（agent | session | dispatch），第二个为子命令：" +
        "agent list / agent create --name <名称> [--workspace <目录>] / agent chat <agentId> <消息…>（同步等待结果；消息可含 &ses_<id> 句柄链接相关会话）/ agent dispatch <agentId> <消息…>（异步派发，发起后立即返回，适合“派发完即回 idle”的懒调度）/ agent reset <agentId> / agent stop <agentId>；" +
        "session list [--query <词>] [--limit <n>]（默认按最近活动排序并截断）/ session inspect <ses_<id>>；" +
        "dispatch verdict <dsp_id> deliver|continue [备注]（收尾判读结论：交付上报 / 返工继续，仅用于响应台账判读请求）；" +
        "dispatch list [--state active|all]（台账概览：未结单+最近交付，只读）/ dispatch show <dsp_id>（单条详情，含完整任务书）/ dispatch cancel <dsp_id> [备注]（放弃条目：结单但不交付，用于派错人或任务作废）。" +
        "只允许 MOMOKA 文档化子命令，不是任意 shell。执行有超时与输出截断。",
      parameters: {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" } },
        },
        required: ["args"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "搜索网页（自动使用 DuckDuckGo HTML lite 版 lite.duckduckgo.com，避免反爬虫；复用单个搜索专用浏览器实例）。返回结构化结果：标题、URL、摘要。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "搜索关键词" },
          max_results: { type: "number", minimum: 1, maximum: 20, default: 10, description: "最大返回结果数" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_question",
      description: "向桌面用户发起结构化提问（选择题）。参数 questions 为问题数组（一次最多 6 题）：每题包含 prompt（题干）与 options（选项，2-8 个）。桌面会把问题渲染成单选卡片，最后一项固定为“自定义”输入，用户可逐题作答后提交；你的本次工具调用会返回 pending 等待，用户提交答案后系统会自动把答案写回会话并让你继续。用于需要用户明确选择/确认的场景（如复用哪个会话、选择方案）。不要用它问可以自行检索/推断的问题。" +
        "确认即执行：复用确认类提问应携带可选 dispatch 载荷 { targetId, task, newName }——老师选「复用」→ 系统自动派发任务书到 targetId；选「新建」→ 系统按 newName 建执行者并派发；你无需再调用 agent dispatch。" +
        "禁止用于请求权限或审批（例：是否允许我访问某个路径）：跨工作区/敏感操作直接真实调用工具，需要审批时系统会自行弹出审批面板；用本工具代问审批会让任务无谓阻塞。",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            description: "问题列表：prompt 题干 + options 选项",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string", minLength: 1, description: "题干" },
                options: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" }, description: "候选项；桌面会自动附加“自定义”输入项作为最后一个选项" },
              },
              required: ["prompt", "options"],
              additionalProperties: false,
            },
          },
          dispatch: {
            type: "object",
            description: "确认即执行载荷（复用确认类提问必带）：老师作答后系统自动派发，无需再调 agent dispatch",
            properties: {
              targetId: { type: "string", minLength: 1, description: "复用分支的目标执行者 agt_id" },
              task: { type: "string", minLength: 1, description: "确认后原样派发的任务书" },
              newName: { type: "string", minLength: 1, description: "老师选「新建」时使用的执行者名字（2-6 字主题）" },
            },
            required: ["targetId", "task"],
            additionalProperties: false,
          },
        },
        required: ["questions"],
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
      description:
        "跨会话检索，按相关度排序返回命中会话与匹配 turn 区间。" +
        "支持多个关键词（keywords 与 query 取并集，任一命中即返回），引擎为 ripgrep。" +
        "返回项里的 agent_id 就是可直接用于 agent dispatch 的执行者 id（无需再拉全量 agent 列表）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "主关键词" },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "额外关键词；与 query 取并集（任一命中即入候选）",
          },
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
  {
    type: "function",
    function: {
      name: "browse_create",
      description: "创建并启动一个受控浏览器（独立于 Agent 的浏览器磁贴）。mode=persistent 持久化登录/Cookie（默认正常模式）；mode=incognito 无痕。不同工作目录可通过 browse_list 中的 browser_id 复用同一 profile。返回浏览器 id，后续 browse_* 用 browser_id 引用。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "可选：浏览器名称（磁贴标题）" },
          mode: { type: "string", enum: ["persistent", "incognito"], description: "persistent=持久化登录（默认）；incognito=无痕" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_list",
      description: "列出所有受控浏览器实例（id/名称/模式/状态/当前地址）。",
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
      name: "browse_navigate",
      description: "导航浏览器到指定 URL（未提供协议时自动补 https://）。wait_until 可选 load/domcontentloaded/commit。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
          url: { type: "string" },
          wait_until: { type: "string", enum: ["load", "domcontentloaded", "commit"] },
        },
        required: ["browser_id", "url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_observe",
      description: "观察浏览器当前页面：返回可交互元素快照（ref [i] + role + 名称 + CSS 选择器）。点击/填写可用 ref 或 selector。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
        },
        required: ["browser_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_click",
      description: "点击页面元素。selector（CSS）或 ref（来自 browse_observe 的 [i]）二选一。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
          selector: { type: "string" },
          ref: { type: "string" },
        },
        required: ["browser_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_fill",
      description: "清空并填入输入框文本（input/textarea/contenteditable）。selector 必填。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
        },
        required: ["browser_id", "selector", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_press",
      description: "发送键盘按键（Enter/Tab/Escape/箭头等）；非导航键文本将作为输入插入。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
          key: { type: "string", description: "如 Enter、Tab、Escape、ArrowDown" },
        },
        required: ["browser_id", "key"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_dom_action",
      description: "针对动态/Shadow DOM 元素的固定 DOM 操作：focus/fill/click/inspect（inspect 返回元素信息）。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
          action: { type: "string", enum: ["focus", "fill", "click", "inspect"] },
          selector: { type: "string", minLength: 1 },
          text: { type: "string", description: "fill 时必填" },
        },
        required: ["browser_id", "action", "selector"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_wait_for",
      description: "等待页面出现指定条件：url（URL 包含片段）、text（可见文本）、selector（CSS）。返回是否在超时内匹配。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
          kind: { type: "string", enum: ["url", "text", "selector"] },
          value: { type: "string" },
          timeout_ms: { type: "number", description: "默认 10000，最大 60000" },
        },
        required: ["browser_id", "kind", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_execute_js",
      description: "在浏览器页面执行最小 JS 脚本（仅用于固定 DOM 操作无法满足的目标；只写自己为实现目标编写的代码）。返回序列化结果。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
          script: { type: "string", description: "JS 语句/表达式" },
        },
        required: ["browser_id", "script"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_screenshot",
      description: "截取浏览器当前页面（JPEG），返回 data URL 摘要与尺寸信息（Agent 不宜回显完整 base64）。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
        },
        required: ["browser_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_close",
      description: "关闭浏览器实例（无痕模式同时销毁临时 profile 与登录态；persistent 保留登录信息供下次使用）。",
      parameters: {
        type: "object",
        properties: {
          browser_id: { type: "string" },
        },
        required: ["browser_id"],
        additionalProperties: false,
      },
    },
  },
]

/** 值日生（dispatcher）允许调用的工具白名单：会话元数据检索/检视/片段搜索 + 结构化问答 + MOMOKA CLI + 时间。
 *  对应 DISPATCHER_SYSTEM_PROMPT 的「除搜索/检视外，只允许 run_momoka_cli」——执行代码/读写文件/浏览器等工作是执行者的事。 */
const DISPATCHER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_sessions",
  "inspect_session",
  "read_session",
  "search_content",
  "ask_question",
  "run_momoka_cli",
  "get_current_time",
]);

/** 按角色类别裁剪模型可见的工具表：dispatcher 只见调度类工具（工具层白名单，模型调不到看不见的工具）；其余角色全量。 */
export function toolSpecsForKind(kind?: AgentKind): typeof TOOL_SPECS {
  if (kind !== "dispatcher") return TOOL_SPECS;
  return TOOL_SPECS.filter((spec) => DISPATCHER_TOOL_NAMES.has(spec.function.name));
}

export async function executeToolCall(
  name: string,
  rawArguments: string,
  workDir?: string,
  tracePath?: string,
  approvalOrigin?: ApprovalOrigin,
  sessionManager?: SessionManager,
  agentRegistry?: AgentRegistry,
  blockedToolNames: readonly string[] = [],
): Promise<string> {
  if (blockedToolNames.includes(name)) {
    const reason = `本轮请求已禁止该类访问，工具 ${name} 已拦截，未执行。`;
    await appendTraceEvent(tracePath, "tool_blocked", { name, reason }).catch(() => undefined);
    return reason;
  }
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
  if (name === "web_search" || name.startsWith("browse_")) {
    return await executeBrowserTool(name, args as Record<string, unknown>);
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
      const info = await sessionManager.inspectSession(sid);
      const [enriched] = await attachAgentRefs([info], agentRegistry);
      return JSON.stringify(enriched);
    } catch (error) {
      return formatToolError(error, "检视会话失败");
    }
  }
  if (name === "search_sessions") {
    if (!sessionManager) return "错误：会话检索工具不可用（缺少 sessionManager）。";
    const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 5;
    // 多关键词并集：query + 额外 keywords（任一命中即入候选）
    const extraKeywords = Array.isArray(args.keywords)
      ? (args.keywords as unknown[]).map((item) => String(item))
      : [];
    try {
      const hits = await sessionManager.searchSessions(String(args.query ?? ""), limit, extraKeywords);
      return JSON.stringify(await attachAgentRefs(hits, agentRegistry));
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
      const transcript = await sessionManager.readSessionTranscript(sid, from, to);
      return `来源会话：&${sid}\n${transcript}`;
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
  if (name === "ask_question") {
    if (!agentRegistry) return "错误：提问工具不可用（缺少 agentRegistry）。";
    const sessionId = approvalOrigin?.sessionId;
    const questions = (Array.isArray(args.questions) ? args.questions : []) as Array<{ prompt?: unknown; options?: unknown }>;
    const clean = questions
      .map((item) => ({
        prompt: String(item.prompt ?? "").trim(),
        options: Array.isArray(item.options) ? item.options.map((option) => String(option).trim()).filter(Boolean) : [],
      }))
      .filter((item) => item.prompt && item.options.length >= 1);
    if (clean.length === 0) return "错误：ask_question 需要至少一个含题干与选项的问题。";
    if (!sessionId) {
      // 无会话上下文（如审批后手动触发）无法定位归属 Agent——把问题作为不可交互提示返回
      return `错误：ask_question 需要会话上下文（当前没有 sessionId）。请改用普通文本向用户提问。`;
    }
    const agent = await agentRegistry.agentBySessionId(sessionId);
    if (!agent) return "错误：无法定位当前会话对应的 Agent，无法发起桌面提问。";
    const dispatchPayload = (args.dispatch && typeof args.dispatch === "object")
      ? {
          targetId: String((args.dispatch as Record<string, unknown>).targetId ?? "").trim(),
          task: String((args.dispatch as Record<string, unknown>).task ?? "").trim(),
          newName: typeof (args.dispatch as Record<string, unknown>).newName === "string"
            ? String((args.dispatch as Record<string, unknown>).newName).trim() || undefined
            : undefined,
        }
      : undefined;
    const set = await agentRegistry.createQuestionSet({
      agentId: agent.id,
      sessionId: agent.sessionId,
      questions: clean,
      ...(dispatchPayload && dispatchPayload.targetId && dispatchPayload.task ? { dispatch: dispatchPayload } : {}),
    });
    const autoNote = set.dispatch
      ? "老师作答后系统会**自动派发**（复用→派给载荷目标；新建→按载荷名字建执行者后派发），你无需再调用 agent dispatch，只需查看会话里的【自动派发】留痕。"
      : "用户提交后系统会把答案写回会话并让你继续";
    return `桌面用户问题已发出（${clean.length} 题，等待回答）。${autoNote}（pending question: ${set.id}）。请停止当前工具循环，等待用户回答。`;
  }
  if (name === "run_momoka_cli") {
    const cliArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    // 收尾单链：值日生的 agent chat/dispatch 与 dispatch verdict 进程内直调编排层
    // （台账创建/复用校验/判读回路集中在 handleDispatchBridge），不再 spawn CLI 回环。
    const intercepted = await interceptDispatchCli(cliArgs, approvalOrigin, agentRegistry);
    if (intercepted !== null) return intercepted;
    // 其余子命令（agent list/create/reset/stop、session …）与无桥环境保持 CLI 路径
    const refusal = await validateDispatcherReuse(cliArgs, approvalOrigin, agentRegistry);
    if (refusal) return refusal;
    return await runMomokaCliTool({
      args: cliArgs,
      workDir: targetWorkspace,
    });
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

/**
 * 给会话检索/检视结果补上绑定的执行者信息。
 *
 * 为什么必要：search_sessions / inspect_session 原先只返回 ses_xxx，
 * 而 agent dispatch 需要 agt_xxx。两者之间没有映射工具，模型只能去 dump 全量 agent list
 * 并取第一个，导致“永远复用同一个执行者”。补上 agent_id 后，检索结果可直接用于派发。
 */
async function attachAgentRefs(
  hits: Array<Record<string, unknown>>,
  agentRegistry?: AgentRegistry,
): Promise<Array<Record<string, unknown>>> {
  if (!agentRegistry) return hits;
  let bySession = new Map<string, { id: string; name: string; state: string; kind?: string }>();
  try {
    const agents = await agentRegistry.listAgents();
    bySession = new Map(
      agents.map((agent) => [agent.sessionId, { id: agent.id, name: agent.name, state: agent.state, kind: agent.kind }]),
    );
  } catch {
    return hits;
  }
  return hits.map((hit) => {
    const agent = bySession.get(String(hit.id ?? ""));
    if (!agent) return hit;
    return { ...hit, agent_id: agent.id, agent_name: agent.name, agent_state: agent.state, agent_kind: agent.kind };
  });
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

/**
 * browse_* 工具统一分发：浏览器是独立实体（BrowserService 全局单例），
 * Agent 只经 browser_id 引用——浏览器与 Agent 本质解耦。
 */
async function executeBrowserTool(name: string, args: Record<string, unknown>): Promise<string> {
  const id = (args.browser_id as string | undefined) ?? "";
  try {
    switch (name) {
      case "browse_create": {
        const info = await browserService.createInstance({
          name: typeof args.name === "string" ? args.name : undefined,
          mode: args.mode === "persistent" ? "persistent" : args.mode === "incognito" ? "incognito" : undefined,
        });
        const launched = await browserService.launch(info.id);
        return `浏览器已创建并启动：id=${launched.id} 名称=${launched.name} 模式=${launched.mode === "persistent" ? "持久化（正常模式）" : "无痕（incognito）"}\n后续操作请用 browse_navigate / browse_observe 等，参数 browser_id=${launched.id}`;
      }
      case "browse_list": {
        const browsers = await browserService.list();
        if (browsers.length === 0) return "当前没有受控浏览器实例。可用 browse_create 创建（mode=persistent 正常模式 / incognito 无痕）。";
        return `受控浏览器（${browsers.length} 个）：\n${browsers
          .map((b) => `- ${b.id} | ${b.name} | ${b.mode === "persistent" ? "持久化" : "无痕"} | ${b.state} | ${b.url ?? "(未导航)"}`)
          .join("\n")}`;
      }
      case "browse_navigate": {
        const info = await browserService.getInfo(id);
        if (!info) return `错误: 浏览器实例不存在 ${id}（可先 browse_list）`;
        if (info.state !== "ready") {
          await browserService.launch(id);
        }
        const result = await browserService.navigate(id, String(args.url ?? ""), args.wait_until as "load" | "domcontentloaded" | "commit" | undefined);
        return result ? `已导航: ${result.title || "(无标题)"}\nURL: ${result.url}` : "浏览器未就绪";
      }
      case "browse_observe": {
        const snapshot = await browserService.snapshot(id);
        if (!snapshot) return `错误: 浏览器实例未启动或不存在 ${id}`;
        return `页面快照（共 ${Object.keys(snapshot.refs).length} 个元素，格式: ref role 名称 <selector>）:\n${snapshot.tree}`;
      }
      case "browse_click": {
        const ok = await browserService.click(id, String(args.selector ?? ""), typeof args.ref === "string" ? args.ref : undefined);
        return ok ? "已点击" : "错误: 浏览器未就绪或找不到元素";
      }
      case "browse_fill": {
        const ok = await browserService.fill(id, String(args.selector ?? ""), String(args.text ?? ""));
        return ok ? "已填写（覆盖原内容）" : "错误: 浏览器未就绪";
      }
      case "browse_press": {
        const ok = await browserService.press(id, String(args.key ?? ""));
        return ok ? `已按键: ${args.key}` : "错误: 浏览器未就绪";
      }
      case "browse_dom_action": {
        const result = await browserService.domAction(
          id,
          String(args.action ?? "") as "focus" | "fill" | "click" | "inspect",
          String(args.selector ?? ""),
          typeof args.text === "string" ? args.text : undefined,
        );
        return typeof result === "string" ? result : `DOM 操作完成: ${JSON.stringify(result) ?? args.action}`;
      }
      case "browse_wait_for": {
        const matched = await browserService.waitFor(id, String(args.kind ?? "text") as "url" | "text" | "selector", String(args.value ?? ""), Number(args.timeout_ms ?? 10_000));
        return matched ? `条件已满足: ${args.kind}=${args.value}` : `等待超时（${args.timeout_ms ?? 10000}ms）: 未匹配 ${args.kind}=${args.value}`;
      }
      case "browse_execute_js": {
        const result = await browserService.executeJS(id, String(args.script ?? ""));
        return `JS 结果: ${JSON.stringify(result)?.slice(0, 300) ?? "undefined"}`;
      }
      case "browse_screenshot": {
        const dataUrl = await browserService.screenshot(id);
        if (!dataUrl) return "错误: 浏览器未就绪";
        return `截图完成（JPEG ${Math.round((dataUrl.length * 3) / 4 / 1024)}KB），请通过 /api/browsers/${id}/screenshot 获取（Agent 不直接回显 base64）。`;
      }
      case "browse_close": {
        await browserService.closeInstance(id);
        return `浏览器 ${id} 已关闭（${(await browserService.getInfo(id))?.mode === "incognito" ? "无痕数据已销毁" : "登录信息已保存，可下次复用"}）。`;
      }
      case "web_search": {
        const query = String(args.query ?? "");
        const maxResults = Math.min(Math.max(Number(args.max_results ?? 10), 1), 20);
        if (!query) return "错误: query 不能为空";
        const searchBrowserId = await browserService.getOrCreateSearchBrowser();
        const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
        await browserService.navigate(searchBrowserId, url, "domcontentloaded");
        const snapshot = await browserService.snapshot(searchBrowserId);
        if (!snapshot) return "错误: 搜索浏览器未就绪";
        const lines = snapshot.tree.split("\n").filter(l => l.trim());
        const results = [];
        for (const line of lines) {
          const match = line.match(/\[(\d+)\] link (.+?) <(.+)>/);
          if (match) {
            const [, idx, title, selector] = match;
            const ref = "[" + idx + "]";
            const url = snapshot.refs[ref];
            if (url && url.startsWith("http")) {
              results.push({ title: title.trim(), url });
              if (results.length >= maxResults) break;
            }
          }
        }
        if (results.length === 0) return "未找到相关结果";
        return "搜索结果（前 " + results.length + " 条）：\n" + results.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url).join("\n\n");
      }
      default:
        return `未知浏览器工具: ${name}`;
    }
  } catch (error) {
    return `浏览器工具失败: ${toBrowserFriendlyError(error, name)}`;
  }
}
