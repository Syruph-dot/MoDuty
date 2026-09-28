//! 尖刀验证（S2）：Tauri v2 多 webview + Rust 侧 CDP 桥。
//!
//! 只在命令行带 `--webview-spike` 时运行，正常启动路径不受影响。
//! 目的不是做功能，而是把 P2 路线里风险最高的几件事一次问清：
//!   1. `unstable` 的多 webview（`Window::add_child`）在 Windows 上究竟能不能起；
//!   2. 子 webview 能不能挂在磁贴那样的矩形里，并且运行时改位置/尺寸；
//!   3. 每个 webview 独立 `data_directory`（持久 profile）与 `incognito` 是否生效；
//!   4. 能不能从 Rust 侧直接拿 `ICoreWebView2Controller` 发 CDP（不开调试端口），
//!      从而读到页面状态、拿到截图——这是"后端操作真实 Edge"那条路的基础。
//!
//! 产物：`%TEMP%\moduty-spike\{report.json,shot1.png,shot2.png,shot3.png}`

use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewBuilder, WebviewUrl};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
use webview2_com::{
  CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
};
use windows::core::HSTRING;

const SPIKE_LABEL: &str = "spike-tile";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const CDP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct SpikeOptions {
  pub incognito: bool,
  pub multi: bool,
  pub dir: PathBuf,
}

impl SpikeOptions {
  /// `%TEMP%\moduty-spike`。incognito 用独立子目录，避免和持久 profile 互相污染。
  pub fn from_env() -> Self {
    let incognito = std::env::args().any(|a| a == "--webview-spike-incognito");
    let mut dir = std::env::temp_dir();
    dir.push("moduty-spike");
    if incognito {
      dir.push("profile-incognito");
    } else {
      dir.push("profile");
    }
    let multi = std::env::args().any(|a| a == "--webview-spike-multi");
    Self { incognito, multi, dir }
  }

  fn out_dir(&self) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push("moduty-spike");
    dir
  }
}

/// 起一个后台线程跑验证，结束后写报告并退出应用（不污染正常使用）。
pub fn spawn(app: AppHandle, opts: SpikeOptions) {
  std::thread::spawn(move || {
    let started = Instant::now();
    let report = match run(&app, &opts) {
      Ok(value) => value,
      Err(err) => json!({ "ok": false, "error": err }),
    };
    let mut report = report;
    report["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
    let text = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string());
    let path = opts.out_dir().join("report.json");
    let _ = fs::create_dir_all(opts.out_dir());
    let _ = fs::write(&path, &text);
    eprintln!("[spike] report -> {}", path.display());
    eprintln!("[spike] {text}");
    std::thread::sleep(Duration::from_millis(300));
    app.exit(0);
  });
}

/// 记录每一步的结果，最后整体进报告：尖刀的价值在于"哪一步炸了"。
struct Rec {
  steps: Vec<Value>,
  opts: SpikeOptions,
}

impl Rec {
  fn step(&mut self, name: &str, ok: bool, detail: Value) {
    eprintln!("[spike] step {name}: ok={ok} {}", detail);
    self.steps.push(json!({ "name": name, "ok": ok, "detail": detail }));
  }

