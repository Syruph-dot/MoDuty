// dev 启动器：同时起 MOMOKA 后端（8888）与 desktop 前端（5173）。
// 用法：npm run dev
// 任一进程退出或 Ctrl+C 时，两个进程都会终止。
import { spawn } from "node:child_process";
import process from "node:process";

const children = [];

function start(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, shell: true, stdio: ["inherit", "pipe", "pipe"] });
  children.push(child);
  const tag = `[${name}]`;
  const pipe = (stream, isErr) => {
    stream.on("data", (buf) => {
      const text = buf.toString().trimEnd();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        console.log(`${tag}${isErr ? " ERR" : ""} ${line}`.trimEnd());
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on("exit", (code, signal) => {
    console.log(`${tag} exited (code=${code}, signal=${signal})`);
    shutdown(true);
  });
  return child;
}

let shuttingDown = false;
function shutdown(childDied) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode === null && !c.killed) {
      try { c.kill(childDied ? "SIGTERM" : "SIGINT"); } catch { /* noop */ }
    }
  }
  if (childDied) {
    setTimeout(() => process.exit(1), 500).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown(false));
process.on("SIGTERM", () => shutdown(false));

console.log("[dev-all] 启动 MOMOKA dev 环境：backend http://127.0.0.1:8888 + frontend http://localhost:5173（Ctrl+C 停止全部）");
start("backend ", "node", ["--import", "tsx", "dev-server.mjs"], ".");
start("frontend", "npm", ["run", "dev", "--prefix", "desktop"], ".");