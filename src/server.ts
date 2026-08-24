import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMomokaAgent } from "./agent.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentStateMachine } from "./agent-state.js";
import { createMomokaHttpHandler } from "./http.js";
import { createOpenAICompatibleModelClient } from "./model-client.js";
import { defaultPaths, loadLocalEnvSync, resolveProjectRoot } from "./config.js";

export function createMomokaServer(options: {
  projectRoot?: string;
  port?: number;
  host?: string;
} = {}) {
  if (options.projectRoot) {
    loadLocalEnvSync(options.projectRoot);
  } else {
    loadLocalEnvSync();
  }
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const agent = createMomokaAgent({
    projectRoot,
    modelClient: createOpenAICompatibleModelClient(),
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
      const port = options.port ?? Number(process.env.PORT ?? 8888);
      const host = options.host ?? process.env.HOST ?? "0.0.0.0";
      server.listen(port, host, () => {
        console.log("MOMOKA TypeScript HTTP Server 启动中...");
        console.log(`  访问: http://localhost:${port}`);
      });
      return server;
    },
  };
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedFile && currentFile === invokedFile) {
  createMomokaServer().listen();
}
