import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMomokaAgent } from "./agent.js";
import { createMomokaHttpHandler } from "./http.js";
import { createOpenAICompatibleModelClient } from "./model-client.js";
import { loadLocalEnvSync } from "./config.js";

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
  const agent = createMomokaAgent({
    projectRoot: options.projectRoot,
    modelClient: createOpenAICompatibleModelClient(),
  });
  const server = createServer(createMomokaHttpHandler(agent));
  return {
    agent,
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
