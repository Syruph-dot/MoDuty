import { createServer } from "node:http";
import path from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createMomokaAgent } from "./agent.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentStateMachine } from "./agent-state.js";
import { createMomokaHttpHandler } from "./http.js";
import { createOpenAICompatibleModelClient } from "./model-client.js";
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
  const agent = createMomokaAgent({
    projectRoot,
    modelClient: createOpenAICompatibleModelClient({ stream: true }),
  });
  // Agent Desktop：多 Agent 注册表（1:1 绑定 session）+ 生命周期状态机
  const registry = new AgentRegistry(defaultPaths(projectRoot).memoryDir, agent.sessionManager);
  const machine = new AgentStateMachine();
  const server = createServer(createMomokaHttpHandler(agent, { registry, machine }));
  return {
    agent,
    registry,
    machine,
    server,
    listen() {
      const basePort = options.port ?? Number(process.env.PORT ?? 8888);
      const host = options.host ?? process.env.HOST ?? "0.0.0.0";
      const maxTries = Math.max(1, options.portTries ?? 10);
      return listenWithFallback(server, basePort, host, maxTries, options.portFile);
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
        if (err.code === "EADDRINUSE" && attempt + 1 < maxTries) {
          attempt += 1;
          // 重置：removeListener 后再次 listen
          tryListen();
        } else {
          reject(new Error(`Failed to start server. Is port ${port} in use? (${err.message})`));
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
        // 注册进程退出时清理 port file
        const cleanup = () => {
          if (!portFile) return;
          unlink(portFile).catch(() => undefined);
        };
        process.once("exit", cleanup);
        process.once("SIGINT", () => {
          cleanup();
          process.exit(0);
        });
        process.once("SIGTERM", () => {
          cleanup();
          process.exit(0);
        });
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
