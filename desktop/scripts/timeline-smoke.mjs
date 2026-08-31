import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CDP_PORT = 9229;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PAGE = "http://localhost:5173/";
const AGENT_ID = process.argv[2] ?? "agt_9a1ab1893da7";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = await mkdtemp(path.join(tmpdir(), "momoka-tl-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "about:blank"],
  { stdio: "ignore", windowsHide: true },
);
let ws;
try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error("CDP not reachable");
  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(PAGE)}`, { method: "PUT" }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, (m) => res(m.result ?? m.error));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  await send("Runtime.enable");
  for (let i = 0; i < 40; i += 1) {
    const ready = await evalJs(`document.querySelectorAll('.agent-tile').length`);
    if (ready > 0) break;
    await sleep(500);
  }
  const before = await evalJs(`({ tiles: document.querySelectorAll('.agent-tile').length, target: !!document.querySelector('[data-tile-id="${AGENT_ID}"]') })`);
  const opened = await evalJs(`(async () => {
    const t = document.querySelector('[data-tile-id="${AGENT_ID}"] .agent-tile');
    if (!t) return { error: 'no tile' };
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 30, button: 0 }));
    t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 30, button: 0 }));
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 30, button: 0 }));
    await new Promise((r) => setTimeout(r, 1800));
    const list = document.querySelector('[data-tile-id="${AGENT_ID}"] .agent-window__list');
    if (!list) return { error: 'no window' };
    const nodes = [...list.children];
    return {
      count: nodes.length,
      empty: !!list.querySelector('.agent-window__empty'),
      sequence: nodes.map((el) => {
        if (el.classList.contains('msg--user')) return 'USER';
        if (el.classList.contains('tool-card')) return 'TOOL:' + (el.querySelector('.tool-card__name')?.textContent ?? '?');
        if (el.classList.contains('msg--agent')) return 'AGENT:' + el.textContent.slice(0, 8);
        return 'OTHER';
      }),
    };
  })()`);
  console.log(JSON.stringify({ before, opened }, null, 2));
} finally {
  if (ws) ws.close();
  chrome.kill();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}