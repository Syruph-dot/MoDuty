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

export interface CreateMomokaServerOptions {
  projectRoot?: string;
  port?: number;
  host?: string;
  /** 端口冲突时向上尝试的最大次数（默认 10：8888-8897） */
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
    workspaceManager: workspaces,
  });
  // Agent Desktop：多 Agent 注册表（1:1 绑定 session）+ 生命周期状态机
  const paths = defaultPaths(projectRoot);
  const registry = new AgentRegistry(paths.memoryDir, agent.sessionManager, undefined, paths.dataDir);
  // 让 Agent 核心能解析 &tile_<agentId> 别名 → 其绑定的 session
  agent.agentRegistry = registry;
  const machine = new AgentStateMachine();
  const server = createServer(createMomokaHttpHandler(agent, { registry, machine, workspaces }));
  return {
    agent,
    registry,
    machine,
    server,
    listen() {
      const basePort = options.port ?? Number(process.env.PORT ?? 8888);
      const host = options.host ?? process.env.HOST ?? "0.0.0.0";
      const maxTries = Math.max(1, options.portTries ?? 10);
      return listenWithFallback(server, basePort, host, maxTries, options.portFile).then((result) => {
        // 存量会话 transcript 回填（异步，不阻塞启动与请求）
        void agent.sessionManager.ensureTranscripts().catch((error: unknown) => {
          console.warn(`警告: 回填会话 transcript 失败: ${error instanceof Error ? error.message : String(error)}`);
        });
        return result;
      });
    },
  };
}

/** 监听一个端口；被占用则递增 basePort，最多 maxTries 次。成功后把端口写到 portFile（如果指定） */
function listenWithFallback(
  server: ReturnType<typeof createServer>,
  basePort: number,
  host: string,
  maxTries: number,
  portFile: string | undefined,
): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = basePort + attempt;
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE") {
          // 端口被占用时直接失败，而不是递增端口再起一个实例。
          // 多实例会并发读写同一份 agents.json（无文件锁），是注册表被清空/损坏的根因。
          reject(
            new Error(
              `Port ${port} is already in use. Another MOMOKA server instance may still be running. ` +
                `Stop the existing instance first (run-all.ps1 / npm run dev cleans port ${basePort}, or kill the process bound to ${port}) ` +
                `before starting a new one.`,
            ),
          );
        } else {
          reject(new Error(`Failed to start server on port ${port}: ${err.message}`));
        }
      };
      const onListening = async () => {
        server.off("error", onError);
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
        resolve({ port, host });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    };
    tryListen();
  });
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedFile && currentFile === invokedFile) {
  createMomokaServer({
    portFile: process.env.MOMOKA_PORT_FILE,
  })
    .listen()
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
