// MOMOKA Desktop UI smoke probe —— headless Chrome over CDP（无 chrome-devtools MCP 的替代浏览器证据）
// 用法: node ui-smoke.mjs [pageUrl] [apiBase] [outFile]
// 依赖: 本机 Chrome + Node 22（原生 WebSocket / fetch）
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PAGE = process.argv[2] ?? "http://localhost:5173/";
const API = process.argv[3] ?? "http://localhost:8888";
const OUT = process.argv[4] ?? "ui-smoke-result.json";
const CDP_PORT = 9223;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJson = async (url) => (await fetch(url)).json();

const userData = await mkdtemp(path.join(tmpdir(), "momoka-cdp-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "about:blank"],
  { stdio: "ignore", windowsHide: true },
);

const state = { page: PAGE, api: API, startedAt: new Date().toISOString() };
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
  await sleep(1800); // React 挂载 + store.load()

  state.initial = await evaluate(`({
    title: document.querySelector('.tile-wall__title')?.textContent ?? null,
    hasNewTile: Boolean(document.querySelector('.new-tile')),
    agentTileCount: document.querySelectorAll('.agent-tile').length,
    rootExists: Boolean(document.getElementById('root')),
  })`);

  // 经真实后端 API 建一个 Agent（等价于表单提交路径的数据结果）
  const created = await fetch(`${API}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Smoke Agent", role: "You are a smoke test agent.", workspace_dir: "D:\\\\smoke\\\\dir" }),
  }).then((res) => res.json());
  const agentId = created.agent.id;
  state.createdAgentId = agentId;

  await evaluate(`(() => { location.reload(); return 'reloading'; })()`);
  await sleep(2600);

  state.afterCreate = await evaluate(`({
    agentTileCount: document.querySelectorAll('.agent-tile').length,
    firstName: document.querySelector('.agent-tile__name')?.textContent ?? null,
    firstState: document.querySelector('.agent-tile__state')?.textContent ?? null,
    workspaceRow: document.querySelector('.agent-tile__row-value')?.textContent ?? null,
  })`);

  // 打开新建弹窗
  await evaluate(`document.querySelector('.new-tile')?.click(); 'clicked'`);
  await sleep(400);
  state.dialog = await evaluate(`({
    visible: Boolean(document.querySelector('[role="dialog"]')),
    title: document.querySelector('.dialog__title')?.textContent ?? null,
  })`);

  // 填写表单并提交（React 受控输入）
  await evaluate(`(() => {
    const dialog = document.querySelector('.dialog');
    if (!dialog) return 'no dialog';
    const inputs = dialog.querySelectorAll('input');
    const area = dialog.querySelector('textarea');
    const set = (el, val) => {
      if (!el) return 'missing';
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set';
    };
    set(inputs[0], 'Second Agent');
    set(area, 'You are the second.');
    set(inputs[1], 'D:\\\\smoke2');
    return [set(inputs[0], 'Second Agent'), set(area, 'You are the second.'), set(inputs[1], 'D:\\\\smoke2')];
  })()`);
  await sleep(200);
  await evaluate(`document.querySelector('.dialog .btn--primary')?.click(); 'submitted'`);
  await sleep(1200);
  state.afterSubmit = await evaluate(`({
    dialogGone: !document.querySelector('[role="dialog"]'),
    agentTileCount: document.querySelectorAll('.agent-tile').length,
    names: [...document.querySelectorAll('.agent-tile__name')].map((el) => el.textContent),
  })`);

  // SSE 驱动的状态变化：无 API key 的 chat 请求必然走 error 转移 → 磁贴徽章改 error
  const chatRes = await fetch(`${API}/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  const chatText = await chatRes.text();
  state.chatStreamContainsError = chatText.includes('"type":"error"');
  await sleep(1000);
  state.afterChat = await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.agent-tile')];
    const tile = tiles.find((el) => el.querySelector('.agent-tile__name')?.textContent === 'Smoke Agent');
    return tile
      ? { state: tile.querySelector('.agent-tile__state')?.textContent ?? null, className: tile.className }
      : null;
  })()`);

  // 清理：删除测试 Agent
  for (const agent of await (await fetch(`${API}/api/agents`)).json().then((d) => d.agents)) {
    await fetch(`${API}/api/agents/${agent.id}`, { method: "DELETE" });
  }
  state.cleanupDone = true;
  state.ok = true;
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