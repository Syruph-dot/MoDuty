//! WebView2 桥（生产版）：把尖刀验证过的能力做成可用的服务面。
//!
//! 职责边界：
//! 1. **子 webview 生命周期**：按 `(browserId, tabId)` 创建 / 关闭 / 列举子 webview；
//! 2. **矩形跟随**：`set_bounds`（物理像素），拖拽缩放磁贴时由前端喂进来；
//! 3. **可见性与 z 序**：`show` / `hide`（切标签、宿主切换时用）；
//!    `stack`（被卡片/窗口盖住时把子 webview 压到主 webview 之下，不动 `IsVisible`）；
//! 4. **CDP 直通**：`cdp` / `eval`，走 `ICoreWebView2Controller`，不开远程调试端口；
//! 5. **对外通道**：只监听 `127.0.0.1` 的 HTTP 端点 + 一次性 token 文件，
//!    供同机的后端 sidecar 驱动页面（后端与 UI 是**两个进程**，必须有一条通道）。
//!
//! 两条入口共用同一套操作（`ops::*`）：
//! - Tauri 命令：给前端用（前端知道磁贴矩形，负责创建与定位）；
//! - HTTP 端点：给后端用（后端负责页面操作与 CDP）。
//!
//! 已知取舍：
//! - token 文件放在 `%TEMP%`，与既有的 `moduty.momoka.port` 同目录同权限；
//! - 端点绑 `127.0.0.1` + 端口 0（随机），进程退出即消失；
//! - `MOMOKA_WEBVIEW_BRIDGE=0` 可整体关闭。

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{
  AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Size, WebviewBuilder,
  WebviewUrl,
};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
use webview2_com::{
  CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
};
use windows::core::HSTRING;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
  SetWindowPos, HWND_BOTTOM, HWND_TOP, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
  SWP_NOSIZE,
};

/// CDP 单次调用超时
pub const CDP_TIMEOUT: Duration = Duration::from_secs(15);
/// 派发到 UI 线程并等结果的超时
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(20);
/// HTTP 请求体上限（只传 CDP 参数与矩形，不需要大 body）
const MAX_BODY_BYTES: usize = 1 << 20;

// ============================================================================
// 桥的注册信息
// ============================================================================

#[derive(Clone)]
struct BridgeHandle {
  port: u16,
}

/// 进程内已启动的桥（供 `info()` 报状态；token 只在文件与线程闭包里流转，不进内存快照）

static BRIDGE: OnceLock<Mutex<Option<BridgeHandle>>> = OnceLock::new();

fn bridge_slot() -> &'static Mutex<Option<BridgeHandle>> {
  BRIDGE.get_or_init(|| Mutex::new(None))
}

/// token 文件路径。后端 sidecar 读它拿到端口与 token。
pub fn bridge_file_path() -> PathBuf {
  let mut dir = std::env::temp_dir();
  dir.push("moduty.momoka.bridge");
  dir
}

/// 32 字节随机 token（BCryptGenRandom）。本地单用户场景够用，且不可预测。
fn random_token() -> String {
  use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
  let mut bytes = [0u8; 32];
  let status = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
  if status.is_err() {
    // 极端兜底：时间 + 进程内随机哈希（不可预测性下降，但不至于没 token）
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&std::time::SystemTime::now(), &mut hasher);
    std::hash::Hash::hash(&std::process::id(), &mut hasher);
    let mut value = std::hash::Hasher::finish(&hasher).to_le_bytes().to_vec();
    while value.len() < 32 {
      value.extend_from_slice(&value.clone()[..(32 - value.len()).min(value.len())]);
    }
    value.truncate(32);
    return value.iter().map(|b| format!("{b:02x}")).collect();
  }
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 启动桥：绑回环随机端口、写 token 文件、进入 accept 循环。
/// 返回端口；被禁用或绑定失败时返回 None（调用方只记日志，不影响主流程）。
pub fn start(app: AppHandle) -> Option<u16> {
  if std::env::var("MOMOKA_WEBVIEW_BRIDGE").map(|v| v == "0" || v.eq_ignore_ascii_case("false")).unwrap_or(false) {
    log_line("[bridge] 已被 MOMOKA_WEBVIEW_BRIDGE 关闭");
    return None;
  }
  let listener = match TcpListener::bind(("127.0.0.1", 0)) {
    Ok(listener) => listener,
    Err(err) => {
      log_line(&format!("[bridge] 绑定失败：{err}"));
      return None;
    }
  };
  let port = match listener.local_addr() {
    Ok(address) => address.port(),
    Err(err) => {
      log_line(&format!("[bridge] 读取端口失败：{err}"));
      return None;
    }
  };
  let token = random_token();
  {
    let mut slot = bridge_slot().lock().unwrap();
    *slot = Some(BridgeHandle { port });
  }
  write_bridge_file(port, &token);
  log_line(&format!("[bridge] 已监听 127.0.0.1:{port}，token 文件 {}", bridge_file_path().display()));

  let app_for_thread = app.clone();
  let result = thread::Builder::new()
    .name("moduty.webview-bridge".to_string())
    .spawn(move || {
      for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let app = app_for_thread.clone();
        let token = token.clone();
        // 每个请求一个线程：CDP 调用是阻塞的，不能串行化整个端点
        let _ = thread::Builder::new()
          .name("moduty.webview-bridge-req".to_string())
          .spawn(move || {
            let _ = handle_connection(stream, &app, &token);
          });
      }
    });
  match result {
    Ok(_) => Some(port),
    Err(err) => {
      log_line(&format!("[bridge] 线程启动失败：{err}"));
      None
    }
  }
}

