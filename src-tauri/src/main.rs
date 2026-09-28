// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::api::process::{Command, CommandEvent};
use tauri::Manager;

#[cfg(windows)]
mod notify;

/// 后端 sidecar 的运行时状态：
/// - port_file  → 写入 / 读取后端真实监听端口的文件路径
/// - resolved_port → 由探测线程填充；前端 invoke 时若文件尚未就绪可回退
struct MomokaServerState {
  port_file: PathBuf,
  resolved_port: Mutex<Option<u16>>,
}

const PROBE_BASE_PORT: u16 = 8888;
const PROBE_TRIES: u16 = 10; // 8888..=8897
const PROBE_INTERVAL_MS: u64 = 200;
const PROBE_MAX_DURATION_MS: u64 = 10_000;

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let port_file = std::env::temp_dir().join("arona-chest.momoka.port");
      // 清理可能残留的旧端口文件
      let _ = fs::remove_file(&port_file);

      // 启动 sidecar：binaries/momoka-server（target-triple 后缀由 tauri 自动加）
      // 注意：Tauri 1.8 sidecar 模式下对自定义 env 的传递不可靠，所以**不**依赖
      // process.env.MOMOKA_PORT_FILE，而是由 Rust 侧通过 HTTP 探测拿到真实端口。
      let sidecar = Command::new_sidecar("momoka-server")
        .map_err(|e| format!("sidecar command not found: {e}"))?;

      let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn momoka-server sidecar: {e}"))?;

      // 后台消费 stdout/stderr（避免管道缓冲区塞满导致 sidecar 卡死）
      tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(line) => {
              eprintln!("[sidecar] {}", line);
            }
            CommandEvent::Stderr(line) => {
              eprintln!("[sidecar:err] {}", line);
            }
            CommandEvent::Error(err) => {
              eprintln!("[sidecar:event] error: {}", err);
            }
            CommandEvent::Terminated(payload) => {
              eprintln!(
                "[sidecar] terminated: code={:?} signal={:?}",
                payload.code, payload.signal
              );
              break;
            }
            _ => {}
          }
        }
      });

      // 共享给探测线程：resolved_port
      let resolved_port = Mutex::new(None::<u16>);
      let port_file_for_thread = port_file.clone();

      // 独立 OS 线程跑探测：不阻塞 Tauri runtime / setup 回调
      thread::Builder::new()
        .name("arona-chest.port-probe".to_string())
        .spawn(move || {
          let started = std::time::Instant::now();
          let mut attempt: u32 = 0;
          loop {
            if started.elapsed() > Duration::from_millis(PROBE_MAX_DURATION_MS) {
              eprintln!(
                "[probe] gave up after {}ms; port file not written",
                PROBE_MAX_DURATION_MS
              );
              break;
            }
            for offset in 0..PROBE_TRIES {
              let port = PROBE_BASE_PORT + offset;
              if probe_health(port) {
                if let Err(err) = fs::write(&port_file_for_thread, port.to_string()) {
                  eprintln!("[probe] write port file failed: {err}");
                  return;
                }
                eprintln!("[probe] momoka-server alive on :{port}; wrote port file");
                if let Ok(mut guard) = resolved_port.lock() {
                  *guard = Some(port);
                }
                return;
              }
            }
            attempt += 1;
            if attempt % 5 == 0 {
              eprintln!(
                "[probe] still waiting for momoka-server (attempt={}, elapsed={}ms)",
                attempt,
                started.elapsed().as_millis()
              );
            }
            thread::sleep(Duration::from_millis(PROBE_INTERVAL_MS));
          }
        })
        .map_err(|e| format!("failed to spawn port-probe thread: {e}"))?;

      app.manage(MomokaServerState {
        port_file,
        resolved_port: Mutex::new(None),
      });

      // 系统通知：补齐 Windows 需要的 AUMID 环境（开始菜单快捷方式 + AppUserModelId 注册项）。
      // 不补的话，未打包 / target\debug 运行时发出的 toast 会被 Windows 静默丢弃（不报错、不显示）。
      #[cfg(windows)]
      if let Err(error) = notify::ensure_identity() {
        eprintln!("[notify] ensure_identity failed: {error}");
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![get_momoka_port, notify_toast])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// 前端调用：发一条系统通知（Windows 原生 Toast），可带按钮。
/// 按钮被点时 Rust 侧通过 `moduty-toast-action` 事件把 action id 回传（见 notify.rs）。
#[derive(serde::Deserialize)]
struct NotifyActionInput {
  id: String,
  label: String,
}

#[cfg(windows)]
#[tauri::command]
fn notify_toast(
  app: tauri::AppHandle,
  title: String,
  body: String,
  actions: Option<Vec<NotifyActionInput>>,
) -> Result<(), String> {
  let actions: Vec<notify::ToastAction> = actions
    .unwrap_or_default()
    .into_iter()
    .map(|item| notify::ToastAction {
      id: item.id,
      label: item.label,
    })
    .collect();
  notify::toast_with_actions(&app, &title, &body, &actions)
}

#[cfg(not(windows))]
#[tauri::command]
fn notify_toast(
  _title: String,
  _body: String,
  _actions: Option<Vec<NotifyActionInput>>,
) -> Result<(), String> {
  Err("当前平台不支持系统通知".to_string())
}

/// 前端调用：返回后端真实监听端口。
/// 优先读端口文件；若探测线程尚未写完，fallback 到内存中的探测结果。
#[tauri::command]
fn get_momoka_port(state: tauri::State<MomokaServerState>) -> Result<u16, String> {
  if let Ok(content) = fs::read_to_string(&state.port_file) {
    if let Ok(port) = content.trim().parse::<u16>() {
      return Ok(port);
    }
  }
  if let Ok(guard) = state.resolved_port.lock() {
    if let Some(port) = *guard {
      return Ok(port);
    }
  }
  Err("momoka-server not ready yet (port probe still in progress)".to_string())
}

/// 同步 TCP 探测 + 最小 HTTP GET：连接 + 写入 HTTP/1.0 请求 + 读首行。
/// 返回 true 表示收到了 200 OK。
fn probe_health(port: u16) -> bool {
  let addr = match format!("127.0.0.1:{port}").to_socket_addrs() {
    Ok(mut it) => match it.next() {
      Some(a) => a,
      None => return false,
    },
    Err(_) => return false,
  };
  let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(150)) {
    Ok(s) => s,
    Err(_) => return false,
  };
  let req = "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  if stream.write_all(req.as_bytes()).is_err() {
    return false;
  }
  let mut buf = Vec::with_capacity(256);
  let mut chunk = [0u8; 128];
  // 限读：避免 sidecar 偶发慢响应拖死探测
  let read_limit = Duration::from_millis(300);
  let _ = stream.set_read_timeout(Some(read_limit));
  loop {
    match stream.read(&mut chunk) {
      Ok(0) => break,
      Ok(n) => {
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(2).any(|w| w == b"\r\n") && buf.len() > 16 {
          break;
        }
        if buf.len() > 1024 {
          break;
        }
      }
      Err(_) => break,
    }
  }
  let s = String::from_utf8_lossy(&buf);
  s.contains("200") && s.contains("OK")
}
