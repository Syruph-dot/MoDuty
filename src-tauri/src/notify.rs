//! Windows 系统通知（真正的 Toast）
//!
//! 为什么不直接用 tauri 自带的 notification：tauri 1.8.3 在 Windows 上当 exe 位于
//! `target\debug` / `target\release` 时**故意跳过** AppUserModelID
//! （见 tauri `src/api/notification.rs` 的 Windows 分支，注释写着 "set the notification's
//! System.AppUserModel.ID only when running the installed app"）。而 Windows 对"没有 AUMID 的
//! 未打包进程"发来的 toast 是**静默丢弃**的：不报错、不显示。开发/免安装运行时看到的现象就是
//! "通知是假的"——只剩网页里自绘的卡片，系统通知永远不出现。
//!
//! 所以这里自己把 AUMID 这套补齐（幂等），再用 `tauri-winrt-notification` 发送。三条缺一不可：
//!   1. 进程级 `SetCurrentProcessExplicitAppUserModelID`；
//!   2. 开始菜单快捷方式，且其 `System.AppUserModelID` 属性 = 本 AUMID（Windows 主要认这个）；
//!   3. `HKCU\SOFTWARE\Classes\AppUserModelId\<AUMID>`（DisplayName / IconUri，决定通知上显示的名字与图标）。
//!
//! 只有注册表、没有快捷方式时，Windows 仍然会静默丢弃 toast —— 实测过。

use std::path::{Path, PathBuf};

use tauri::Emitter;
use tauri_winrt_notification::{Duration, Sound, Toast};
use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT, PROPVARIANT_0_0};
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IPersistFile,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{SetCurrentProcessExplicitAppUserModelID, IShellLinkW, ShellLink};

/// 与 tauri.conf.json 的 bundle.identifier 一致：安装版与开发版共用同一个 AUMID，
/// 这样通知的来源名/图标是同一个应用，用户不会看到两个不同的"发送者"。
const AUMID: &str = "com.aronachest.app";
const APP_NAME: &str = "MoDuty";
const SHORTCUT_FILE_NAME: &str = "MoDuty.lnk";

/// `PKEY_AppUserModel_ID`：{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
  fmtid: windows::core::GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
  pid: 5,
};

fn exe_path() -> Result<PathBuf, String> {
  std::env::current_exe().map_err(|error| format!("current_exe 失败: {error}"))
}

/// 当前用户的开始菜单 Programs 目录下的快捷方式路径
fn shortcut_path() -> Result<PathBuf, String> {
  let appdata = std::env::var_os("APPDATA").ok_or_else(|| "APPDATA 不可用".to_string())?;
  let mut path = PathBuf::from(appdata);
  path.push("Microsoft");
  path.push("Windows");
  path.push("Start Menu");
  path.push("Programs");
  path.push(SHORTCUT_FILE_NAME);
  Ok(path)
}

/// 幂等地补齐 AUMID 环境。启动时调用一次即可；失败不应影响应用启动。
pub fn ensure_identity() -> Result<(), String> {
  let exe = exe_path()?;
  let shortcut = shortcut_path()?;
  set_process_aumid()?;
  write_shortcut(&shortcut, &exe)?;
  write_aumid_registry(&exe)?;
  Ok(())
}

fn set_process_aumid() -> Result<(), String> {
  unsafe {
    SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID))
      .map_err(|error| format!("SetCurrentProcessExplicitAppUserModelID 失败: {error}"))
  }
}

/// 只初始化一次 COM；已经初始化过（S_FALSE）或用别的套间模式初始化过
/// （RPC_E_CHANGED_MODE）都不影响后续 ShellLink 调用。
fn com_init() {
  unsafe {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
  }
}