/// 退出时清理 token 文件（与端口文件同一处理时机）
pub fn cleanup() {
  let _ = fs::remove_file(bridge_file_path());
  let mut slot = bridge_slot().lock().unwrap();
  *slot = None;
}

pub fn info() -> Value {
  let slot = bridge_slot().lock().unwrap();
  match slot.as_ref() {
    Some(handle) => json!({ "enabled": true, "port": handle.port, "bridge_file": bridge_file_path().display().to_string() }),
    None => json!({ "enabled": false }),
  }
}

fn write_bridge_file(port: u16, token: &str) {
  let payload = json!({
    "port": port,
    "token": token,
    "pid": std::process::id(),
    "writtenAt": std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0),
  });
  if let Err(err) = fs::write(bridge_file_path(), payload.to_string()) {
    log_line(&format!("[bridge] 写 token 文件失败：{err}"));
  }
}

/// 与 main.rs 里其它日志同一格式，便于一起排查
fn log_line(message: &str) {
  println!("{message}");
}

// ============================================================================
// 操作面（Tauri 命令与 HTTP 端点共用）
// ============================================================================

/// label 只允许 `[A-Za-z0-9_-]`，且要能从 (browserId, tabId) 推出来、可反解。
pub fn label_for(browser_id: &str, tab_id: &str) -> String {
  format!("tile-{}-{}", sanitize(browser_id), sanitize(tab_id))
}

fn sanitize(value: &str) -> String {
  value
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
    .collect()
}

fn as_i32(value: &Value, key: &str) -> Result<i32, String> {
  value
    .get(key)
    .and_then(Value::as_i64)
    .map(|v| v as i32)
    .ok_or_else(|| format!("缺少或非法字段：{key}"))
}

fn as_str_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
  value.get(key).and_then(Value::as_str).ok_or_else(|| format!("缺少或非法字段：{key}"))
}

/// 把闭包派发到 UI 线程执行并等结果。
/// 子 webview 的创建/定位/显隐都必须在 UI 线程上做。
fn on_main_thread<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
  T: Send + 'static,
  F: FnOnce() -> Result<T, String> + Send + 'static,
{
  let (tx, rx) = mpsc::channel::<Result<T, String>>();
  app
    .run_on_main_thread(move || {
      let _ = tx.send(work());
    })
    .map_err(|err| format!("派发到 UI 线程失败：{err}"))?;
  rx.recv_timeout(MAIN_THREAD_TIMEOUT)
    .map_err(|err| format!("等待 UI 线程结果超时：{err}"))?
}

