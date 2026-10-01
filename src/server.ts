import { createServer } from "node:http";
import path from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createMomokaAgent } from "./agent.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentStateMachine } from "./agent-state.js";
import { createMomokaHttpHandler } from "./http.js";
import { abortAllChatStreams } from "./http/chat-streams.js";
import { createOpenAICompatibleModelClient } from "./model-client.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { defaultPaths, loadLocalEnvSync, resolveProjectRoot } from "./config.js";
import {
  DEFAULT_PORT_BASE,
  DEFAULT_PORT_TRIES,
  describeSkipped,
  listenOnFirstAvailable,
  listenOnPort,
  pickPort,
} from "./port-select.js";

export interface CreateMomokaServerOptions {
  projectRoot?: string;
  port?: number;
  host?: string;
  /** 端口冲突时向上尝试的最大次数（默认 10：7238-7247） */
  portTries?: number;
  /**
   * 启动成功后把端口号写入该路径（用于 Tauri 侧 car shell 启动后告知前端真实端口）。
   * 未设置则不写。文件已存在时会被覆盖。
   */
  portFile?: string;
}

export function createMomokaServer(options: CreateMomokaServerOptions = {}) {
  if (options.projectRoot) {
    loadLocalEnvSync(options.projectRoot);
  } else {
    loadLocalEnvSync();
  }
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const workspaces = new WorkspaceManager();
  const agent = createMomokaAgent({
    projectRoot,
    modelClient: createOpenAICompatibleModelClient({ stream: true }),
    // 标题使用设置页“低消费/廉价档”（tier=low）；配置或输出不合要求时由首轮调用显式报错。
    // tools:false → 标题调用不携带工具规格（省 token，且不会误触发工具执行）。
    titleModelClient: createOpenAICompatibleModelClient({ tier: "low", tools: false }),
    workspaceManager: workspaces,
  });
  // Agent Desktop：多 Agent 注册表（1:1 绑定 session）+ 生命周期状态机
  const paths = defaultPaths(projectRoot);
  const registry = new AgentRegistry(paths.memoryDir, agent.sessionManager, undefined, paths.dataDir);
  // 让 Agent 核心能解析 &tile_<agentId> 别名 → 其绑定的 session
  agent.agentRegistry = registry;
  const machine = new AgentStateMachine();
  // 启动复位：跨进程不成立的状态一律归零。
  // error / waiting_approval / requiring_input / completed 都是「上一个进程里的结论」——
  // 重启后没有东西在跑、没有审批在等、没有问题在等答，留着只会让磁贴一直显示错误/挂起。
  // （值日生交付后落到 error，重启后仍然红着，就是这个状态被写进了 agents.json。）
  void resetStickyAgentStates(registry);
  const server = createServer(createMomokaHttpHandler(agent, { registry, machine, workspaces }));
  return {
    agent,
    registry,
    machine,
    server,
    async listen() {
      const host = options.host ?? process.env.HOST ?? "0.0.0.0";
      const maxTries = Math.max(1, options.portTries ?? DEFAULT_PORT_TRIES);
      const explicitPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : undefined);
      let port: number;

      if (explicitPort != null) {
        // 显式给了端口就严格按它来（Tauri 壳自己挑好端口再传 PORT 进来，端口不可用时它要能立刻发现）。
        port = explicitPort;
        await listenOnPort(server, port, host);
      } else {
        // 没给端口就自己挑：不能简单地“被占就失败”，因为 Windows 上强杀进程会留下
        // 归属已死 PID 的残留监听（实测 8888/8889），写死端口的表现就是“启动即闪退”。
        //
        // 预检（pickPort）在这里只负责守“不再起第二个实例”这条不变量；**哪个端口能用，
        // 一律由真实 listen 说了算**——理由见 listenOnFirstAvailable 的注释。
        const survey = await pickPort({ base: DEFAULT_PORT_BASE, tries: maxTries, host });
        if (survey.kind === "momoka") {
          throw new Error(
            `端口 ${survey.port} 上已有一个 MOMOKA 后端在运行，不再启动第二个（两个实例会并发写同一份 agents.json）。\n` +
              `如需另起一个，请用 PORT=<其它端口> 显式指定；若那个是残留的旧后端，先停掉它。`,
          );
        }
        const bound = await listenOnFirstAvailable(server, DEFAULT_PORT_BASE, maxTries, host);
        if (bound.skipped.length > 0) {
          console.warn(`以下端口被跳过：\n${describeSkipped(bound.skipped)}`);
        }
        port = bound.port;
      }

      await announceListening(port, options.portFile);
      // 存量会话 transcript 回填（异步，不阻塞启动与请求）
      void agent.sessionManager.ensureTranscripts().catch((error: unknown) => {
        console.warn(`警告: 回填会话 transcript 失败: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { port, host };
    },
  };
}

/**
 * 跨进程不成立的状态：进程重启后一律回到 idle。
 * 幂等，失败只告警——启动复位不该拦住服务起来。
 */
const STICKY_AGENT_STATES: ReadonlySet<string> = new Set([
  "error",
  "waiting_approval",
  "requiring_input",
  "completed",
]);

async function resetStickyAgentStates(registry: AgentRegistry): Promise<void> {
  try {
    const agents = await registry.listAgents();
    for (const record of agents) {
      if (!STICKY_AGENT_STATES.has(record.state)) continue;
      await registry.updateAgentState(record.id, "idle").catch(() => undefined);
    }
  } catch (error) {
    console.warn(`警告: 启动复位 Agent 状态失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * listen 成功后的共同动作：打印地址、写端口文件、暴露 MOMOKA_URL、拉起远程机器人、装退出清理。
 * 只有真正 listen 成功的那一次会走到这里，所以 process.once 不会被重复注册。
 */
async function announceListening(port: number, portFile: string | undefined): Promise<void> {
  console.log("MOMOKA TypeScript HTTP Server 启动中...");
  console.log(`  访问: http://localhost:${port}`);
  if (portFile) {
    try {
      await writeFile(portFile, String(port), "utf-8");
      console.log(`  port file: ${portFile}`);
    } catch (writeErr) {
      console.warn(`  警告: 写 port file 失败: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
    }
  }
  // 让进程内工具（run_momoka_cli / 机器人命令）知道自己的地址：CLI 子进程继承本环境变量
  process.env.MOMOKA_URL = process.env.MOMOKA_URL ?? `http://127.0.0.1:${port}`;
  // 远程机器人（手机操控）：按配置起停飞书长连接 / 微信长轮询
  // 放在 listen 成功之后——机器人执行 CLI 时要能访问本机 HTTP 接口
  void import("./bot/manager.js")
    .then(({ botManager }) => botManager.applyAll())
    .catch((error: unknown) => {
      console.warn(`  警告: 启动远程机器人失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  // 注册进程退出时清理 port file + 中止所有活跃 chat 流
  const cleanup = () => {
    if (!portFile) return;
    unlink(portFile).catch(() => undefined);
  };
  const shutdown = () => {
    const aborted = abortAllChatStreams();
    if (aborted > 0) {
      console.log(`已中止 ${aborted} 个活跃 chat 流`);
    }
    cleanup();
    process.exit(0);
  };
  process.once("exit", cleanup);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedFile && currentFile === invokedFile && process.env.MOMOKA_SERVER_NO_AUTOSTART !== "1") {
  createMomokaServer({
    portFile: process.env.MOMOKA_PORT_FILE,
  })
    .listen()
    .catch((err: unknown) => {
      console.error(err);
      // 不用 process.exit() 硬退：拒绝启动时可能还有正在关闭的 socket/timer，
      // 硬退出会触发 libuv 的 UV_HANDLE_CLOSING 断言（噪音）。事件循环一空自然退出。
      process.exitCode = 1;
    });
}
