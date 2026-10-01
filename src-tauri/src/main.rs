// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::Manager;

#[cfg(windows)]
mod notify;
#[cfg(windows)]
mod webview_bridge;
#[cfg(windows)]
mod webview_spike;

/// 后端 sidecar 的运行时状态：
/// - port_file  → 写入 / 读取后端真实监听端口的文件路径
/// - resolved_port → 由探测线程填充；前端 invoke 时若文件尚未就绪可回退。
///   **必须是探测线程那同一个 Arc**：早先这里 manage 的是 `Mutex::new(None)`（另一把空锁），
///   于是回退分支永远为空，就绪信号只剩端口文件一条路（2026-10-01 定位）。
struct MomokaServerState {
  port_file: PathBuf,
  resolved_port: Arc<Mutex<Option<u16>>>,
}

const PROBE_BASE_PORT: u16 = 7238;
const PROBE_TRIES: u16 = 10; // 7238..=7247
/// 每个候选端口上等 sidecar 变成健康的时长（含冷启动）
const HEALTH_WAIT_MS: u64 = 4_000;
/// `get_momoka_port` 等后端就绪的上限。
/// 窗口出现早于后台探测线程，冷启动的这段时间必须让前端的首次取端口等住，
/// 否则它拿到的是一个“还没好，但你也不知道什么时候会好”的错误。
const PORT_WAIT_MS: u64 = 30_000;
/// 等待期间的轮询间隔
const PORT_POLL_MS: u64 = 100;

/// 日志文件：release 是 GUI 子系统（没有控制台），eprintln 等于丢进黑洞，
/// 所以"启动闪退"必须靠落盘才能查。路径与后端数据目录一致。
static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

fn data_dir() -> PathBuf {
  if let Ok(dir) = std::env::var("MOMOKA_DATA_DIR") {
    if !dir.trim().is_empty() {
      return PathBuf::from(dir);
    }
  }
  let home = std::env::var("USERPROFILE")
    .or_else(|_| std::env::var("HOME"))
    .unwrap_or_else(|_| std::env::temp_dir().display().to_string());
  PathBuf::from(home).join(".momoka").join("data")
}

fn log_file_path() -> PathBuf {
  LOG_FILE
    .get_or_init(|| {
      let dir = data_dir().join("logs");
      let _ = fs::create_dir_all(&dir);
      dir.join("sidecar.log")
    })
    .clone()
}

/// 同一条日志同时进 stderr（dev 可见）与日志文件（发布版唯一线索）。
fn log(message: impl AsRef<str>) {
  let message = message.as_ref();
  eprintln!("{message}");
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(log_file_path()) {
    let _ = writeln!(file, "[{stamp}] {message}");
  }
}

/// 上一轮日志太大了就先挪走，保留一轮足够定位问题。
fn rotate_log() {
  let path = log_file_path();
  if let Ok(meta) = fs::metadata(&path) {
    if meta.len() > 256 * 1024 {
      let _ = fs::rename(&path, path.with_extension("1.log"));
    }
  }
}

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
    .get_or_init(|| std::env::temp_dir().join("moduty.momoka.sidecar.pid"))
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
        log(format!("[sidecar] killing leftover sidecar pid={pid}"));
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
    log(format!("[sidecar] shutting down pid={pid}"));
    kill_pid(pid);
  }
  let _ = fs::remove_file(sidecar_pid_file());
}