/// 创建（或重建）一个子 webview。
pub fn open(app: &AppHandle, spec: Value) -> Result<Value, String> {
  let label = spec.get("label").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
    let browser_id = spec.get("browserId").and_then(Value::as_str).unwrap_or("brw_unknown");
    let tab_id = spec.get("tabId").and_then(Value::as_str).unwrap_or("tab0");
    label_for(browser_id, tab_id)
  });
  let url = as_str_field(&spec, "url")?.to_string();
  let profile_dir = spec.get("profileDir").and_then(Value::as_str).map(str::to_string);
  let incognito = spec.get("incognito").and_then(Value::as_bool).unwrap_or(false);
  let bounds = spec.get("bounds").cloned().unwrap_or(Value::Null);
  let (x, y, width, height) = read_bounds(&bounds)?;
  // devtools：生产默认关闭，需要时由调用方显式打开
  let devtools = spec.get("devtools").and_then(Value::as_bool).unwrap_or(false);

  let label_for_thread = label.clone();
  let app_handle = app.clone();
  on_main_thread(app, move || {
    let window = app_handle.get_window("main").ok_or_else(|| "找不到主窗口".to_string())?;
    let parsed = url.parse().map_err(|err| format!("URL 解析失败（{url}）：{err}"))?;
    let mut builder = WebviewBuilder::new(label_for_thread.clone(), WebviewUrl::External(parsed))
      .incognito(incognito)
      .devtools(devtools)
      // 下载不做接管，但必须留下痕迹：WebView2 的下载默认没有 UI 反馈点，
      // 不打日志的话“点了下载没反应”无法排查。返回 true 表示走默认行为。
      .on_download(|_webview, event| {
        match event {
          tauri::webview::DownloadEvent::Requested { url, .. } => log_line(&format!("[bridge] 下载请求：{url}")),
          tauri::webview::DownloadEvent::Finished { url, success, .. } => {
            log_line(&format!("[bridge] 下载结束：{url} success={success}"))
          }
          _ => log_line("[bridge] 下载事件（未知类型）"),
        }
        true
      });
    if let Some(dir) = profile_dir {
      builder = builder.data_directory(PathBuf::from(dir));
    }
    // 同 label 重建：先把旧的关掉，避免两个 webview 抢同一个 label
    if let Some(existing) = app_handle.get_webview(&label_for_thread) {
      let _ = existing.close();
    }
    window
      .add_child(builder, PhysicalPosition::new(x, y), PhysicalSize::new(width, height))
      .map_err(|err| format!("add_child 失败：{err}"))?;
    Ok(())
  })?;

  // 可选：创建后等到指定 URL 前缀就绪再返回。
  // 前端建磁贴时用它，避免拿到一个还在 about:blank 的 webview 就去算坐标。
  if let Some(prefix) = spec.get("waitForPrefix").and_then(Value::as_str) {
    let timeout_ms = spec.get("waitForTimeoutMs").and_then(Value::as_u64).unwrap_or(30_000);
    wait_ready(app, &label, prefix, Duration::from_millis(timeout_ms))?;
  }
  Ok(json!({ "ok": true, "label": label, "bounds": { "x": x, "y": y, "w": width, "h": height } }))
}

/// 矩形跟随（物理像素）。前端负责把 CSS 像素乘上 devicePixelRatio。
pub fn set_bounds(app: &AppHandle, label: &str, bounds: Value) -> Result<Value, String> {
  let (x, y, width, height) = read_bounds(&bounds)?;
  let label = label.to_string();
  let label_for_thread = label.clone();
  let app_handle = app.clone();
  on_main_thread(app, move || {
    let webview = app_handle.get_webview(&label_for_thread).ok_or_else(|| format!("webview 不存在：{label_for_thread}"))?;
    webview
      .set_bounds(Rect {
        position: Position::Physical(PhysicalPosition::new(x, y)),
        size: Size::Physical(PhysicalSize::new(width, height)),
      })
      .map_err(|err| format!("set_bounds 失败：{err}"))
  })
  .map(|_| json!({ "ok": true, "label": label, "bounds": { "x": x, "y": y, "w": width, "h": height } }))
}

/// 显隐：切标签、宿主切换、窗口遮挡时用。**不要**用销毁来隐藏（会丢页面状态）。
///
/// 注意：隐藏会丢掉合成表面，`Page.captureScreenshot` 只能拿到空数据（见 browser-transport-bridge
/// 的取舍说明）。「被别的卡片盖住」这种纯 z 序问题请用 `set_stacked`，不要用 hide。
pub fn set_visible(app: &AppHandle, label: &str, visible: bool) -> Result<Value, String> {
  let label = label.to_string();
  let label_for_thread = label.clone();
  let app_handle = app.clone();
  on_main_thread(app, move || {
    let webview = app_handle.get_webview(&label_for_thread).ok_or_else(|| format!("webview 不存在：{label_for_thread}"))?;
    let result = if visible { webview.show() } else { webview.hide() };
    result.map_err(|err| format!("可见性切换失败：{err}"))
  })
  .map(|_| json!({ "ok": true, "label": label, "visible": visible }))
}

