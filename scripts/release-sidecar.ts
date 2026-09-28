import fs from "node:fs";
import path from "node:path";

const executableDirectory = path.dirname(process.execPath);
const roots = [
  process.env.MOMOKA_PROJECT_ROOT,
  path.resolve(executableDirectory, ".."),
  executableDirectory,
  path.resolve(executableDirectory, "resources"),
  path.resolve(executableDirectory, "..", "resources"),
  process.cwd(),
].filter((value): value is string => Boolean(value));
const projectRoot = roots.find((root) => fs.existsSync(path.join(root, "prompts", "SYSTEM_RULES.md")));
if (!projectRoot) throw new Error("Release resources are missing prompts/SYSTEM_RULES.md");

process.env.MOMOKA_SERVER_NO_AUTOSTART = "1";
const { createMomokaServer } = await import("../src/server.js");
await createMomokaServer({ projectRoot, portFile: process.env.MOMOKA_PORT_FILE }).listen();
