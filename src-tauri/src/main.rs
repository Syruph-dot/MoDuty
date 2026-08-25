// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use tauri::api::process::{Command, CommandEvent};
use tauri::Manager;

/// 后端 sidecar 启动后写入的端口文件路径（运行时状态）。
/// 前端通过 `get_momoka_port` 命令读取真实端口，以连接 HTTP API。
struct MomokaServerState {
  port_file: PathBuf,
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      // 端口文件放到系统临时目录（按 OS 习惯：Windows %TEMP% / Linux /tmp / macOS $TMPDIR）
      // 后端通过环境变量 MOMOKA_PORT_FILE 拿到这个路径，启动后把真实端口写入
      let port_file = std::env::temp_dir().join("arona-chest.momoka.port");

      // 把端口文件路径传给后端（如果之前残留了旧文件，先清掉，避免读到陈旧端口）
      let _ = fs::remove_file(&port_file);

      // 启动 sidecar：binaries/momoka-server（target-triple 后缀由 tauri 自动加）
      let mut env = HashMap::new();
      env.insert(
        "MOMOKA_PORT_FILE".to_string(),
        port_file.to_string_lossy().to_string(),
      );
      let sidecar = Command::new_sidecar("momoka-server")
        .map_err(|e| format!("sidecar command not found: {e}"))?
        .envs(env);

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

      app.manage(MomokaServerState { port_file });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![get_momoka_port])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// 前端调用：读取后端写入的端口文件，返回真实监听端口。
/// 前端拿到端口后拼接 `http://127.0.0.1:{port}` 即可调用后端 API。
#[tauri::command]
fn get_momoka_port(state: tauri::State<MomokaServerState>) -> Result<u16, String> {
  let content = fs::read_to_string(&state.port_file)
    .map_err(|e| format!("read port file failed (momoka-server may not be ready yet): {e}"))?;
  let trimmed = content.trim();
  trimmed
    .parse::<u16>()
    .map_err(|e| format!("parse port from {trimmed:?} failed: {e}"))
}
