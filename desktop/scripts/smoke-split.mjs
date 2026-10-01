// MOMOKA Desktop 分屏交互 smoke —— headless Chrome over CDP
// 验证双几何布局：双击打开 → 左坞出现 / 右舞台展开；多窗 2n 与 2n+1 分布；× 关闭重排；header 拖到左坞收起
// 用法: node smoke-split.mjs [pageUrl] [apiBase] [outFile]
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PAGE = process.argv[2] ?? "http://localhost:6429/";
const API = process.argv[3] ?? "http://localhost:7238";
const OUT = process.argv[4] ?? "smoke-split-result.json";
const CDP_PORT = 9224;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJson = async (url) => (await fetch(url)).json();

const userData = await mkdtemp(path.join(tmpdir(), "momoka-cdp-split-"));
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
  await sleep(2500); // React 挂载 + store.load()

  // 创建 3 个 smoke agent 用于 2n / 2n+1 布局验证
  const created = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(`${API}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Split ${i}`, role: "smoke", workspace_dir: `D:\\\\smoke\\${i}` }),
    }).then((r) => r.json());
    created.push(res.agent.id);
  }
  state.createdAgentIds = created;
  await evaluate(`(() => { location.reload(); return 'reloading'; })()`);
  await sleep(2600);

  const tileInfo = `() => {
    const wall = document.querySelector('.tile-wall');
    const bounds = wall ? { w: wall.clientWidth, h: wall.clientHeight } : null;
    const shells = [...document.querySelectorAll('.tile-shell')];
    return {
      bounds,
      dockArea: document.querySelector('.dock-area') ? { x: document.querySelector('.dock-area').offsetLeft, w: document.querySelector('.dock-area').offsetWidth } : null,
      tiles: shells.map((s) => {
        const r = s.getBoundingClientRect();
        const flip = s.querySelector('.tile-flip');
        return { mode: s.dataset.tileMode, id: s.dataset.tileId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), flip: flip ? getComputedStyle(flip).transform : null };
      }),
      windows: document.querySelectorAll('.agent-window').length,
      tileCards: document.querySelectorAll('.agent-tile').length,
    };
  }`;
  const readTiles = () => evaluate(`(${tileInfo})()`);

  // ---- 1. 打开第一个：进入 open 模式，左坞出现，右舞台展开该磁贴 ----
  await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.agent-tile')];
    tiles[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Boolean(tiles[0]);
  })()`);
  await sleep(1100);
  state.openOne = await readTiles();

  // ---- 2. 打开第二个：2n 布局（n=1）→ 1 列上下两行 ----
  await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.agent-tile')];
    tiles[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Boolean(tiles[0]);
  })()`);
  await sleep(1100);
  state.openTwo = await readTiles();

  // ---- 3. 打开第三个：2n+1 布局（n=1）→ 2 列：前两个左列上下，第三个右列全高 ----
  await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.agent-tile')];
    const last = tiles[tiles.length - 1];
    last?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Boolean(last);
  })()`);
  await sleep(1100);
  state.openThree = await readTiles();

  // ---- 4. × 关闭第一个：右舞台重排为 2n（剩余两个上下） ----
  await evaluate(`(() => {
    const closeBtns = [...document.querySelectorAll('.agent-window__close')];
    closeBtns[0]?.click();
    return closeBtns.length;
  })()`);
  await sleep(180); // 退场翻转中途：背面应仍托住（窗口不消失），角度正在 180→0 途中
  state.closeMidFlight = await readTiles();
  await sleep(1100);
  state.afterCloseOne = await readTiles();

  // ---- 5. header 拖拽最后一个展开窗口到左坞 → 收起（回 dock），仅剩一个展开 ----
  await evaluate(`(async () => {
    // 找到最靠右的展开窗口（最后一个）
    const shells = [...document.querySelectorAll('.tile-shell[data-tile-mode="expanded"]')];
    const shell = shells[shells.length - 1];
    const header = shell?.querySelector('.agent-window__header');
    if (!shell || !header) return false;
    const r = header.getBoundingClientRect();
    const sx = r.x + 60, sy = r.y + 12;
    // mousedown 于 header → 多次 mousemove 拖到左坞（x < 30% 边界）→ mouseup
    header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    for (let i = 1; i <= 8; i += 1) {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx - i * 40, clientY: sy, button: 0 }));
      await new Promise((r2) => setTimeout(r2, 16));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx - 320, clientY: sy, button: 0 }));
    return true;
  })()`);
  await sleep(1200);
  state.afterDragToDock = await readTiles();

  // ---- 6. 全部关闭 → 回到自由摆放（无 dock、无窗口、全部 tile mode=free） ----
  await evaluate(`(() => {
    [...document.querySelectorAll('.agent-window__close')].forEach((b) => b.click());
    return true;
  })()`);
  await sleep(1100);
  state.afterCloseAll = await readTiles();

  // 清理
  for (const id of created) {
    await fetch(`${API}/api/agents/${id}`, { method: "DELETE" });
  }
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