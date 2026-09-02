#!/usr/bin/env python3
"""
MOMOKA Desktop Shell — 全屏无边框 WebKitGTK 窗口
作为 momoka-session 的桌面主界面进程运行。
环境变量：
  MOMOKA_API_BASE  后端地址（默认 http://127.0.0.1:8888）
  MOMOKA_FRONTEND  前端入口（默认 http://127.0.0.1:8888/desktop/index.html）
"""
import os
import sys
import signal
import subprocess
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, Gdk, GLib

# -------------------- 配置 --------------------
API_BASE = os.getenv("MOMOKA_API_BASE", "http://127.0.0.1:8888")
FRONTEND_URL = os.getenv("MOMOKA_FRONTEND", "http://127.0.0.1:8889/")
WINDOW_TITLE = "MOMOKA Desktop"

# -------------------- 信号处理 --------------------
def sig_handler(signum, frame):
    Gtk.main_quit()

signal.signal(signal.SIGTERM, sig_handler)
signal.signal(signal.SIGINT, sig_handler)

# -------------------- 主窗口 --------------------
class MomokaShell(Gtk.Window):
    def __init__(self):
        print("[momoka-shell] __init__ start", flush=True)
        super().__init__(title=WINDOW_TITLE)
        print("[momoka-shell] after super()", flush=True)
        self.set_wmclass("momoka-shell", "momoka-shell")
        print("[momoka-shell] after set_wmclass", flush=True)
        self.set_decorated(False)              # 无边框
        self.set_skip_taskbar_hint(True)       # 不在任务栏显示（openbox 管理）
        self.set_skip_pager_hint(True)
        self.set_keep_above(False)
        print("[momoka-shell] after window props", flush=True)

        # 全屏尺寸（主显示器）
        screen = self.get_screen()
        monitor = screen.get_display().get_primary_monitor()
        geo = monitor.get_geometry()
        self.set_default_size(geo.width, geo.height)

        # WebView
        self.webview = WebKit2.WebView()
        settings = self.webview.get_settings()
        settings.set_enable_smooth_scrolling(True)
        settings.set_enable_javascript(True)
        settings.set_enable_developer_extras(False)
        settings.set_hardware_acceleration_policy(
            WebKit2.HardwareAccelerationPolicy.ALWAYS
        )
        # 允许 file:// URL 加载本地资源
        settings.set_property("allow-file-access-from-file-urls", True)
        settings.set_property("allow-universal-access-from-file-urls", True)

        # 注入环境标记：前端 js 通过 window.__MOMOKA_SHELL__ 识别运行环境
        self.webview.connect("resource-load-started", self._inject_shell_marker)

        self.add(self.webview)
        self.connect("delete-event", lambda *a: True)  # 阻止关闭
        print("[momoka-shell] before show_all", flush=True)
        self.show_all()
        print("[momoka-shell] after show_all", flush=True)
        # 先不全屏，测试普通窗口
        # self.fullscreen()
        print("[momoka-shell] after fullscreen (skipped)", flush=True)
        # 强制置顶
        self.set_keep_above(True)
        self.present()
        print(f"[momoka-shell] window shown, mapped={self.get_mapped()}, visible={self.get_visible()}", flush=True)

        # 加载前端
        self.webview.load_uri(FRONTEND_URL)
        print(f"[momoka-shell] loading {FRONTEND_URL}", flush=True)

    def _inject_shell_marker(self, view, resource, request):
        """页面开始加载时注入 __MOMOKA_SHELL__ = true，供 api.ts 检测"""
        script = """
        if (typeof window !== 'undefined') {
            Object.defineProperty(window, '__MOMOKA_SHELL__', {
                value: true,
                writable: false,
                configurable: false
            });
        }
        """
        # 使用 user content manager 注入
        mgr = view.get_user_content_manager()
        mgr.register_script_message_handler("momoka")
        view.run_javascript(script, None, lambda *a: None)


def main():
    # 设置进程名
    GLib.set_prgname("momoka-shell")

    # 确保能连 X
    if not Gdk.Display.get_default():
        print("[momoka-shell] ERROR: No X display", file=sys.stderr)
        sys.exit(1)

    MomokaShell()
    Gtk.main()


if __name__ == "__main__":
    main()