/// z 序：把子 webview 的容器窗口压到主 webview 之下（behind=true）或提回最上层（behind=false）。
///
/// 为什么需要它：子 webview 是独立的子 HWND（wry `create_container_hwnd` 用 WS_CHILD 建，创建时设 `HWND_TOP`），
/// DOM 的 z-index 管不到它——它会一直盖在主 webview 之上，所以“卡片盖住浏览器”永远不成立。
/// 而 hide 会丢合成表面（截图变空，见上），所以这里只改 z 序、**不动 `IsVisible`**：
/// 视觉上被 DOM 盖住，但 WebView2 继续渲染，CDP 截图不受影响。
///
/// 注：wry 的 `set_bounds` 用的是 `SWP_NOZORDER`，所以设过的 z 序不会被后续矩形更新冲掉。
pub fn set_stacked(app: &AppHandle, label: &str, behind: bool) -> Result<Value, String> {
  let label = label.to_string();
  let webview_label = label.clone();
  let webview = app
    .get_webview(&webview_label)
    .ok_or_else(|| format!("webview 不存在：{webview_label}"))?;
  let (tx, rx) = mpsc::channel::<Result<(), String>>();
  webview
    .with_webview(move |platform| {
      // 同步调用：闭包返回前就发完结果，所以在 with_webview 外面 recv 不会死锁
      let _ = tx.send(apply_z_order(&platform.controller(), behind));
    })
    .map_err(|err| format!("with_webview(stacked) 失败：{err}"))?;
  match rx.recv_timeout(MAIN_THREAD_TIMEOUT) {
    Ok(result) => {
      result?;
      Ok(json!({ "ok": true, "label": label, "behind": behind }))
    }
    Err(err) => Err(format!("set_stacked 等待结果失败：{err}")),
  }
}

/// UI 线程侧：子 webview 容器的 z 序翻转（纯 Win32，立刻返回）。
///
/// `controller.ParentWindow()` 就是 wry 承载该 webview 的容器 HWND（`CreateCoreWebView2Controller` 的入参）。
fn apply_z_order(controller: &ICoreWebView2Controller, behind: bool) -> Result<(), String> {
  let mut hwnd = HWND::default();
  unsafe { controller.ParentWindow(&mut hwnd) }.map_err(|err| format!("ParentWindow 失败：{err}"))?;
  let insert_after = if behind { HWND_BOTTOM } else { HWND_TOP };
  unsafe {
    SetWindowPos(
      hwnd,
      Some(insert_after),
      0,
      0,
      0,
      0,
      SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER,
    )
  }
  .map_err(|err| format!("SetWindowPos 失败：{err}"))
}

pub fn close(app: &AppHandle, label: &str) -> Result<Value, String> {
  let label = label.to_string();
  let label_for_thread = label.clone();
  let app_handle = app.clone();
  on_main_thread(app, move || match app_handle.get_webview(&label_for_thread) {
    Some(webview) => webview.close().map_err(|err| format!("close 失败：{err}")),
    // 已经不在就是幂等成功
    None => Ok(()),
  })
  .map(|_| json!({ "ok": true, "label": label }))
}

/// 列举当前子 webview（排除主窗口自己的 webview）
pub fn list(app: &AppHandle) -> Value {
  let labels = app.webviews().keys().cloned().collect::<Vec<_>>();
  let tiles = labels.iter().filter(|label| label.starts_with("tile-")).cloned().collect::<Vec<_>>();
  json!({ "labels": labels, "tiles": tiles })
}

fn read_bounds(bounds: &Value) -> Result<(i32, i32, u32, u32), String> {
  let x = as_i32(bounds, "x")?;
  let y = as_i32(bounds, "y")?;
  let w = as_i32(bounds, "w")?;
  let h = as_i32(bounds, "h")?;
  if w < 0 || h < 0 {
    return Err("矩形尺寸不能为负".to_string());
  }
  Ok((x, y, w as u32, h as u32))
}

/// 主窗口（子 webview 挂在它下面）——由各操作内部的闭包用 `app_handle` 直接取，
/// 不做无句柄的辅助函数（`AppHandle` 必须显式传入或 clone 进闭包）。

