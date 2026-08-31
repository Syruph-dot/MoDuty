import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const CDP_PORT = 9241;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = await mkdtemp(path.join(tmpdir(), "momoka-duty-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "http://localhost:5173/"], { stdio: "ignore", windowsHide: true });
let ws;
try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) { try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(200); } }
  if (!version) throw new Error("CDP not reachable");
  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent("http://localhost:5173/")}`, { method: "PUT" }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, (m) => res(m.result ?? m.error)); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  for (let i = 0; i < 40; i += 1) { const n = await evalJs(`document.querySelectorAll('.agent-tile').length`); if (n > 0) break; await sleep(500); }

  const result = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wall = document.querySelector('.tile-wall');
    const wr = wall.getBoundingClientRect();
    // 右键空白 → Add widget
    wall.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: wr.left + 120, clientY: wr.top + 60, button: 2 }));
    await sleep(300);
    const menu = document.querySelector('.context-menu, [class*=menu]');
    const addItem = [...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.includes('Add widget'));
    if (!addItem) return { error: 'no add widget item' };
    addItem.click();
    await sleep(300);
    const dutyItem = [...document.querySelectorAll('.widget-picker__item')].find((b) => b.textContent.includes('值日生'));
    if (!dutyItem) return { error: 'no duty item', picker: document.querySelector('.widget-picker')?.textContent?.slice(0, 120) };
    dutyItem.click();
    await sleep(1200);
    // 磁贴尺寸
    const shell = [...document.querySelectorAll('.tile-shell')].find((el) => el.querySelector('.duty-girl'));
    if (!shell) return { error: 'no duty tile' };
    const r = shell.getBoundingClientRect();
    const size = { w: Math.round(r.width), h: Math.round(r.height) };
    // 点击立绘 → 对话框
    document.querySelector('.duty-girl__hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await sleep(400);
    const dialog = document.querySelector('.duty-dialog');
    const dialogOpen = !!dialog;
    // 输入并发送
    if (dialog) {
      const input = document.querySelector('.duty-dialog__input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '帮我创建一个新 Agent，名字叫 调度测试员，让它先别干活，只创建就好');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
      document.querySelector('.duty-dialog__send')?.click();
      await sleep(90000);
    }
    const msgs = [...document.querySelectorAll('.duty-dialog__msg')].map((m) => m.textContent?.slice(0, 80));
    return { size, dialogOpen, msgs, dutyInStorage: localStorage.getItem('momoka:duty:agentId') };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (ws) ws.close();
  chrome.kill();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
