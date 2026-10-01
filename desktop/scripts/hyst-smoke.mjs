import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const CDP_PORT = 9239;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AGENT_ID = "agt_47b595b68160";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = await mkdtemp(path.join(tmpdir(), "momoka-hyst-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "http://localhost:6429/"], { stdio: "ignore", windowsHide: true });
let ws;
try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) { try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(200); } }
  if (!version) throw new Error("CDP not reachable");
  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("http://localhost:6429/")}`, { method: "PUT" }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, (m) => res(m.result ?? m.error)); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  for (let i = 0; i < 40; i += 1) { const n = await evalJs(`document.querySelectorAll('.agent-tile').length`); if (n > 0) break; await sleep(500); }
  const res = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tile = document.querySelector('[data-tile-id="${AGENT_ID}"] .agent-tile');
    const r = tile.getBoundingClientRect();
    const step = 85 + 8; // cellH+gap（5 行网格）
    const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
    const up = () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 }));
    const ghostLeft = () => document.querySelector('.tile-ghost')?.getBoundingClientRect().left ?? null;
    // 开始拖动 +0.3 格
    tile.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 }));
    await sleep(30);
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + 20, clientY: sy, button: 1 }));
    await sleep(40);
    // 1) 0.3 格：ghost 应仍在原位（初始 ghost = 磁贴位置）
    const step03 = Math.round(sx + step * 0.3);
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: step03, clientY: sy, button: 1 }));
    await sleep(60);
    const left03 = ghostLeft();
    // 2) 0.7 格：越过右缘 → ghost 右移一格
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + step * 0.7, clientY: sy, button: 1 }));
    await sleep(60);
    const left07 = ghostLeft();
    // 3) 回程 0.4 格：滞回，ghost 保持右移后的位置
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + step * 0.4, clientY: sy, button: 1 }));
    await sleep(60);
    const leftBack04 = ghostLeft();
    up();
    return { left03, left07, leftBack04, step, tileLeft: Math.round(r.left) };
  })()`);
  console.log(JSON.stringify(res, null, 2));
} finally {
  if (ws) ws.close();
  chrome.kill();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