// ============================================================================
// CDP 直通（不开远程调试端口）
// ============================================================================

/// 直接在控制器上发 CDP（`CallDevToolsProtocolMethod`）。
///
/// 线程约束（尖刀实测）：调用必须发生在 UI 线程（`with_webview` 里），但**等待结果不能
/// 在 UI 线程**——完成回调也投递到 UI 线程消息循环，在 UI 线程上阻塞等它会死锁。
/// 所以这里只负责"发起 + 把结果丢进 channel"，真正的等待放在 `with_webview` 之外。
pub fn cdp(app: &AppHandle, label: &str, method: &str, params: &str, timeout: Duration) -> Result<String, String> {
  let webview = app.get_webview(label).ok_or_else(|| format!("webview 不存在：{label}"))?;
  let (tx, rx) = mpsc::channel::<Result<String, String>>();
  let tx_start = tx.clone();
  let (method_owned, params_owned) = (method.to_string(), params.to_string());
  webview
    .with_webview(move |platform| {
      let controller = platform.controller();
      if let Err(err) = call_cdp(&controller, &method_owned, &params_owned, tx) {
        let _ = tx_start.send(Err(err));
      }
    })
    .map_err(|err| format!("with_webview({method}) 失败：{err}"))?;
  // 必须区分两种错误：把所有错误都归成“超时”会把“发送端提前释放”伪装成 15s 超时
  // （实际 2ms 返回），排查时会被彻底带偏。
  match rx.recv_timeout(timeout) {
    Ok(result) => result,
    Err(mpsc::RecvTimeoutError::Timeout) => Err(format!("CDP {method} 超时（{}ms）", timeout.as_millis())),
    Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!(
      "CDP {method} 通道断开：with_webview 闭包已返回但完成回调未回传结果（webview 可能已被关闭或不处于可驱动状态）"
    )),
  }
}

/// UI 线程侧：纯 COM 调用，立刻返回。
fn call_cdp(
  controller: &ICoreWebView2Controller,
  method: &str,
  params: &str,
  tx: mpsc::Sender<Result<String, String>>,
) -> Result<(), String> {
  let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }.map_err(|err| format!("CoreWebView2 失败：{err}"))?;
  let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, payload: String| {
    let _ = if hr.is_ok() {
      tx.send(Ok(payload))
    } else {
      tx.send(Err(format!("CDP 调用失败 hr={hr:?}：{payload}")))
    };
    Ok(())
  }));
  let method = HSTRING::from(method);
  let params = HSTRING::from(params);
  // `CallDevToolsProtocolMethod` 返回的就是 CDP 消息里的 result 载荷，外面没有再包一层
  unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) }
    .map_err(|err| format!("CallDevToolsProtocolMethod 失败：{err}"))
}

/// `Runtime.evaluate` + `returnByValue`，直接拿 JS 值。
pub fn eval(app: &AppHandle, label: &str, expression: &str) -> Result<Value, String> {
  let params = json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }).to_string();
  let raw = cdp(app, label, "Runtime.evaluate", &params, CDP_TIMEOUT)?;
  let value: Value = serde_json::from_str(&raw).map_err(|err| format!("CDP 返回不是合法 JSON：{err}"))?;
  if let Some(details) = value.get("exceptionDetails") {
    return Err(format!("js exception: {details}"));
  }
  value
    .pointer("/result/value")
    .cloned()
    .ok_or_else(|| format!("CDP eval 载荷形状异常：{raw}"))
}

/// 等到「目标 URL 上确实加载完成」。
///
/// 关键：子 webview 一创建是 `about:blank`，而 `about:blank` 的 readyState 也是 complete——
/// 只看 readyState 会在导航开始前就"通过"，随后所有 eval 都打在不透明源上
/// （写 `localStorage` 会直接抛 SecurityError）。所以必须同时匹配 URL 前缀。
pub fn wait_ready(app: &AppHandle, label: &str, expect_prefix: &str, timeout: Duration) -> Result<Value, String> {
  let deadline = std::time::Instant::now() + timeout;
  let mut last = json!(null);
  while std::time::Instant::now() < deadline {
    match eval(app, label, "({ href: location.href, ready: document.readyState })") {
      Ok(value) => {
        let href = value.get("href").and_then(Value::as_str).unwrap_or("");
        let ready = value.get("ready").and_then(Value::as_str).unwrap_or("");
        if href.starts_with(expect_prefix) && ready == "complete" {
          return Ok(value);
        }
        last = value;
      }
      Err(err) => last = json!(err),
    }
    thread::sleep(Duration::from_millis(200));
  }
  Err(format!("wait_ready({expect_prefix}) 超时，最后状态：{last}"))
}