  fn shot(&mut self, app: &AppHandle, label: &str, name: &str, file: &str) -> Value {
    match cdp(app, label, "Page.captureScreenshot", r#"{"format":"png"}"#, CDP_TIMEOUT)
      .and_then(|raw| {
        let v: Value = serde_json::from_str(&raw).map_err(|e| format!("bad json: {e}"))?;
        let data = v
          .get("data")
          .and_then(Value::as_str)
          .ok_or_else(|| format!("no data field: {}", raw.chars().take(200).collect::<String>()))?;
        let bytes = base64::engine::general_purpose::STANDARD
          .decode(data)
          .map_err(|e| format!("base64 decode: {e}"))?;
        let path = self.opts.out_dir().join(file);
        fs::write(&path, &bytes).map_err(|e| format!("write {file}: {e}"))?;
        Ok((path, bytes.len()))
      }) {
      Ok((path, len)) => {
        self.step(name, true, json!({ "file": path.display().to_string(), "bytes": len }));
        json!({ "file": path.display().to_string(), "bytes": len })
      }
      Err(err) => {
        self.step(name, false, json!(err.clone()));
        json!({ "error": err })
      }
    }
  }
}

fn run(app: &AppHandle, opts: &SpikeOptions) -> Result<Value, String> {
  let mut rec = Rec { steps: Vec::new(), opts: opts.clone() };
  fs::create_dir_all(opts.dir.clone()).map_err(|e| format!("create profile dir: {e}"))?;
  if opts.multi {
    return run_multi(app, &mut rec, opts);
  }

  // 1) 主窗口
  let window = app.get_window("main").ok_or("main window missing")?;
  let inner = window.inner_size().map_err(|e| format!("inner_size: {e}"))?;
  rec.step(
    "main_window",
    true,
    json!({ "label": window.label(), "width": inner.width, "height": inner.height,
            "webviews_before": app.webviews().len() }),
  );

  // 2) 后端端口（稍后拿它加载我们自己的界面，作为"真实页面"的第二例）
  let port = wait_port(app, Duration::from_secs(20));

  // 3) 关键一问：add_child 能不能在这台机器上起一个子 webview
  let url = "https://example.com/";
  let parsed = url
    .parse()
    .map_err(|e| format!("parse url: {e}"))?;
  let builder = WebviewBuilder::new(SPIKE_LABEL, WebviewUrl::External(parsed))
    .data_directory(opts.dir.clone())
    .incognito(opts.incognito)
    .devtools(true);
  let t = Instant::now();
  let webview = match window.add_child(builder, PhysicalPosition::new(120, 140), PhysicalSize::new(960, 620)) {
    Ok(webview) => webview,
    Err(err) => {
      rec.step(
        "add_child",
        false,
        json!({ "error": err.to_string(), "incognito": opts.incognito,
                "data_directory": opts.dir.display().to_string() }),
      );
      return Ok(json!({ "ok": false, "steps": rec.steps, "port": port }));
    }
  };
  rec.step(
    "add_child",
    true,
    json!({ "label": webview.label(), "elapsed_ms": t.elapsed().as_millis() as u64,
            "incognito": opts.incognito, "data_directory": opts.dir.display().to_string(),
            "webviews_after": app.webviews().len() }),
  );

  // 4) CDP 桥：先在外部站点上验证（不开调试端口，直接走 controller）
  let version = cdp(app, SPIKE_LABEL, "Browser.getVersion", "{}", CDP_TIMEOUT);
  rec.step("cdp_browser_get_version", version.is_ok(), match &version {
    Ok(raw) => json!(raw.chars().take(300).collect::<String>()),
    Err(err) => json!(err.clone()),
  });
  if version.is_err() {
    // CDP 不通就不必往下走了：后面每一步都依赖它
    return Ok(json!({ "ok": false, "steps": rec.steps, "port": port }));
  }

  // 5) 等页面加载完成（必须等到目标 URL，而不是 about:blank）
  let t = Instant::now();
  let ready = wait_ready(app, SPIKE_LABEL, "https://example.com", READY_TIMEOUT);
  rec.step(
    "page_ready",
    ready.is_ok(),
    json!({ "url": url, "elapsed_ms": t.elapsed().as_millis() as u64,
            "state": ready.as_ref().ok(), "error": ready.as_ref().err() }),
  );

  // 6) 页面实况
  let state = eval(
    app,
    SPIKE_LABEL,
    "({ title: document.title, href: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent })",
  );
  rec.step("page_state", state.is_ok(), state.clone().unwrap_or(Value::Null));

  // 7) 像素证据
  rec.shot(app, SPIKE_LABEL, "screenshot_external", "shot1.png");

  // 8) profile 持久化 / incognito 隔离
  let stored = eval(
    app,
    SPIKE_LABEL,
    "(function(){ const k='spike_persist_token'; const v=localStorage.getItem(k); \
      if(!v){ const token='t'+Date.now(); localStorage.setItem(k, token); return {wrote: token}; } \
      return {found: v}; })()",
  );
  rec.step(
    if opts.incognito { "profile_incognito" } else { "profile_persist" },
    stored.is_ok(),
    json!({ "value": stored.as_ref().ok(), "error": stored.as_ref().err() }),
  );

  // 9) 运行时改几何：磁贴拖动/缩放就是这条路径
  let moved = webview
    .set_position(PhysicalPosition::new(320, 260))
    .and_then(|_| webview.set_size(PhysicalSize::new(640, 400)))
    .map_err(|e| e.to_string());
  std::thread::sleep(Duration::from_millis(600));
  let after = eval(app, SPIKE_LABEL, "({ w: innerWidth, h: innerHeight })");
  rec.step(
    "set_position_size",
    moved.is_ok() && after.is_ok(),
    json!({ "error": moved.err(), "viewport_after": after.unwrap_or(Value::Null),
            "expect": "innerWidth≈640 innerHeight≈400（扣除缩放系数）" }),
  );
  rec.shot(app, SPIKE_LABEL, "screenshot_resized", "shot2.png");

  // 10) 输入注入：Agent 真正"操作"页面的核心手段（点击导航 / 滚轮 / 文本输入）
  input_probe(app, &mut rec);

  // 11) 第二例真实页面：我们自己的界面（磁贴里放自家页面）
  if let Some(port) = port {
    let target = format!("http://127.0.0.1:{port}/");
    let nav = target
      .parse()
      .map_err(|e| format!("parse {target}: {e}"))
      .and_then(|url| webview.navigate(url).map_err(|e| e.to_string()));
    std::thread::sleep(Duration::from_millis(500));
    let ready = wait_ready(app, SPIKE_LABEL, &format!("http://127.0.0.1:{port}"), Duration::from_secs(20));
    let state = eval(app, SPIKE_LABEL, "({ title: document.title, href: location.href, text: document.body.innerText.slice(0,120) })");
    rec.step(
      "navigate_own_ui",
      nav.is_ok() && ready.is_ok(),
      json!({ "target": target, "nav_error": nav.err(), "ready_error": ready.as_ref().err(),
              "state": state.unwrap_or(Value::Null) }),
    );
    rec.shot(app, SPIKE_LABEL, "screenshot_own_ui", "shot3.png");
  } else {
    rec.step("navigate_own_ui", false, json!("后端端口未就绪，跳过"));
  }

  // 11) 关掉子 webview：磁贴关闭就是这条路径
  let closed = webview.close().map_err(|e| e.to_string());
  std::thread::sleep(Duration::from_millis(400));
  let gone = app.get_webview(SPIKE_LABEL).is_none();
  rec.step(
    "close_child",
    closed.is_ok() && gone,
    json!({ "error": closed.err(), "removed_from_app": gone, "webviews_after_close": app.webviews().len() }),
  );

  Ok(json!({ "ok": true, "incognito": opts.incognito, "port": port, "steps": rec.steps }))
}

/// 等后端端口文件出现（尖刀可能比后端起得早）。
fn wait_port(app: &AppHandle, timeout: Duration) -> Option<u16> {
  let started = Instant::now();
  while started.elapsed() < timeout {
    if let Some(state) = app.try_state::<crate::MomokaServerState>() {
      if let Ok(content) = fs::read_to_string(&state.port_file) {
        if let Ok(port) = content.trim().parse::<u16>() {
          return Some(port);
        }
      }
    }
    std::thread::sleep(Duration::from_millis(200));
  }
  None
}

/// 等到「目标 URL 上确实加载完成」。
///
/// 关键：子 webview 一创建是 `about:blank`，而 `about:blank` 的 readyState 也是 complete——
/// 只看 readyState 会在导航开始前就"通过"，随后所有 eval 都打在不透明源上
/// （localStorage 会直接抛 SecurityError）。所以必须同时匹配 URL。
fn wait_ready(app: &AppHandle, label: &str, expect_prefix: &str, timeout: Duration) -> Result<Value, String> {
  let started = Instant::now();
  let mut last = Value::Null;
  while started.elapsed() < timeout {
    let state = eval(app, label, "({ ready: document.readyState, href: location.href })");
    match state {
      Ok(value) => {
        let ready = value.get("ready").and_then(Value::as_str) == Some("complete");
        let href = value.get("href").and_then(Value::as_str).unwrap_or_default();
        if ready && href.starts_with(expect_prefix) {
          return Ok(value);
        }
        last = value;
      }
      Err(err) => last = json!(err),
    }
    std::thread::sleep(Duration::from_millis(200));
  }
  Err(format!(
    "wait_ready({expect_prefix}) timeout after {}ms, last={last}",
    timeout.as_millis()
  ))
}

/// `Runtime.evaluate` + `returnByValue`，直接拿 JS 值。
///
/// 注意：`CallDevToolsProtocolMethod` 回的**就是 CDP 消息里的 result 载荷**，
/// 外面没有再包一层 `{"result": …}`，所以取值路径是 `/result/value`。
fn eval(app: &AppHandle, label: &str, expression: &str) -> Result<Value, String> {
  let params = json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }).to_string();
  let raw = cdp(app, label, "Runtime.evaluate", &params, CDP_TIMEOUT)?;
  let value: Value = serde_json::from_str(&raw).map_err(|e| format!("bad CDP json: {e}"))?;
  if let Some(exc) = value.get("exceptionDetails") {
    return Err(format!("js exception: {exc}"));
  }
  if let Some(found) = value.pointer("/result/value").cloned() {
    return Ok(found);
  }
  // 取不到就把原始载荷报出来，别静默返回 null
  Err(format!("unexpected CDP eval payload: {raw}"))
}

