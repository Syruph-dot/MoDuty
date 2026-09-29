// dev 启动器：同时起 MOMOKA 后端（8888）与 desktop 前端（5173）。
// 用法：npm run dev
// 任一进程退出或 Ctrl+C 时，两个进程都会终止。
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const children = [];

function start(name, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, shell: true, stdio: ["inherit", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
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

// 后端不再固定 8888：它会自己挑一个空闲端口（Windows 上强杀进程留下的残留监听会占着
// 8888/8889，写死端口的表现就是"启动即闪退"）。前端通过 VITE_MOMOKA_API 直接连它，
// 所以这里等端口文件出现后再起前端。
const portFile = path.join(os.tmpdir(), "arona-chest.momoka.port");
console.log(`[dev-all] 启动 MOMOKA dev 环境：backend 自动挑端口 + frontend http://localhost:5173（Ctrl+C 停止全部）`);
console.log(`[dev-all] 后端端口写入 ${portFile}`);

const backend = start("backend ", "node", ["--import", "tsx", "dev-server.mjs"], ".");

/** 等后端把端口写进端口文件；超时就让调用方决定怎么抱怨。 */
async function waitForPort(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (backend.exitCode !== null) return undefined;
    try {
      const port = Number((await readFile(portFile, "utf-8")).trim());
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      /* 还没写 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

waitForPort(30_000).then((port) => {
  if (port === undefined) {
    if (backend.exitCode !== null) return; // 后端自己退了，exit 分支已经在收尾
    console.log("[dev-all] 等后端端口超时，前端按默认 8888 起（接口可能连不上）");
  } else {
    console.log(`[dev-all] 后端端口 = ${port}`);
  }
  start("frontend", "npm", ["run", "dev", "--prefix", "desktop"], ".", {
    VITE_MOMOKA_API: port ? `http://127.0.0.1:${port}` : undefined,
  });
});