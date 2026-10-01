/**
 * 端口挑选的测试。
 *
 * 场景来自真实事故：Windows 上进程被强杀后会留下归属已死 PID 的残留监听，
 * dev 后端写死 8888 就"启动即闪退"。这里用真实 socket 覆盖三种判定：
 * 空闲 → 直接用；已有 MOMOKA → 拒绝（多实例会写坏 agents.json）；
 * 被别的服务占着（模拟幽灵监听）→ 跳过换下一个。
 *
 * 2026-10-01 又补了一轮“真实 listen”的回归网：打包版 sidecar 跑在 Bun 上，
 * `node:net` 的探测 bind 与 `node:http` 的 listen 结论会不一致（"预检说空闲"的
 * 端口一用就报 EADDRINUSE）。所以挑端口的最终判据必须是真的 listen，而不是预检，
 * 下面用真实端口占位 + 真实请求把这条性质钉住。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { inspectPort, listenOnFirstAvailable, listenOnPort, pickPort } from "../src/port-select.js";

/** 起一个最小 HTTP 服务；respond 决定它像不像 MOMOKA。 */
function listen(port: number, respond: (path: string) => { body: string; status?: number }): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const { body, status } = respond(request.url ?? "/");
      response.writeHead(status ?? 200, { "content-type": "text/plain; charset=utf-8" });
      response.end(body);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 拿一个空闲端口（先绑一次拿系统分配的端口号，再释放）。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

test("空闲端口判定为 free", async () => {
  const port = await freePort();
  assert.equal(await inspectPort(port, "127.0.0.1"), "free");
});

test("健康的 MOMOKA 判定为 momoka（而不是当成占用跳过）", async () => {
  const port = await freePort();
  const server = await listen(port, () => ({ body: "MOMOKA OK" }));
  try {
    assert.equal(await inspectPort(port, "127.0.0.1"), "momoka");
  } finally {
    await close(server);
  }
});

test("回了 200 但不是 MOMOKA 的服务判定为 other（否则会误认自家后端）", async () => {
  const port = await freePort();
  const server = await listen(port, () => ({ body: "hello, not your backend" }));
  try {
    assert.equal(await inspectPort(port, "127.0.0.1"), "other");
  } finally {
    await close(server);
  }
});

test("pickPort 越过 other、遇到 momoka 就返回它（不越过它另起一个）", async () => {
  const base = await freePort();
  // base 上放一个"别人的服务"（模拟残留监听），base+1 上放真正的 MOMOKA
  const stranger = await listen(base, () => ({ body: "docker or stale socket" }));
  const momoka = await listen(base + 1, () => ({ body: "MOMOKA OK" }));
  try {
    const pick = await pickPort({ base, tries: 5, host: "127.0.0.1" });
    assert.equal(pick.kind, "momoka");
    assert.equal(pick.port, base + 1);
    // 先扫全区间才决定，所以拒绝时不再带“跳过了谁”（那信息只在 free/none 时有用）
    assert.deepEqual(pick.skipped, []);
  } finally {
    await close(stranger);
    await close(momoka);
  }
});

test("已有 MOMOKA 跑在后面的端口上时，即使前面有空闲端口也要拒绝（不另起第二个）", async () => {
  const base = await freePort();
  // base 空闲、base+2 上已有另一个 MOMOKA：边扫边挑的写法会占用 base 再起一份。
  const momoka = await listen(base + 2, () => ({ body: "MOMOKA OK" }));
  try {
    const pick = await pickPort({ base, tries: 4, host: "127.0.0.1" });
    assert.equal(pick.kind, "momoka");
    assert.equal(pick.port, base + 2);
  } finally {
    await close(momoka);
  }
});

test("pickPort 一路被占到底时给出 none，并带上跳过原因", async () => {
  const base = await freePort();
  const servers = await Promise.all([
    listen(base, () => ({ body: "occupied" })),
    listen(base + 1, () => ({ body: "occupied" })),
  ]);
  try {
    const pick = await pickPort({ base, tries: 2, host: "127.0.0.1" });
    assert.equal(pick.kind, "none");
    assert.equal(pick.skipped.length, 2);
  } finally {
    for (const server of servers) {
      await close(server);
    }
  }
});

test("listenOnFirstAvailable 用真实 listen 逐个试：被占的跳过，且换端口后真的能服务", async () => {
  const base = await freePort();
  // 占住 base，逼它换端口。这正是旧实现会翻车的地方："探到空闲"的端口一到真正 listen 就报 EADDRINUSE。
  const blocker = await listen(base, () => ({ body: "occupied" }));
  const server = createServer((_request, response) => response.end("MOMOKA OK"));
  try {
    const bound = await listenOnFirstAvailable(server, base, 5, "127.0.0.1");
    assert.equal(bound.port, base + 1);
    assert.deepEqual(
      bound.skipped.map((item) => item.port),
      [base],
    );
    assert.match(bound.skipped[0].detail, /EADDRINUSE/);
    // 失败一次后再 listen 的 server 必须真的在服务（只断言"换到了 base+1"不够）
    const response = await fetch(`http://127.0.0.1:${bound.port}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "MOMOKA OK");
  } finally {
    await close(server);
    await close(blocker);
  }
});

test("listenOnFirstAvailable 一路被占到底时报错，并列出是哪些端口", async () => {
  const base = await freePort();
  const blockers = await Promise.all([
    listen(base, () => ({ body: "occupied" })),
    listen(base + 1, () => ({ body: "occupied" })),
  ]);
  const server = createServer();
  try {
    await assert.rejects(() => listenOnFirstAvailable(server, base, 2, "127.0.0.1"), (error: Error) => {
      assert.match(error.message, new RegExp(`从 ${base} 起的 2 个端口都监听不了`));
      assert.match(error.message, new RegExp(String(base + 1)));
      return true;
    });
  } finally {
    await close(server);
    for (const blocker of blockers) {
      await close(blocker);
    }
  }
});

test("listenOnPort 被占用时直接失败（显式 PORT 的语义，Tauri 壳依赖它）", async () => {
  const base = await freePort();
  const blocker = await listen(base, () => ({ body: "occupied" }));
  const server = createServer();
  try {
    await assert.rejects(() => listenOnPort(server, base, "127.0.0.1"), /already in use/);
  } finally {
    await close(server);
    await close(blocker);
  }
});

test("listenOnPort 空闲时严格用它，并且真的能服务", async () => {
  const port = await freePort();
  const server = createServer((_request, response) => response.end("MOMOKA OK"));
  try {
    await listenOnPort(server, port, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "MOMOKA OK");
  } finally {
    await close(server);
  }
});