// ============================================================================
// 只监听回环的 HTTP 端点
// ============================================================================

fn handle_connection(mut stream: TcpStream, app: &AppHandle, token: &str) -> std::io::Result<()> {
  let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
  let request = match read_request(&mut stream) {
    Ok(request) => request,
    Err(err) => return write_response(&mut stream, 400, &json!({ "error": err.to_string() })),
  };
  if !authorized(&request, token) {
    return write_response(&mut stream, 401, &json!({ "error": "token 无效" }));
  }

  let body: Value = if request.body.trim().is_empty() {
    json!({})
  } else {
    match serde_json::from_str(&request.body) {
      Ok(value) => value,
      Err(err) => return write_response(&mut stream, 400, &json!({ "error": format!("请求体不是合法 JSON：{err}") })),
    }
  };

  let result = dispatch(app, &request.method, &request.path, body);
  match result {
    Ok(value) => write_response(&mut stream, 200, &value),
    Err(message) => write_response(&mut stream, 500, &json!({ "error": message })),
  }
}

fn dispatch(app: &AppHandle, method: &str, path: &str, body: Value) -> Result<Value, String> {
  match (method, path) {
    ("GET", "/health") => Ok(json!({ "ok": true, "webviews": list(app) })),
    ("GET", "/webviews") => Ok(list(app)),
    ("POST", "/webviews") => open(app, body),
    ("POST", "/webviews/bounds") => {
      let label = as_str_field(&body, "label")?.to_string();
      let bounds = body.get("bounds").cloned().unwrap_or(Value::Null);
      set_bounds(app, &label, bounds)
    }
    ("POST", "/webviews/visible") => {
      let label = as_str_field(&body, "label")?.to_string();
      let visible = body.get("visible").and_then(Value::as_bool).unwrap_or(true);
      set_visible(app, &label, visible)
    }
    ("POST", "/webviews/stacked") => {
      let label = as_str_field(&body, "label")?.to_string();
      let behind = body.get("behind").and_then(Value::as_bool).unwrap_or(true);
      set_stacked(app, &label, behind)
    }
    ("POST", "/webviews/close") => {
      let label = as_str_field(&body, "label")?.to_string();
      close(app, &label)
    }
    ("POST", "/cdp") => {
      let label = as_str_field(&body, "label")?.to_string();
      let cdp_method = as_str_field(&body, "method")?.to_string();
      let params = body.get("params").map(|value| value.to_string()).unwrap_or_else(|| "{}".to_string());
      let raw = cdp(app, &label, &cdp_method, &params, CDP_TIMEOUT)?;
      Ok(json!({ "result": raw }))
    }
    ("POST", "/eval") => {
      let label = as_str_field(&body, "label")?.to_string();
      let expression = as_str_field(&body, "expression")?.to_string();
      let value = eval(app, &label, &expression)?;
      Ok(json!({ "value": value }))
    }
    ("POST", "/wait-ready") => {
      let label = as_str_field(&body, "label")?.to_string();
      let prefix = as_str_field(&body, "prefix")?.to_string();
      let timeout_ms = body.get("timeoutMs").and_then(Value::as_u64).unwrap_or(30_000);
      let value = wait_ready(app, &label, &prefix, Duration::from_millis(timeout_ms))?;
      Ok(json!({ "state": value }))
    }
    _ => Err(format!("未知端点：{method} {path}")),
  }
}