/// 直接在控制器上发 CDP（`CallDevToolsProtocolMethod`），不依赖任何调试端口。
///
/// 注意：调用必须发生在 UI 线程（`with_webview` 里），但**等待结果不能在 UI 线程**——
/// 完成回调也是投递到 UI 线程的消息循环上的，在 UI 线程上阻塞等它就会死锁。
/// 所以这里只负责"发起 + 把结果丢进 channel"，真正的等待放在 `with_webview` 之外。
fn cdp(app: &AppHandle, label: &str, method: &str, params: &str, timeout: Duration) -> Result<String, String> {
  let webview = app
    .get_webview(label)
    .ok_or_else(|| format!("webview {label} not found"))?;
  let (tx, rx) = mpsc::channel::<Result<String, String>>();
  let tx_start = tx.clone();
  let (method_owned, params_owned) = (method.to_string(), params.to_string());
  webview
    .with_webview(move |platform| {
      let controller = platform.controller();
      match call_cdp(&controller, &method_owned, &params_owned, tx) {
        Ok(()) => {}
        Err(err) => {
          let _ = tx_start.send(Err(err));
        }
      }
    })
    .map_err(|e| format!("with_webview({method}): {e}"))?;
  rx.recv_timeout(timeout)
    .map_err(|_| format!("CDP {method} timeout after {}ms", timeout.as_millis()))?
}

