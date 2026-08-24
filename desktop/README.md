# MOMOKA Agent Desktop

MOMOKA 的磁贴化桌面前端：**React 18 + Vite 6 + TypeScript（strict）+ Zustand 5**，由 `../src-tauri/`（Tauri v1 无边框全屏壳）加载。

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | Vite dev server，端口 **5173**（`/api` 代理到 `http://localhost:8888`） |
| `npm run build` | `tsc` + `vite build`，产物 `dist/`（tauri `distDir`） |
| `npm run preview` | 预览构建产物 |

依赖均在 `desktop/` 内（独立 npm 包，不影响根 repo 的 install）。

## 目录结构

```
src/
├── main.tsx / App.tsx     # 挂载点：磁贴墙 + 控制条 + 审批面板 + 对话窗口
├── types.ts               # 与后端 snake_case 对齐的类型
├── components/
│   ├── Desktop.tsx        # 全屏磁贴墙（加载 store、订阅 SSE）
│   ├── AgentTile.tsx      # Agent 磁贴：状态徽章 + phase + session 摘要
│   ├── NewAgentTile.tsx   # "+" 磁贴 + 创建弹窗
│   ├── SessionTile.tsx    # legacy /api/sessions 磁贴
│   ├── AgentWindow.tsx    # 对话窗口（SSE 流式）
│   ├── ApprovalPanel.tsx  # waiting_approval 审批面板
│   └── ControlBar.tsx     # 无边框窗口的浮动控制条（最小化/关闭）
├── state/agentsStore.ts   # Zustand store（applyAgentEvent 由 SSE 驱动）
├── lib/
│   ├── api.ts             # apiBase 解析（VITE_MOMOKA_API / Tauri / Vite 代理）
│   ├── sseClient.ts       # /api/agents/events 订阅：自动重连 + 轮询降级
│   └── chatStream.ts      # /api/agents/:id/chat SSE 流式解析（可 abort）
└── styles/                # metro 磁贴 + aero 毛玻璃 + 窗口/审批面板
```

## API base 解析规则

1. `VITE_MOMOKA_API`（构建期注入）优先；
2. Tauri webview 内（`window.__TAURI__` 存在）→ `http://localhost:8888`；
3. 浏览器 dev → 同源，走 Vite 的 `/api` 代理。

## 冒烟验证（headless Chrome CDP）

```bash
# 需要：后端在 8888、desktop dev server 在 5173、本机 Chrome
node scripts/ui-smoke.mjs                       # 常规模式：磁贴/弹窗/窗口/审批/SSE 状态
SMOKE_EXPECT_STREAM="hello 123" node scripts/ui-smoke.mjs   # 流式令牌模式（配合 stub）
SMOKE_APPROVAL=1 node scripts/ui-smoke.mjs      # 审批面板模式（配合 stub，见 tests-ts/stub-chat-server.mjs）
```

结果 JSON 写入 `ui-smoke-result.json`（`ok:true` 表示全部断言通过；`consoleErrors` 收集浏览器异常）。