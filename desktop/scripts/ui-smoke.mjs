// MOMOKA Desktop UI smoke probe —— headless Chrome over CDP（无 chrome-devtools MCP 的替代浏览器证据）
// 用法: node ui-smoke.mjs [pageUrl] [apiBase] [outFile]
// 依赖: 本机 Chrome + Node 22（原生 WebSocket / fetch）
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PAGE = process.argv[2] ?? "http://localhost:6429/";
const API = process.argv[3] ?? "http://localhost:7238";
const OUT = process.argv[4] ?? "ui-smoke-result.json";
/** SMOKE_EXPECT_STREAM=<text> 时进入流式令牌验证模式（配合 stub-chat-server 使用） */
const EXPECT_STREAM = process.env.SMOKE_EXPECT_STREAM ?? "";
/** SMOKE_APPROVAL=1 时进入审批面板验证模式（stub 端支持审批流） */
const APPROVAL_MODE = process.env.SMOKE_APPROVAL === "1";
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

  state.initial = await evaluate(`(async () => {
    const apiProbe = await fetch('/api/agents').then((r) => r.status, 0).catch((e) => 'fetch-failed:' + String(e));
    await new Promise((r) => setTimeout(r, 400));
    return {
      title: document.querySelector('.tile-wall__title')?.textContent ?? null,
      hasNewTile: Boolean(document.querySelector('.new-tile')),
      agentTileCount: document.querySelectorAll('.agent-tile').length,
      rootExists: Boolean(document.getElementById('root')),
      errorText: document.querySelector('.tile-wall__error')?.textContent ?? null,
      apiProbe,
    };
  })()`);

  if (APPROVAL_MODE) {
    // ---- 审批面板验证模式（stub）：waiting → 面板卡片 → 批准/拒绝 → SSE 驱动状态翻转 ----
    state.mode = "approval";
    const triggerChat = () =>
      fetch(`${API}/api/agents/agt_stubsample/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "run something" }),
      });

    await triggerChat();
    await sleep(1500);
    state.waiting = await evaluate(`({
      tileStates: [...document.querySelectorAll('.agent-tile__state')].map((el) => el.textContent),
      panelVisible: Boolean(document.querySelector('.approval-panel')),
      cardCount: document.querySelectorAll('.approval-card').length,
      toolName: document.querySelector('.approval-card__tool')?.textContent ?? null,
      cardArgs: document.querySelector('.approval-card__args')?.textContent ?? null,
    })`);

    await evaluate(`document.querySelector('.approval-card .btn--primary')?.click(); 'approved'`);
    await sleep(1200);
    state.afterApprove = await evaluate(`({
      panelGone: !document.querySelector('.approval-panel'),
      tileStates: [...document.querySelectorAll('.agent-tile__state')].map((el) => el.textContent),
      panelVisible: Boolean(document.querySelector('.approval-panel')),
    })`);

    await triggerChat();
    await sleep(1500);
    state.waitingReject = await evaluate(`({
      panelVisible: Boolean(document.querySelector('.approval-panel')),
      cardCount: document.querySelectorAll('.approval-card').length,
    })`);
    await evaluate(`document.querySelector('.approval-card .btn--ghost')?.click(); 'rejected'`);
    await sleep(1200);
    state.afterReject = await evaluate(`({
      panelGone: !document.querySelector('.approval-panel'),
      tileStates: [...document.querySelectorAll('.agent-tile__state')].map((el) => el.textContent),
    })`);
    await evaluate(`(() => { location.href = 'about:blank'; return 'done'; })()`);
  } else if (EXPECT_STREAM) {
    // ---- 流式令牌验证模式（stub 后端）：双击 → 发送 → agent 气泡逐字累积 ----
    state.mode = "token-stream";
    await evaluate(`(() => {
      const tile = document.querySelector('.agent-tile');
      tile?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return Boolean(tile);
    })()`);
    await sleep(1000);
    state.window = await evaluate(`({
      visible: Boolean(document.querySelector('.agent-window')),
      inputCount: document.querySelectorAll('.agent-window__input').length,
    })`);
    await evaluate(`(() => {
      const input = document.querySelector('.agent-window__input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'go');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);
    await sleep(250);
    state.afterType = await evaluate(`({
      inputValue: document.querySelector('.agent-window__input')?.value ?? null,
      sendDisabled: document.querySelector('.agent-window .btn--primary')?.disabled ?? null,
    })`);
    await evaluate(`document.querySelector('.agent-window .btn--primary')?.click(); 'sent'`);
    await sleep(500);
    state.afterSend = await evaluate(`({
      userBubble: [...document.querySelectorAll('.msg--user .msg__bubble')].map((el) => el.textContent),
      messageCount: document.querySelectorAll('.msg').length,
    })`);
    await sleep(1700); // 等 token 帧全部到达
    state.tokenStream = await evaluate(`(() => {
      const bubbles = [...document.querySelectorAll('.msg--agent .msg__bubble')];
      const last = bubbles[bubbles.length - 1];
      setTimeout(() => {
        const b2 = [...document.querySelectorAll('.msg--agent .msg__bubble')];
        const last2 = b2[b2.length - 1];
        window.__probeSnapshot = { countNow: document.querySelectorAll('.msg').length, agentText: last2?.textContent ?? null, errorShown: Boolean(document.querySelector('.agent-window__error')) };
      }, 1200);
      return { agentTextAtSend: last?.textContent ?? null, errorShownAtSend: Boolean(document.querySelector('.agent-window__error')) };
    })()`);
    await sleep(1400);
    state.tokenStreamFinal = await evaluate(`window.__probeSnapshot ?? null`);
    state.tokenStreamExpected = EXPECT_STREAM;
    await evaluate(`(() => { location.href = 'about:blank'; return 'done'; })()`);
  } else {
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

  // ---- 对话窗口（ISS-08）：双击打开 → 历史 → 发送 → 流式/错误 → 关闭 → 重开持久化 ----
  await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.agent-tile')];
    const tile = tiles.find((el) => el.querySelector('.agent-tile__name')?.textContent === 'Smoke Agent');
    tile?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Boolean(tile);
  })()`);
  await sleep(900);
  state.window = await evaluate(`({
    visible: Boolean(document.querySelector('.agent-window')),
    title: document.querySelector('.agent-window__title')?.textContent ?? null,
    messageCount: document.querySelectorAll('.msg').length,
    firstMsgText: document.querySelector('.msg__bubble')?.textContent ?? null,
  })`);

  // 发送新消息（无 API key → 流内 error 帧 → 显示错误 + 用户消息保留）
  await evaluate(`(() => {
    const input = document.querySelector('.agent-window__input');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'round two');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await sleep(150);
  await evaluate(`document.querySelector('.agent-window .btn--primary')?.click(); 'sent'`);
  await sleep(1500);
  state.windowAfterSend = await evaluate(`({
    userBubble: [...document.querySelectorAll('.msg--user .msg__bubble')].some((el) => el.textContent === 'round two'),
    errorShown: Boolean(document.querySelector('.agent-window__error')),
    errorText: document.querySelector('.agent-window__error')?.textContent ?? null,
    emptyAgentBubble: [...document.querySelectorAll('.msg--agent .msg__bubble')].some((el) => el.textContent === ''),
  })`);

  // 关闭回磁贴墙
  await evaluate(`document.querySelector('.agent-window__close')?.click(); 'closed'`);
  await sleep(500);
  state.afterClose = await evaluate(`({
    wallVisible: Boolean(document.querySelector('.tile-wall')),
    windowGone: !document.querySelector('.agent-window'),
  })`);

  // 重开：持久化消息（两轮 user 消息都在）
  await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.agent-tile')];
    const tile = tiles.find((el) => el.querySelector('.agent-tile__name')?.textContent === 'Smoke Agent');
    tile?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Boolean(tile);
  })()`);
  await sleep(900);
  state.afterReopen = await evaluate(`({
    windowVisible: Boolean(document.querySelector('.agent-window')),
    userBubbles: [...document.querySelectorAll('.msg--user .msg__bubble')].map((el) => el.textContent),
  })`);
  await evaluate(`document.querySelector('.agent-window__close')?.click(); 'closed'`);
  await sleep(400);

  // 清理：删除测试 Agent
  for (const agent of await (await fetch(`${API}/api/agents`)).json().then((d) => d.agents)) {
    await fetch(`${API}/api/agents/${agent.id}`, { method: "DELETE" });
  }
  state.cleanupDone = true;
  }
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