/// UI 线程侧：纯 COM 调用，立刻返回。
fn call_cdp(
  controller: &ICoreWebView2Controller,
  method: &str,
  params: &str,
  tx: mpsc::Sender<Result<String, String>>,
) -> Result<(), String> {
  let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }.map_err(|e| format!("CoreWebView2: {e}"))?;
  let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json: String| {
    // 宏把接口里的 PCWSTR 结果直接映射成 String，这里不用再自己解码
    let _ = if hr.is_ok() {
      tx.send(Ok(json))
    } else {
      tx.send(Err(format!("CDP failed hr={hr:?}: {json}")))
    };
    Ok(())
  }));
  let method = HSTRING::from(method);
  let params = HSTRING::from(params);
  unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) }
    .map_err(|e| format!("CallDevToolsProtocolMethod: {e}"))
}

/// 磁贴墙的真实形态：**同时**存在多个子 webview，各自独立 profile / incognito。
/// 要在这里确认三件事：能不能并存、profile 会不会互相串、每个都能单独发 CDP 与截图。
fn run_multi(app: &AppHandle, rec: &mut Rec, opts: &SpikeOptions) -> Result<Value, String> {
  let window = app.get_window("main").ok_or("main window missing")?;
  let port = wait_port(app, Duration::from_secs(20));
  let target = match port {
    Some(port) => format!("http://127.0.0.1:{port}/"),
    None => "https://example.com/".to_string(),
  };
  rec.step("multi_target", true, json!({ "target": target }));

  let mut created: Vec<(String, tauri::Webview)> = Vec::new();
  for index in 0..3usize {
    let label = format!("tile-{index}");
    let mut dir = opts.out_dir();
    if index == 2 {
      dir.push(format!("profile-tile{index}-incognito"));
    } else {
      dir.push(format!("profile-tile{index}"));
    }
    let url = target.parse().map_err(|e| format!("parse {target}: {e}"))?;
    let builder = tauri::WebviewBuilder::new(label.clone(), tauri::WebviewUrl::External(url))
      .data_directory(dir.clone())
      .incognito(index == 2)
      .devtools(true);
    let position = tauri::PhysicalPosition::new(80 + (index as i32) * 60, 100 + (index as i32) * 60);
    let size = tauri::PhysicalSize::new(700, 460);
    match window.add_child(builder, position, size) {
      Ok(webview) => {
        rec.step(
          &format!("multi_add_child_{index}"),
          true,
          json!({ "label": label, "data_directory": dir.display().to_string(),
                  "incognito": index == 2, "webviews_now": app.webviews().len() }),
        );
        created.push((label, webview));
      }
      Err(err) => {
        rec.step(&format!("multi_add_child_{index}"), false, json!(err.to_string()));
      }
    }
  }

  rec.step("multi_webviews_total", created.len() == 3, json!({ "created": created.len(), "app_webviews": app.webviews().len() }));

  // 每个磁贴：等就绪 → 读状态 → 写自己的 token → 截图
  for (label, _) in &created {
    let ready = wait_ready(app, label, &target, Duration::from_secs(20));
    let state = eval(app, label, "({ title: document.title, href: location.href, w: innerWidth, h: innerHeight })");
    let write = eval(
      app,
      label,
      &format!(
        "(function(){{ const k='tile_label'; const before=localStorage.getItem(k);           localStorage.setItem(k, '{label}'); return {{ before: before, wrote: '{label}' }}; }})()"
      ),
    );
    rec.step(
      &format!("multi_tile_{label}"),
      ready.is_ok() && state.is_ok() && write.is_ok(),
      json!({ "ready_error": ready.as_ref().err(), "state": state.as_ref().ok(),
              "local_storage": write.as_ref().ok(), "local_storage_error": write.as_ref().err() }),
    );
    rec.shot(app, label, &format!("screenshot_{label}"), &format!("shot-{label}.png"));
  }

  // 回读：每个磁贴只能看到自己的 token（profile 隔离）
  for (label, _) in &created {
    let read = eval(app, label, "(function(){ return { k: localStorage.getItem('tile_label') }; })()");
    rec.step(
      &format!("multi_isolation_{label}"),
      read.as_ref().ok().and_then(|v| v.pointer("/k")).and_then(Value::as_str).map(|s| s == label).unwrap_or(false),
      json!({ "expect": label, "got": read.as_ref().ok(), "error": read.as_ref().err() }),
    );
  }

  for (label, webview) in created.iter() {
    let closed = webview.close().map_err(|e| e.to_string());
    rec.step(&format!("multi_close_{label}"), closed.is_ok(), json!({ "error": closed.err() }));
  }
  std::thread::sleep(Duration::from_millis(500));
  rec.step(
    "multi_after_close",
    app.webviews().len() == 1,
    json!({ "webviews_left": app.webviews().len(), "labels": app.webviews().keys().cloned().collect::<Vec<_>>() }),
  );

  Ok(json!({ "ok": true, "multi": true, "port": port, "steps": rec.steps }))
}