struct HttpRequest {
  method: String,
  path: String,
  query: HashMap<String, String>,
  headers: HashMap<String, String>,
  body: String,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
  let mut buffer = Vec::<u8>::new();
  let mut chunk = [0u8; 4096];
  let header_end;
  loop {
    let read = stream.read(&mut chunk)?;
    if read == 0 {
      return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "连接在请求头读完前关闭"));
    }
    buffer.extend_from_slice(&chunk[..read]);
    if let Some(position) = find_double_crlf(&buffer) {
      header_end = position;
      break;
    }
    if buffer.len() > 64 * 1024 {
      return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "请求头过大"));
    }
  }

  let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
  let mut lines = head.split("\r\n");
  let request_line = lines.next().unwrap_or("");
  let mut parts = request_line.split_whitespace();
  let method = parts.next().unwrap_or("").to_string();
  let target = parts.next().unwrap_or("/").to_string();

  let mut headers = HashMap::new();
  for line in lines {
    if let Some((name, value)) = line.split_once(':') {
      headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
  }

  let (path, query) = match target.split_once('?') {
    Some((path, query)) => (path.to_string(), parse_query(query)),
    None => (target, HashMap::new()),
  };

  let content_length = headers
    .get("content-length")
    .and_then(|value| value.parse::<usize>().ok())
    .unwrap_or(0);
  if content_length > MAX_BODY_BYTES {
    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "请求体过大"));
  }

  let mut body_bytes = buffer[(header_end + 4).min(buffer.len())..].to_vec();
  while body_bytes.len() < content_length {
    let read = stream.read(&mut chunk)?;
    if read == 0 {
      break;
    }
    body_bytes.extend_from_slice(&chunk[..read]);
  }
  let body = String::from_utf8_lossy(&body_bytes[..content_length.min(body_bytes.len())]).to_string();

  Ok(HttpRequest { method, path, query, headers, body })
}

fn find_double_crlf(buffer: &[u8]) -> Option<usize> {
  buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_query(query: &str) -> HashMap<String, String> {
  let mut map = HashMap::new();
  for pair in query.split('&') {
    if let Some((key, value)) = pair.split_once('=') {
      map.insert(key.to_string(), decode_url_component(value));
    }
  }
  map
}

fn decode_url_component(value: &str) -> String {
  let bytes = value.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index] == b'%' && index + 2 < bytes.len() {
      let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
      if let Ok(byte) = u8::from_str_radix(hex, 16) {
        out.push(byte);
        index += 3;
        continue;
      }
    }
    out.push(bytes[index]);
    index += 1;
  }
  String::from_utf8_lossy(&out).to_string()
}

fn authorized(request: &HttpRequest, token: &str) -> bool {
  if let Some(header) = request.headers.get("authorization") {
    if let Some(value) = header.strip_prefix("Bearer ") {
      if value.trim() == token {
        return true;
      }
    }
  }
  request.query.get("token").map(|value| value == token).unwrap_or(false)
}

fn write_response(stream: &mut TcpStream, status: u16, payload: &Value) -> std::io::Result<()> {
  let body = payload.to_string();
  let reason = match status {
    200 => "OK",
    400 => "Bad Request",
    401 => "Unauthorized",
    500 => "Internal Server Error",
    _ => "Response",
  };
  let head = format!(
    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
    body.len()
  );
  stream.write_all(head.as_bytes())?;
  stream.write_all(body.as_bytes())?;
  stream.flush()
}

// ============================================================================
// Tauri 命令（给前端用）
// ============================================================================

#[tauri::command]
pub fn webview_bridge_info() -> Value {
  info()
}

#[tauri::command]
pub fn webview_open(app: AppHandle, spec: Value) -> Result<Value, String> {
  open(&app, spec)
}

#[tauri::command]
pub fn webview_set_bounds(app: AppHandle, label: String, x: i32, y: i32, w: i32, h: i32) -> Result<Value, String> {
  set_bounds(&app, &label, json!({ "x": x, "y": y, "w": w, "h": h }))
}

#[tauri::command]
pub fn webview_set_visible(app: AppHandle, label: String, visible: bool) -> Result<Value, String> {
  set_visible(&app, &label, visible)
}

#[tauri::command]
pub fn webview_set_stacked(app: AppHandle, label: String, behind: bool) -> Result<Value, String> {
  set_stacked(&app, &label, behind)
}

#[tauri::command]
pub fn webview_close(app: AppHandle, label: String) -> Result<Value, String> {
  close(&app, &label)
}

#[tauri::command]
pub fn webview_wait_ready(app: AppHandle, label: String, prefix: String, timeout_ms: Option<u64>) -> Result<Value, String> {
  wait_ready(&app, &label, &prefix, Duration::from_millis(timeout_ms.unwrap_or(30_000)))
}

#[tauri::command]
pub fn webview_list(app: AppHandle) -> Value {
  list(&app)
}
