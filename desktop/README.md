# MOMOKA Agent Desktop

MOMOKA 的磁贴化桌面前端：**React 18 + Vite 6 + TypeScript（strict）+ Zustand 5**，由 `../src-tauri/`（Tauri v1 无边框全屏壳）加载。

**双几何分屏交互**：无磁贴打开时磁贴自由摆放（idle geometry，持久化）；双击磁贴进入打开态——未打开磁贴收缩进左半屏坞，打开磁贴在右半屏舞台按 2n / 2n+1 规则展开（奇数时最后一个独占一列），展开窗口可拖拽（header），拖到左坞松手或点 × 收起并重排。开合过渡为同一减速曲线驱动的尺寸/位移 + Y 轴 3D 翻转（0~90° 显未展开面，90~180° 显展开面，Windows 8 磁贴式）。

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | Vite dev server，端口 **6429**（`/api` 代理到 `http://localhost:7238`） |
| `npm run build` | `tsc` + `vite build`，产物 `dist/`（tauri `distDir`） |
| `npm run preview` | 预览构建产物 |

依赖均在 `desktop/` 内（独立 npm 包，不影响根 repo 的 install）。

## 目录结构

```
src/
├── main.tsx / App.tsx     # 挂载点：磁贴墙 + 审批面板（对话窗口嵌入磁贴；窗口控制在右缘唤出条）
├── types.ts               # 与后端 snake_case 对齐的类型
├── components/
│   ├── Desktop.tsx        # 全屏磁贴墙（双几何分屏：左坞 + 右舞台）
│   ├── AgentTile.tsx      # Agent 磁贴：状态徽章 + phase + session 摘要
│   ├── TileShell.tsx      # 磁贴壳（free/dock/expanded 三模式 + 拖拽/resize/吸附）
│   ├── AgentWindow.tsx    # 对话窗口（SSE 流式，嵌入磁贴）
│   ├── ApprovalPanel.tsx  # waiting_approval 审批面板
│   ├── NewAgentDialog.tsx # 创建 Agent 弹窗（右键菜单触发）
│   ├── ContextMenu.tsx    # 桌面空白处右键菜单
│   └── RightCharm.tsx     # 右缘唤出条（模态切换 / 治理入口 / 窗口控制按钮族）
├── state/
│   ├── agentsStore.ts     # Zustand store（applyAgentEvent 由 SSE 驱动）
│   ├── contextMenuStore.ts
│   ├── dialogStore.ts
│   └── snapGuideStore.ts
├── lib/
│   ├── api.ts             # apiBase 解析（VITE_MOMOKA_API / Tauri / Vite 代理）
│   ├── sseClient.ts       # /api/agents/events 订阅：自动重连 + 轮询降级
│   ├── chatStream.ts      # /api/agents/:id/chat SSE 流式解析（可 abort）
│   ├── dragController.ts  # 拖拽/Resize 鼠标事件控制器
│   ├── snapController.ts  # 磁贴边缘吸附算法
│   ├── layoutEngine.ts    # 双几何布局：左坞网格 + 右舞台 2n/2n+1 展开
│   └── persistTiles.ts    # 磁贴几何 localStorage 持久化
└── styles/
    ├── desktop.css        # 桌面背景样式
    ├── tiles.css          # 磁贴/弹窗/右键菜单样式
    └── window.css         # 对话窗口/审批面板/消息气泡样式
```

## API base 解析规则

1. `VITE_MOMOKA_API`（构建期注入）优先；
2. Tauri webview 内（`window.__TAURI__` 存在）→ `http://localhost:7238`；
3. 浏览器 dev → 同源，走 Vite 的 `/api` 代理。

## 冒烟验证（headless Chrome CDP）

```bash
# 需要：后端在 7238、desktop dev server 在 6429、本机 Chrome
node scripts/ui-smoke.mjs                       # 常规模式：磁贴/弹窗/窗口/审批/SSE 状态
SMOKE_EXPECT_STREAM="hello 123" node scripts/ui-smoke.mjs   # 流式令牌模式（配合 stub）
SMOKE_APPROVAL=1 node scripts/ui-smoke.mjs      # 审批面板模式（配合 stub，见 tests-ts/stub-chat-server.mjs）
node scripts/smoke-split.mjs                    # 分屏模式：双几何布局（2n/2n+1）+ 拖回左坞收起
```

结果 JSON 写入 `ui-smoke-result.json`（`ok:true` 表示全部断言通过；`consoleErrors` 收集浏览器异常）。