fn main() {
  // 尖刀验证：只在带 --webview-spike 时启用（见 webview_spike.rs）
  #[cfg(windows)]
  let spike = std::env::args().any(|arg| arg == "--webview-spike");
  tauri::Builder::default()
    .setup(move |app| {
      let port_file = std::env::temp_dir().join("moduty.momoka.port");
      // 清掉上一轮的端口文件（孤儿 sidecar 的清理挪到后台线程，别拖慢窗口出现）
      let _ = fs::remove_file(&port_file);

      // sidecar 与主可执行文件同目录（v2 的 externalBin 会放到同一目录）。
      // 缺文件属于安装/构建错误，直接在启动期报出来。
      let sidecar_path = resolve_sidecar_path()?;
      let resolved_port: Arc<Mutex<Option<u16>>> = Arc::new(Mutex::new(None));
      let port_file_for_thread = port_file.clone();
      let resolved_for_thread = resolved_port.clone();

      // 启动 + 健康探测全部放到后台线程。
      //
      // 顺序刻意分成两步：
      // 1) 先扫一遍候选端口，若已有健康的 MOMOKA 就**复用它**——绝不起第二个实例
      //    （两个实例会并发写同一份 agents.json，而那份文件没有文件锁）；
      // 2) 否则逐个候选端口拉起 sidecar，端口能不能用由 sidecar 自己判断（失败会立刻退出）。
      //    不预先 bind 一下猜：实测别的进程只占着 127.0.0.1:8889 时，我们自己
      //    bind 0.0.0.0:8889 会成功，而 sidecar 会失败——猜错就会白杀一个子进程，
      //    而强杀 bun 后端会留下归属已死 PID 的残留监听（8888 幽灵就是这么来的）。
      thread::Builder::new()
        .name("moduty.sidecar-boot".to_string())
        .spawn(move || {
          rotate_log();
          log(format!(
            "[boot] sidecar={} data_dir={} log={}",
            sidecar_path.display(),
            data_dir().display(),
            log_file_path().display()
          ));
          kill_previous_sidecar();
          thread::sleep(Duration::from_millis(300));

          // 1) 端口上已有健康的后端 → 复用，不再起第二个
          for offset in 0..PROBE_TRIES {
            let port = PROBE_BASE_PORT + offset;
            if probe_health(port) {
              log(format!("[boot] 复用已在运行的 MOMOKA 后端（port {port}）"));
              if let Err(err) = fs::write(&port_file_for_thread, port.to_string()) {
                log(format!("[probe] write port file failed: {err}"));
              }
              if let Ok(mut guard) = resolved_for_thread.lock() {
                *guard = Some(port);
              }
              return;
            }
          }

          // 2) 逐个候选端口拉起 sidecar
          for offset in 0..PROBE_TRIES {
            let port = PROBE_BASE_PORT + offset;
            log(format!("[sidecar] spawning {} on port {port}", sidecar_path.display()));
            let mut child = match Command::new(&sidecar_path)
              .env("PORT", port.to_string())
              .stdout(Stdio::piped())
              .stderr(Stdio::piped())
              .spawn()
            {
              Ok(child) => child,
              Err(err) => {
                log(format!("[sidecar] spawn failed: {err}"));
                break;
              }
            };

            // 后台消费 stdout/stderr（避免管道缓冲区塞满导致 sidecar 卡死）
            if let Some(stdout) = child.stdout.take() {
              thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                  log(format!("[sidecar] {line}"));
                }
              });
            }
            if let Some(stderr) = child.stderr.take() {
              thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                  log(format!("[sidecar:err] {line}"));
                }
              });
            }

            if let BootOutcome::Alive = wait_for_boot(port, Duration::from_millis(HEALTH_WAIT_MS), &mut child) {
              remember_sidecar_pid(child.id());
              if let Err(err) = fs::write(&port_file_for_thread, port.to_string()) {
                log(format!("[probe] write port file failed: {err}"));
              }
              if let Ok(mut guard) = resolved_for_thread.lock() {
                *guard = Some(port);
              }
              log(format!("[probe] momoka-server alive on :{port}; port file written"));
              // 守着子进程退出（应用退出时会主动收掉它）
              let status = child.wait();
              log(format!("[sidecar] exited: {status:?}"));
              return;
            }

            // 只有"还活着但没变健康"才需要收掉；自己已经退出的别再碰——
            // 对 bun 后端做强杀会留下归属已死 PID 的残留监听，那正是我们要避免的。
            match child.try_wait() {
              Ok(Some(status)) => log(format!("[sidecar] port {port} 不可用（{status:?}），换下一个")),
              _ => {
                log(format!("[sidecar] port {port} 超时未就绪，收掉 pid={}", child.id()));
                kill_pid(child.id());
                let _ = child.wait();
              }
            }
          }
          log(format!(
            "[sidecar] gave up: no healthy backend in {}..{}",
            PROBE_BASE_PORT,
            PROBE_BASE_PORT + PROBE_TRIES - 1
          ));
        })
        .map_err(|e| format!("failed to spawn sidecar bootstrap thread: {e}"))?;

      app.manage(MomokaServerState {
        port_file,
        // 与探测线程共享同一个 Arc；原先这里传的是 Mutex::new(None)，回退分支因此永远为空
        resolved_port,
      });

      // 系统通知：补齐 Windows 需要的 AUMID 环境（开始菜单快捷方式 + AppUserModelId 注册项）。
      // 不补的话，未打包 / target\debug 运行时发出的 toast 会被 Windows 静默丢弃（不报错、不显示）。
      #[cfg(windows)]
      if let Err(error) = notify::ensure_identity() {
        log(format!("[notify] ensure_identity failed: {error}"));
      }

      // 尖刀验证：在后台线程里跑多 webview + CDP 检查，跑完写报告并退出应用
      #[cfg(windows)]
      if spike {
        webview_spike::spawn(app.handle().clone(), webview_spike::SpikeOptions::from_env());
      } else {
        // 生产：启动 WebView2 桥（只监听 127.0.0.1 的随机端口 + token 文件）。
        // 前端经 Tauri 命令创建/定位子 webview；后端 sidecar 读 token 文件走 CDP 驱动页面。
        webview_bridge::start(app.handle().clone());
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_momoka_port,
      notify_toast,
      webview_bridge::webview_bridge_info,
      webview_bridge::webview_open,
      webview_bridge::webview_set_bounds,
      webview_bridge::webview_set_visible,
      webview_bridge::webview_close,
      webview_bridge::webview_wait_ready,
      webview_bridge::webview_list,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_handle, event| {
      if let tauri::RunEvent::Exit = event {
        shutdown_sidecar();
        #[cfg(windows)]
        webview_bridge::cleanup();
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
///
/// **未就绪时等待，而不是立刻报错。** 窗口出现早于后台探测线程：探测线程起步先等
/// `kill_previous_sidecar` 释放端口（300ms），之后还要扫端口、必要时拉起 sidecar 并等它
/// 变健康（冷启动实测可达数秒）。早先这里直接返回 Err，而前端只在 mount 时取一次端口、
/// 失败不回退，界面就停在 "momoka-server not ready yet"（2026-10-01 实测）。
/// 现在最多等 PORT_WAIT_MS，把这段竞态挡在命令内部：调用方要么拿到真端口，
/// 要么拿到一个带日志路径、能直接去查的错误。
#[tauri::command]
async fn get_momoka_port(state: tauri::State<'_, MomokaServerState>) -> Result<u16, String> {
  let port_file = state.port_file.clone();
  let resolved_port = state.resolved_port.clone();
  // 同步轮询丢到阻塞线程池：不能占住 async 运行时的 worker
  tauri::async_runtime::spawn_blocking(move || wait_for_ready_port(&port_file, &resolved_port))
    .await
    .map_err(|err| format!("等待后端端口就绪的任务失败：{err}"))?
}

/// 端口就绪的判据：端口文件里有有效端口，或探测线程已在内存里记下结果。
fn ready_port(port_file: &Path, resolved_port: &Mutex<Option<u16>>) -> Option<u16> {
  if let Ok(content) = fs::read_to_string(port_file) {
    if let Ok(port) = content.trim().parse::<u16>() {
      return Some(port);
    }
  }
  resolved_port.lock().ok().and_then(|guard| *guard)
}

/// 轮询等待后端就绪。成功与超时都落盘——发布版没有控制台，日志是唯一的现场。
fn wait_for_ready_port(port_file: &Path, resolved_port: &Mutex<Option<u16>>) -> Result<u16, String> {
  let started = std::time::Instant::now();
  let deadline = started + Duration::from_millis(PORT_WAIT_MS);
  loop {
    if let Some(port) = ready_port(port_file, resolved_port) {
      log(format!(
        "[port] get_momoka_port 就绪：{port}（等待 {}ms）",
        started.elapsed().as_millis()
      ));
      return Ok(port);
    }
    if std::time::Instant::now() >= deadline {
      let message = format!(
        "momoka-server 在 {}s 内没有就绪：端口文件 {} 读不到有效端口，探测线程也没有结果。请查 {} 里的 [boot]/[sidecar] 行，确认 sidecar 是启动失败还是候选端口全被占。",
        PORT_WAIT_MS / 1000,
        port_file.display(),
        log_file_path().display()
      );
      log(format!("[port] 超时：{message}"));
      return Err(message);
    }
    thread::sleep(Duration::from_millis(PORT_POLL_MS));
  }
}

/// sidecar 在候选端口上的归宿。
enum BootOutcome {
  /// 健康，可以采用
  Alive,
  /// 没起来（端口被占 / 启动崩了 / 超时），原因写日志
  Failed(String),
}

/// 等 sidecar 在某个端口上变健康，同时盯着它是不是**自己已经退出**。
///
/// 为什么不能只等健康：端口被占时 sidecar 会立刻退出（几十毫秒），那才是它给出的
/// "这个端口不能用"权威判断——比我们预先 bind 一下猜要准（实测：别的进程只占着
/// 127.0.0.1:8889 时，我们自己 bind 0.0.0.0:8889 会成功，而 sidecar 会失败）。
/// 盯 early-exit 还能避免为注定失败的尝试白等一次完整超时，更避免去强杀一个还活着的
/// 子进程：强杀 bun 后端会留下残留监听，那正是 8888 幽灵的来源。
fn wait_for_boot(port: u16, timeout: Duration, child: &mut std::process::Child) -> BootOutcome {
  let started = std::time::Instant::now();
  loop {
    if probe_health(port) {
      return BootOutcome::Alive;
    }
    match child.try_wait() {
      Ok(Some(status)) => return BootOutcome::Failed(format!("exited early: {status:?}")),
      Ok(None) => {}
      Err(err) => return BootOutcome::Failed(format!("try_wait failed: {err}")),
    }
    if started.elapsed() >= timeout {
      return BootOutcome::Failed(format!("timeout after {}ms", timeout.as_millis()));
    }
    thread::sleep(Duration::from_millis(150));
  }
}

/// 同步 TCP 探测 + 最小 HTTP GET，返回 true 表示确认对面是 MOMOKA 后端。
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
  let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
  // 必须一直读到**响应体**才可能看到 MOMOKA：只读到首行（HTTP/1.0 200 OK）就下结论，
  // 会把一个真在跑的后端判成"没起来"，进而去强杀它——每次误判都会新留一个幽灵监听。
  let mut buf: Vec<u8> = Vec::with_capacity(512);
  let mut chunk = [0u8; 512];
  let deadline = std::time::Instant::now() + Duration::from_millis(800);
  while std::time::Instant::now() < deadline && buf.len() < 4096 {
    match stream.read(&mut chunk) {
      Ok(0) => break,
      Ok(n) => {
        buf.extend_from_slice(&chunk[..n]);
        if health_payload_ok(&buf) {
          return true;
        }
      }
      Err(_) => break,
    }
  }
  health_payload_ok(&buf)
}

/// 认得出是我们的后端，而不是"任何回了 200 的 HTTP 服务"。
fn health_payload_ok(buf: &[u8]) -> bool {
  let text = String::from_utf8_lossy(buf);
  text.contains("200") && text.contains("MOMOKA")
}
