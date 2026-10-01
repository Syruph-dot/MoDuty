import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CDP_PORT = 9233;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = await mkdtemp(path.join(tmpdir(), "momoka-ins-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "http://localhost:6429/"], { stdio: "ignore", windowsHide: true });
let ws;
try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(200); }
  }
  if (!version) throw new Error("CDP not reachable");
  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("http://localhost:6429/")}`, { method: "PUT" }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, (m) => res(m.result ?? m.error)); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  for (let i = 0; i < 40; i += 1) { const n = await evalJs(`document.querySelectorAll('.agent-tile').length`); if (n > 0) break; await sleep(500); }

  const readTiles = () => evalJs(`(() => { const wall = document.querySelector('.tile-wall'); const wr = wall.getBoundingClientRect(); const out = {}; for (const el of document.querySelectorAll('.tile-shell')) { const r = el.getBoundingClientRect(); out[el.getAttribute('data-tile-id')] = { left: Math.round(r.left - wr.left), top: Math.round(r.top - wr.top), w: Math.round(r.width), h: Math.round(r.height) }; } return out; })()`);
  const before = await readTiles();

  const create = await evalJs(`(async () => {
    const wall = document.querySelector('.tile-wall');
    const wr = wall.getBoundingClientRect();
    // 右键空白（非 tile-shell 区域）
    wall.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: wr.left + 90, clientY: wr.top + 90, button: 2 }));
    await new Promise((r) => setTimeout(r, 300));
    const menu = document.querySelector('.context-menu, [class*=menu]');
    const item = [...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.includes('New Agent'));
    if (!item) return { error: 'no menu item', menus: document.body.innerHTML.slice(0, 300) };
    item.click();
    await new Promise((r) => setTimeout(r, 300));
    const dialogInput = document.querySelector('.dialog__input');
    if (!dialogInput) return { error: 'no dialog input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(dialogInput, 'KeepLayoutAgent');
    dialogInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const createBtn = [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.includes('Create'));
    if (!createBtn) return { error: 'no create btn' };
    createBtn.click();
    await new Promise((r) => setTimeout(r, 1800));
    return { ok: true };
  })()`);
  const after = await readTiles();

  // 对比：已有 key 位置不变；新增 key
  const changed = [];
  const added = [];
  for (const [k, v] of Object.entries(after)) {
    if (before[k]) {
      if (JSON.stringify(before[k]) !== JSON.stringify(v)) changed.push({ k, before: before[k], after: v });
    } else {
      added.push({ k, rect: v });
    }
  }
  console.log(JSON.stringify({ create, changed, added, beforeKeys: Object.keys(before), afterKeys: Object.keys(after) }, null, 2));
} finally {
  if (ws) ws.close();
  chrome.kill();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}