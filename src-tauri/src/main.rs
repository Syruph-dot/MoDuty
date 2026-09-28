// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

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
/// 每个候选端口上等 sidecar 变成健康的时长（含冷启动）
const HEALTH_WAIT_MS: u64 = 3_000;

/// sidecar 与主可执行文件同目录：开发时是 target/<profile>/，安装后是安装目录。
fn resolve_sidecar_path() -> Result<PathBuf, String> {
  let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
  let dir = exe.parent().ok_or_else(|| "current_exe has no parent directory".to_string())?;
  let name = if cfg!(windows) { "momoka-server.exe" } else { "momoka-server" };
  let candidate = dir.join(name);
  if candidate.exists() {
    return Ok(candidate);
  }
  Err(format!(
    "momoka-server sidecar not found at {} (did you run `npm run build:sidecar`?)",
    candidate.display()
  ))
}

/// sidecar 进程记录：用于「上一个进程被杀时留下的孤儿后端」清理。
///
/// 为什么必要：Windows 不会因父进程退出而回收子进程。孤儿 sidecar 会占住 8888，
/// 新版本启动时端口探测会探测到它并继续用它——于是升级后可能一直在跑**旧后端**
/// （2026-09-28 实测：一次构建被孤儿进程锁住目标文件，排查时才确认这个隐患）。
static SIDECAR_PID_FILE: OnceLock<PathBuf> = OnceLock::new();
static SIDECAR_PID: Mutex<Option<u32>> = Mutex::new(None);

fn sidecar_pid_file() -> PathBuf {
  SIDECAR_PID_FILE
    .get_or_init(|| std::env::temp_dir().join("arona-chest.momoka.sidecar.pid"))
    .clone()
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
  let _ = Command::new("taskkill")
    .args(["/F", "/PID", &pid.to_string()])
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status();
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) {
  let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

/// 启动前清理上一次运行留下的 sidecar。
fn kill_previous_sidecar() {
  let pid_file = sidecar_pid_file();
  if let Ok(text) = fs::read_to_string(&pid_file) {
    if let Ok(pid) = text.trim().parse::<u32>() {
      if pid != std::process::id() {
        eprintln!("[sidecar] killing leftover sidecar pid={pid}");
        kill_pid(pid);
      }
    }
  }
  let _ = fs::remove_file(&pid_file);
}

/// 记下本次启动的 sidecar pid（供下次启动与退出时清理）。
fn remember_sidecar_pid(pid: u32) {
  if let Ok(mut guard) = SIDECAR_PID.lock() {
    *guard = Some(pid);
  }
  let _ = fs::write(sidecar_pid_file(), pid.to_string());
}

/// 退出时收掉自己拉起的 sidecar，不留孤儿。
fn shutdown_sidecar() {
  let pid = SIDECAR_PID.lock().ok().and_then(|guard| *guard);
  if let Some(pid) = pid {
    eprintln!("[sidecar] shutting down pid={pid}");
    kill_pid(pid);
  }
  let _ = fs::remove_file(sidecar_pid_file());
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let port_file = std::env::temp_dir().join("arona-chest.momoka.port");
      // 清理可能残留的旧端口文件与孤儿 sidecar
      let _ = fs::remove_file(&port_file);
      kill_previous_sidecar();
      // 等一下端口释（taskkill 是同步的，但监听 socket 需要极短时间关闭）
      thread::sleep(Duration::from_millis(300));

      // sidecar 与主可执行文件同目录（v2 的 externalBin 会放到同一目录）。
      // 缺文件属于安装/构建错误，直接在启动期报出来。
      let sidecar_path = resolve_sidecar_path()?;
      let resolved_port: Arc<Mutex<Option<u16>>> = Arc::new(Mutex::new(None));
      let port_file_for_thread = port_file.clone();
      let resolved_for_thread = resolved_port.clone();

      // 启动 + 健康探测全部放到后台线程，并且**带端口重试**：
      // Windows 上进程被强杀后可能留下归属已死 PID 的残留监听（实测：PID 不存在但端口
      // 仍 EADDRINUSE），只靠“先试着绑一下”挑端口并不可靠；而 sidecar 在端口被占时
      // 会故意直接失败（防多实例写坏 agents.json）。所以在每个候选端口上实起实探，
      // 失败就收掉这个子进程、换下一个端口。
      thread::Builder::new()
        .name("moduty.sidecar-boot".to_string())
        .spawn(move || {
          kill_previous_sidecar();
          thread::sleep(Duration::from_millis(300));
          for offset in 0..PROBE_TRIES {
            let port = PROBE_BASE_PORT + offset;
            eprintln!("[sidecar] spawning {} on port {port}", sidecar_path.display());
            let mut child = match Command::new(&sidecar_path)
              .env("PORT", port.to_string())
              .stdout(Stdio::piped())
              .stderr(Stdio::piped())
              .spawn()
            {
              Ok(child) => child,
              Err(err) => {
                eprintln!("[sidecar] spawn failed: {err}");
                break;
              }
            };

            // 后台消费 stdout/stderr（避免管道缓冲区塞满导致 sidecar 卡死）
            if let Some(stdout) = child.stdout.take() {
              thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                  eprintln!("[sidecar] {line}");
                }
              });
            }
            if let Some(stderr) = child.stderr.take() {
              thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                  eprintln!("[sidecar:err] {line}");
                }
              });
            }

            if wait_for_health(port, Duration::from_millis(HEALTH_WAIT_MS)) {
              remember_sidecar_pid(child.id());
              if let Err(err) = fs::write(&port_file_for_thread, port.to_string()) {
                eprintln!("[probe] write port file failed: {err}");
              }
              if let Ok(mut guard) = resolved_for_thread.lock() {
                *guard = Some(port);
              }
              eprintln!("[probe] momoka-server alive on :{port}; port file written");
              // 守着子进程退出（应用退出时会主动收掉它）
              let status = child.wait();
              eprintln!("[sidecar] exited: {status:?}");
              return;
            }

            eprintln!("[sidecar] port {port} never became healthy; killing pid={}", child.id());
            kill_pid(child.id());
            let _ = child.wait();
          }
          eprintln!(
            "[sidecar] gave up: no healthy backend in {}..{}",
            PROBE_BASE_PORT,
            PROBE_BASE_PORT + PROBE_TRIES - 1
          );
        })
        .map_err(|e| format!("failed to spawn sidecar bootstrap thread: {e}"))?;

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
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_handle, event| {
      if let tauri::RunEvent::Exit = event {
        shutdown_sidecar();
      }
    });
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
  // 诊断用：前端每次解析 API base 都会走到这里（保留，便于排查“界面连不上后端”）
  eprintln!("[port] get_momoka_port invoked");
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

/// 轮询等待某个端口上的后端变成健康（含冷启动时间）。
fn wait_for_health(port: u16, timeout: Duration) -> bool {
  let started = std::time::Instant::now();
  while started.elapsed() < timeout {
    if probe_health(port) {
      return true;
    }
    thread::sleep(Duration::from_millis(PROBE_INTERVAL_MS));
  }
  false
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
