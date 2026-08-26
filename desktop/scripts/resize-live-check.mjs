// MOMOKA Desktop resize 实时性 smoke —— headless Chrome over CDP
// 验证：free 模式的 8 方向 resize 在拖动过程中壳尺寸/位置实时跟随鼠标（不等到松手才跳变）
// 用法: node resize-live-check.mjs [pageUrl] [apiBase] [outFile]
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PAGE = process.argv[2] ?? "http://localhost:5173/";
const API = process.argv[3] ?? "http://localhost:8888";
const OUT = process.argv[4] ?? "resize-live-result.json";
const CDP_PORT = 9225;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJson = async (url) => (await fetch(url)).json();

const userData = await mkdtemp(path.join(tmpdir(), "momoka-cdp-resize-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "about:blank"],
  { stdio: "ignore", windowsHide: true },
);

const state = { page: PAGE, api: API, startedAt: new Date().toISOString() };
const consoleErrors = [];
let ws;

try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) {
    try {
      version = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error("CDP endpoint not reachable");

  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(PAGE)}`, { method: "PUT" }).then((res) => res.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    } else if (data.method === "Runtime.exceptionThrown") {
      const detail = data.params?.exceptionDetails;
      consoleErrors.push(`exception: ${detail?.text ?? ""} ${detail?.exception?.description ?? ""}`);
    } else if (data.method === "Runtime.consoleAPICalled" && data.params?.type === "error") {
      consoleErrors.push(`console.error: ${JSON.stringify(data.params.args?.map((arg) => arg.value ?? arg.description) ?? [])}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(res.result.exceptionDetails)}`);
    return res.result?.result?.value;
  };

  await send("Runtime.enable");
  await sleep(2500);

  // 创建一个 agent（free 模式单磁贴）
  const created = await fetch(`${API}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Resize Probe", role: "smoke", workspace_dir: "D:\\\\smoke\\resize" }),
  }).then((r) => r.json());
  const agentId = created.agent.id;
  state.agentId = agentId;
  await evaluate(`(() => { location.reload(); return 'reloading'; })()`);
  await sleep(2600);

  const readRect = `(() => {
    const shell = document.querySelector('.tile-shell');
    if (!shell) return null;
    const r = shell.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  })()`;

  state.initial = await evaluate(readRect);

  // ---- SE 角：向右下拖 60×40，分 4 步，每步读取（应逐步增大） ----
  await evaluate(`(() => {
    const handle = document.querySelector('.tile-shell__handle--se');
    const r = handle.getBoundingClientRect();
    const sx = r.x + r.width / 2, sy = r.y + r.height / 2;
    window.__rx = sx; window.__ry = sy;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    return true;
  })()`);
  state.resizeSE = [];
  for (let i = 1; i <= 4; i += 1) {
    await evaluate(`document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: window.__rx + ${i * 15}, clientY: window.__ry + ${i * 10} })); 'mv'`);
    await sleep(40);
    state.resizeSE.push(await evaluate(readRect));
  }
  await evaluate(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: window.__rx + 60, clientY: window.__ry + 40 })); 'up'`);
  await sleep(400);
  state.resizeSEFinal = await evaluate(readRect);

  // ---- W 边：向左拖 40（x 减少 + w 增加），分 4 步 ----
  await evaluate(`(() => {
    const handle = document.querySelector('.tile-shell__handle--w');
    const r = handle.getBoundingClientRect();
    const sx = r.x + r.width / 2, sy = r.y + r.height / 2;
    window.__lx = sx; window.__ly = sy;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    return true;
  })()`);
  state.resizeW = [];
  for (let i = 1; i <= 4; i += 1) {
    await evaluate(`document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: window.__lx - ${i * 10}, clientY: window.__ly })); 'mv'`);
    await sleep(40);
    state.resizeW.push(await evaluate(readRect));
  }
  await evaluate(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: window.__lx - 40, clientY: window.__ly })); 'up'`);
  await sleep(400);
  state.resizeWFinal = await evaluate(readRect);
  state.initialW = state.initial;
  state.initialSEx = state.resizeSE[0];
  // 清理
  await fetch(`${API}/api/agents/${agentId}`, { method: "DELETE" });
  state.cleanupDone = true;
  state.ok = true;
  state.consoleErrors = consoleErrors;
} catch (error) {
  state.ok = false;
  state.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    ws?.close();
  } catch {
    /* noop */
  }
  chrome.kill();
  await sleep(300);
  await rm(userData, { recursive: true, force: true });
  await writeFile(OUT, JSON.stringify(state, null, 2), "utf8");
  console.log(JSON.stringify(state, null, 2));
  process.exit(state.ok ? 0 : 1);
}