/// 输入注入验证：CDP 的 `Input.*` 是后端"操作真实页面"的唯一手段，
/// 这里用例子站点的链接点击 + 滚轮 + 文本输入把它一次性确认掉。
fn input_probe(app: &AppHandle, rec: &mut Rec) {
  // 点击 example.com 的 "Learn more" 链接 → 期望导航到 iana.org
  let rect = eval(
    app,
    SPIKE_LABEL,
    "(() => { const a = document.querySelector('a'); if (!a) return null;       const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: a.textContent.trim() }; })()",
  );
  let (x, y) = match rect.as_ref().ok().and_then(|v| Some((v.get("x")?.as_f64()?, v.get("y")?.as_f64()?))) {
    Some(pair) => pair,
    None => {
      rec.step("input_click_link", false, json!({ "error": "找不到可点的链接", "rect": rect.as_ref().err() }));
      return;
    }
  };
  let base = json!({ "x": x, "y": y, "button": "left", "clickCount": 1 });
  let mut press = base.clone();
  press["type"] = json!("mousePressed");
  let mut release = base.clone();
  release["type"] = json!("mouseReleased");
  let pressed = cdp(app, SPIKE_LABEL, "Input.dispatchMouseEvent", &press.to_string(), CDP_TIMEOUT);
  let released = cdp(app, SPIKE_LABEL, "Input.dispatchMouseEvent", &release.to_string(), CDP_TIMEOUT);
  let navigated = wait_ready(app, SPIKE_LABEL, "https://www.iana.org", Duration::from_secs(15));
  rec.step(
    "input_click_link",
    pressed.is_ok() && released.is_ok() && navigated.is_ok(),
    json!({ "target": rect.as_ref().ok(), "press_error": pressed.as_ref().err(),
            "release_error": released.as_ref().err(), "result": navigated.as_ref().ok(),
            "navigate_error": navigated.as_ref().err() }),
  );

  // 滚轮
  let before = eval(app, SPIKE_LABEL, "scrollY");
  let _ = cdp(
    app,
    SPIKE_LABEL,
    "Input.dispatchMouseEvent",
    &json!({ "type": "mouseWheel", "x": 100.0, "y": 100.0, "deltaX": 0, "deltaY": 800 }).to_string(),
    CDP_TIMEOUT,
  );
  std::thread::sleep(Duration::from_millis(500));
  let after = eval(app, SPIKE_LABEL, "scrollY");
  let moved = after.as_ref().ok().and_then(Value::as_f64).unwrap_or(0.0)
    > before.as_ref().ok().and_then(Value::as_f64).unwrap_or(0.0);
  rec.step("input_wheel_scroll", moved, json!({ "before": before.as_ref().ok(), "after": after.as_ref().ok() }));

  // 文本输入：先造一个输入框并聚焦，再走 CDP 的 insertText
  let _ = eval(
    app,
    SPIKE_LABEL,
    "(() => { const i = document.createElement('input'); i.id = 'spike-input'; document.body.appendChild(i); i.focus(); return true; })()",
  );
  let typed = cdp(app, SPIKE_LABEL, "Input.insertText", &json!({ "text": "moduty" }).to_string(), CDP_TIMEOUT);
  std::thread::sleep(Duration::from_millis(200));
  let value = eval(app, SPIKE_LABEL, "document.getElementById('spike-input').value");
  rec.step(
    "input_insert_text",
    typed.is_ok() && value.as_ref().ok().and_then(Value::as_str) == Some("moduty"),
    json!({ "typed_error": typed.as_ref().err(), "input_value": value.as_ref().ok() }),
  );
}
