# 磁贴内嵌真实浏览器（Tauri v2 多 webview）— 尖刀验证记录（2026-09-28）

## 这份文档回答什么

「浏览器画面投影进磁贴」被否决后（帧投影不可操作、画质与坐标点击不可接受），选定路线是
**升级 Tauri v2，用 `unstable` 的多 webview 把真实 WebView2 嵌进磁贴**（记为 P2）。
本文记录的是动工之前必须问清、且只能靠实机问清的问题与结果：

1. v2 的 `unstable` 多 webview 在 Windows 上到底能不能起；
2. 子 webview 能不能精确挂在磁贴矩形里、运行时改位置与尺寸；
3. 每个 webview 独立 profile（持久 / 隐身）是否真的生效、会不会互相串；
4. 后端能不能不开调试端口直接驱动它（读页面状态、截图、注入输入）。

验证代码在 `src-tauri/src/webview_spike.rs`，只在 `MoDuty.exe --webview-spike` 时执行，
正常启动路径不受影响。报告与截图落在 `%TEMP%\moduty-spike\`。

## 结论：四问全部成立

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| `add_child` 能否起子 webview | 能，单个约 0.7–0.8 s | `webviews 1 → 2`，随后 3 个并存 `1 → 4` |
| 能否挂进磁贴矩形并运行时改尺寸 | 能，按**物理像素**精确生效 | 请求 960×620 → CSS 视口 549×355；改 640×400 → 366×229（缩放 1.75） |
| 独立 profile / 隐身 | 都生效，且互相隔离 | 持久 profile 重启后读到上次 token；隐身连跑两次都是新会话；3 磁贴各自的 `localStorage` 只看到自己 |
| 后端能否直接驱动（无调试端口） | 能 | `Browser.getVersion` → `Edg/154.0.4258.37`；`Runtime.evaluate`、`Page.captureScreenshot`、`Input.*` 全部可用 |

输入注入（后端"操作页面"的全部手段）实测：

- `Input.dispatchMouseEvent`（mousePressed + mouseReleased）点中 example.com 的 `Learn more`
  → 真的导航到 `https://www.iana.org/help/example-domains`；
- `Input.dispatchMouseEvent`（mouseWheel，deltaY 800）→ `scrollY` 0 → 800；
- `Input.insertText` → 目标输入框的 `value` 变成 `moduty`。

页面像素证据（`Page.captureScreenshot` 存 PNG，可直接打开看）：外部站 example.com、
我们自己的 `http://127.0.0.1:<port>/`、以及 3 磁贴并存时各自的截图，都是真实渲染内容。

## 落地时必须知道的细节

**坐标是物理像素，React 是 CSS 像素。** 本机缩放 175%（`devicePixelRatio = 1.75`），
`set_position` / `set_size` / `add_child` 的初值都吃物理像素；React 布局给的是 CSS 像素。
磁贴做拖拽/缩放时必须乘 `devicePixelRatio`，反过来读回视口尺寸时要除。这条弄错会表现为
"磁贴里的页面明显偏大/偏小、点击位置不准"。

**子 webview 永远盖在 React 上层。** 原生视图不参与 DOM 层级，React 画不到它上面。
所以磁贴要用 React 做的头部工具条（地址、前进后退、关闭）必须占在 webview 矩形**之外**
的独立条带里，靠 `set_bounds` 给 webview 留出那块空间。

**CDP 调用的线程约束。** `with_webview` 把闭包派发到 UI 线程并阻塞调用方；
而 `CallDevToolsProtocolMethod` 的完成回调也是投递到 UI 线程消息循环的。
所以正确写法是：**在 `with_webview` 里只发起调用、把结果丢进 channel，真正的等待放在闭包外面**
（`webview_spike.rs::cdp`）。在 UI 线程上等结果会死锁。

**`CallDevToolsProtocolMethod` 返回的就是 CDP 消息里的 result 载荷**，外面没有再包一层
`{"result": …}`：取 `Runtime.evaluate` 的值路径是 `/result/value`（不是 `/result/result/value`）。

**等页面就绪不能只看 `document.readyState`。** 新 webview 一开始是 `about:blank`，
而 `about:blank` 的 readyState 也是 `complete`，只看它会在导航开始前就"通过"，
于是之后的脚本都打在不透明源上（写 `localStorage` 直接抛 SecurityError）。
必须同时匹配目标 URL 前缀。

**`data_directory` 可以每个 webview 一份，且能与主窗口默认环境共存**（实测 3 个不同 profile
的子 webview + 主窗口同进程运行）。关闭用 `Webview::close()`，闭包外确认
`app.webviews()` 已少掉对应 label。

**多磁贴并发可用**，每个都能单独 `Runtime.evaluate` 与 `Page.captureScreenshot`（即使互相
遮挡），这对"多个浏览器磁贴同时被 Agent 驱动"是必要条件。

## 尚未验证（需要人眼/人手）

自动注入的输入走的是 CDP，**真人用鼠标键盘直接操作磁贴里的页面尚未实测**（原理上它就是一个
获得焦点的原生子视图，应当正常）。这一条只能在界面上手动点一次确认：点链接、滚轮、输入框。

## 与后端既有浏览器栈的关系

现有后端用 Playwright 驱动 Edge，而**Playwright 的传输层在打包后的 bun 二进制里不可用**
（`launchPersistentContext` / `connectOverCDP` 都挂死，dev 的 node/tsx 正常）。
本次验证表明可以彻底绕开它：Rust 侧持 `ICoreWebView2Controller` 直接发 CDP，
再把请求代理给后端即可，不需要 Playwright，也不需要开远程调试端口。
