/**
 * 受控浏览器路由（/api/browsers）。
 * 浏览器是独立实体（与 Agent 解耦）：磁贴/用户/Agent 工具共用同一后端实例。
 * 动作路由参考 agent-browser / Proma 受管浏览器：navigate / snapshot(refs) / click /
 * fill / press / dom / wait / js / screenshot / screencast(SSE 帧流)。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MomokaHttpError } from "../http-error.js";
import { browserService, toBrowserFriendlyError } from "../browser-service.js";
import { corsHeaders, json, readJsonBody, sseData } from "./http-utils.js";

export async function handleBrowserRoutes(
  _ctx: unknown,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  // 生命周期事件流（Agent 创建浏览器后前端自动开磁贴）
  if (request.method === "GET" && url.pathname === "/api/browsers/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      ...corsHeaders(),
    });
    const unsubscribe = browserService.onEvent((event) => {
      sseData(response, event);
    });
    request.on("close", unsubscribe);
    return true;
  }

  // 列表
  if (request.method === "GET" && url.pathname === "/api/browsers") {
    json(response, 200, { browsers: await browserService.list() });
    return true;
  }

  // 创建（不启动；磁贴打开时 launch）
  if (request.method === "POST" && url.pathname === "/api/browsers") {
    const body = await readJsonBody(request);
    const browser = await browserService.createInstance({
      name: typeof body.name === "string" ? body.name : undefined,
      mode: typeof body.mode === "string" ? (body.mode as "persistent" | "incognito") : undefined,
    });
    json(response, 200, { browser });
    return true;
  }

  const deleteMatch = url.pathname.match(/^\/api\/browsers\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    await browserService.deleteInstance(decodeURIComponent(deleteMatch[1] ?? ""));
    json(response, 200, { success: true });
    return true;
  }

  const browserMatch = url.pathname.match(/^\/api\/browsers\/([^/]+)\/([^/]+)$/);
  if (!browserMatch) {
    return false;
  }
  const rawId = decodeURIComponent(browserMatch[1] ?? "");
  const action = browserMatch[2] ?? "";
  const browser = await browserService.getInfo(rawId);
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw new MomokaHttpError(400, toBrowserFriendlyError(error, action));
    }
  };

  // launch / close
  if (action === "launch" && request.method === "POST") {
    json(response, 200, { browser: await run(() => browserService.launch(rawId)) });
    return true;
  }
  if (action === "close" && request.method === "POST") {
    await browserService.closeInstance(rawId);
    json(response, 200, { success: true });
    return true;
  }

  if (!browser) {
    throw new MomokaHttpError(404, `浏览器实例不存在: ${rawId}`);
  }

  // navigate
  if (action === "navigate" && request.method === "POST") {
    const body = await readJsonBody(request);
    const result = await run(() =>
      browserService.navigate(
        rawId,
        String(body.url ?? ""),
        (typeof body.wait_until === "string" ? body.wait_until : "domcontentloaded") as "load" | "domcontentloaded" | "commit",
      ),
    );
    if (!result) throw new MomokaHttpError(409, "浏览器未启动");
    json(response, 200, result);
    return true;
  }

  // snapshot（AX 树 + refs）
  if (action === "snapshot" && request.method === "POST") {
    const snapshot = await run(() => browserService.snapshot(rawId));
    json(response, 200, { tree: snapshot?.tree ?? "", refs: snapshot?.refs ?? {} });
    return true;
  }

  // click（selector 或 ref）
  if (action === "click" && request.method === "POST") {
    const body = await readJsonBody(request);
    await run(() => browserService.click(rawId, String(body.selector ?? ""), typeof body.ref === "string" ? body.ref : undefined));
    json(response, 200, { success: true });
    return true;
  }

  // 坐标点击（磁贴画面）
  if (action === "click_at" && request.method === "POST") {
    const body = await readJsonBody(request);
    await run(() => browserService.clickAt(rawId, Number(body.x ?? 0), Number(body.y ?? 0)));
    json(response, 200, { success: true });
    return true;
  }

  // fill
  if (action === "fill" && request.method === "POST") {
    const body = await readJsonBody(request);
    await run(() => browserService.fill(rawId, String(body.selector ?? ""), String(body.text ?? ""), typeof body.ref === "string" ? body.ref : undefined));
    json(response, 200, { success: true });
    return true;
  }

  // press / type
  if (action === "press" && request.method === "POST") {
    const body = await readJsonBody(request);
    await run(() => browserService.press(rawId, String(body.key ?? "")));
    json(response, 200, { success: true });
    return true;
  }

  // dom action（focus/fill/click/inspect）
  if (action === "dom" && request.method === "POST") {
    const body = await readJsonBody(request);
    const result = await run(() =>
      browserService.domAction(
        rawId,
        String(body.action ?? "") as "focus" | "fill" | "click" | "inspect",
        String(body.selector ?? ""),
        typeof body.text === "string" ? body.text : undefined,
      ),
    );
    json(response, 200, { result });
    return true;
  }

  // wait
  if (action === "wait" && request.method === "POST") {
    const body = await readJsonBody(request);
    const ok = await run(() =>
      browserService.waitFor(
        rawId,
        String(body.kind ?? "text") as "url" | "text" | "selector",
        String(body.value ?? ""),
        Number(body.timeout_ms ?? 10_000),
      ),
    );
    json(response, 200, { matched: ok });
    return true;
  }

  // execute js（最小脚本）
  if (action === "js" && request.method === "POST") {
    const body = await readJsonBody(request);
    const result = await run(() => browserService.executeJS(rawId, String(body.script ?? "")));
    json(response, 200, { result });
    return true;
  }

  // 单帧截图（缩略/产物）
  if (action === "screenshot" && request.method === "POST") {
    const dataUrl = await run(() => browserService.screenshot(rawId));
    json(response, 200, { data_url: dataUrl });
    return true;
  }

  // 实时帧流（SSE：data: {type:"frame", data_url} / {type:"info", ...}）
  if (action === "stream" && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      ...corsHeaders(),
    });
    const started = await browserService.screencast(rawId, true, (dataUrl) => {
      sseData(response, { type: "frame", data_url: dataUrl });
    });
    if (!started) {
      sseData(response, { type: "error", error: "浏览器未启动或流不可用" });
    }
    const info = await browserService.touch(rawId);
    if (info) sseData(response, { type: "info", browser: info });
    const timer = setInterval(async () => {
      const current = await browserService.touch(rawId);
      if (current) sseData(response, { type: "info", browser: current });
    }, 3000);
    request.on("close", () => {
      clearInterval(timer);
      void browserService.screencast(rawId, false);
    });
    return true;
  }

  // touch：刷新元信息
  if (action === "touch" && request.method === "POST") {
    json(response, 200, { browser: await browserService.touch(rawId) });
    return true;
  }

  return false;
}