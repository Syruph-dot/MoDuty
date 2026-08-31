import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CDP_PORT = 9231;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AGENT_ID = process.argv[2] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = await mkdtemp(path.join(tmpdir(), "momoka-reopen-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "http://localhost:5173/"], { stdio: "ignore", windowsHide: true });
let ws;
try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(200); }
  }
  if (!version) throw new Error("CDP not reachable");
  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("http://localhost:5173/")}`, { method: "PUT" }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, (m) => res(m.result ?? m.error)); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  for (let i = 0; i < 40; i += 1) { const n = await evalJs(`document.querySelectorAll('.agent-tile').length`); if (n > 0) break; await sleep(500); }

  const clickTile = () => evalJs(`(async () => {
    const t = document.querySelector('[data-tile-id="${AGENT_ID}"] .agent-tile');
    if (!t) return { error: 'no tile' };
    const r = t.getBoundingClientRect();
    for (const type of ['mousedown','mouseup','click']) t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 30, button: 0 }));
    await new Promise((r) => setTimeout(r, 900));
    return { ok: true };
  })()`);

  const readList = () => evalJs(`(() => {
    const list = document.querySelector('[data-tile-id="${AGENT_ID}"] .agent-window__list');
    if (!list) return { error: 'no window' };
    return {
      count: list.children.length,
      empty: !!list.querySelector('.agent-window__empty'),
      sequence: [...list.children].map((el) => {
        if (el.classList.contains('msg--user')) return 'USER';
        if (el.classList.contains('tool-card')) return 'TOOL:' + (el.querySelector('.tool-card__name')?.textContent ?? '?');
        if (el.classList.contains('msg--agent')) return 'AGENT(' + (el.textContent.length) + 'ch)';
        return 'OTHER';
      }),
    };
  })()`);

  const closeTile = () => evalJs(`(() => {
    const btn = document.querySelector('[data-tile-id="${AGENT_ID}"] .agent-window__close');
    if (!btn) return { error: 'no close btn' };
    btn.click();
    return { ok: true };
  })()`);

  // 1) 第一次打开
  await clickTile();
  const open1 = await readList();
  // 2) 关闭
  await closeTile();
  await sleep(800);
  // 3) 第二次打开
  await clickTile();
  const open2 = await readList();
  // 4) 关闭再第三次
  await closeTile();
  await sleep(800);
  await clickTile();
  const open3 = await readList();

  console.log(JSON.stringify({ open1, open2, open3 }, null, 2));
} finally {
  if (ws) ws.close();
  chrome.kill();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