/// 一次建成「指向本 exe 的开始菜单快捷方式」，并把 System.AppUserModelID 属性写成 AUMID。
/// 幂等：每次启动重写一遍（开销在毫秒级），避免"快捷方式被删/被改过"导致通知静默失效。
fn write_shortcut(shortcut: &Path, exe: &Path) -> Result<(), String> {
  let parent = exe.parent().map(|path| path.to_string_lossy().to_string()).unwrap_or_default();
  let exe_text = exe.to_string_lossy().to_string();
  let shortcut_text = shortcut.to_string_lossy().to_string();
  unsafe {
    com_init();
    let link: IShellLinkW =
      CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|error| format!("创建 ShellLink 失败: {error}"))?;
    link
      .SetPath(&HSTRING::from(exe_text.as_str()))
      .map_err(|error| format!("SetPath 失败: {error}"))?;
    let _ = link.SetWorkingDirectory(&HSTRING::from(parent.as_str()));
    let _ = link.SetDescription(&HSTRING::from(APP_NAME));

    // 先把 AUMID 属性写进 ShellLink 的 property store，再整体 Save 到 .lnk
    let store: IPropertyStore = link.cast().map_err(|error| format!("取 IPropertyStore 失败: {error}"))?;
    let mut variant = propvariant_from_str(AUMID)?;
    let result = store
      .SetValue(&PKEY_APPUSERMODEL_ID, &variant)
      .and_then(|_| store.Commit());
    let _ = PropVariantClear(&mut variant);
    result.map_err(|error| format!("写入快捷方式 AUMID 失败: {error}"))?;

    let persist: IPersistFile = link.cast().map_err(|error| format!("取 IPersistFile 失败: {error}"))?;
    persist
      .Save(&HSTRING::from(shortcut_text.as_str()), true)
      .map_err(|error| format!("保存快捷方式失败: {error}"))?;
  }
  Ok(())
}

/// 构造 `VT_LPWSTR` 的 PROPVARIANT（字符串内存归 COM 任务分配器所有）
fn propvariant_from_str(value: &str) -> Result<PROPVARIANT, String> {
  let mut wide: Vec<u16> = value.encode_utf16().collect();
  wide.push(0);
  let mut variant = PROPVARIANT::default();
  unsafe {
    let bytes = wide.len() * std::mem::size_of::<u16>();
    let raw = CoTaskMemAlloc(bytes) as *mut u16;
    if raw.is_null() {
      return Err("CoTaskMemAlloc 失败".to_string());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), raw, wide.len());
    let entry: &mut PROPVARIANT_0_0 = &mut variant.Anonymous.Anonymous;
    entry.vt = VT_LPWSTR;
    entry.Anonymous.pwszVal = PWSTR(raw);
  }
  Ok(variant)
}

fn write_aumid_registry(exe: &Path) -> Result<(), String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let key_path = format!("SOFTWARE\\Classes\\AppUserModelId\\{AUMID}");
  let (key, _) = hkcu
    .create_subkey(&key_path)
    .map_err(|error| format!("创建 AppUserModelId 注册项失败: {error}"))?;
  key
    .set_value("DisplayName", &APP_NAME)
    .map_err(|error| format!("写 DisplayName 失败: {error}"))?;
  key
    .set_value("IconUri", &exe.to_string_lossy().to_string())
    .map_err(|error| format!("写 IconUri 失败: {error}"))?;
  Ok(())
}

/// 通知上的一个按钮
pub struct ToastAction {
  pub id: String,
  pub label: String,
}

/// 按钮被点的 payload（前端 `listen` 里读 `.payload.action`）
#[derive(Clone, serde::Serialize)]
struct ToastActionPayload {
  action: String,
}

/// 通知按钮被点击时回传前端的事件名
pub const TOAST_ACTION_EVENT: &str = "moduty-toast-action";

/// 带按钮的系统通知：按钮被点 → 通过 Tauri 事件把 action id 回传前端。
///
/// 实测（Windows 11 / 未打包应用 / 发通知的进程仍在运行）：按钮点击会走进程内 WinRT
/// `Activated` 回调并带上按钮的 arguments，**不需要**注册 COM 激活器，**也不需要**单实例转发。
/// 若点击通知主体（而不是按钮），arguments 为空，此时不回传（前端仍可从任务栏/窗口进入）。
pub fn toast_with_actions(
  app: &tauri::AppHandle,
  title: &str,
  body: &str,
  actions: &[ToastAction],
) -> Result<(), String> {
  let _ = set_process_aumid();
  let mut toast = Toast::new(AUMID)
    .title(title)
    .text1(body)
    .sound(Some(Sound::Default))
    .duration(Duration::Short);
  for action in actions {
    toast = toast.add_button(&action.label, &action.id);
  }
  let handle = app.clone();
  toast
    .on_activated(move |arguments| {
      if let Some(action) = arguments {
        let _ = handle.emit(TOAST_ACTION_EVENT, ToastActionPayload { action });
      }
      Ok(())
    })
    .show()
    .map_err(|error| format!("发送 toast 失败: {error}"))
}
