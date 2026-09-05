# MoDuty — Minimalist-Opinion-Model-Optimized Knowledge Agent

批注式判断交互协议 · 极简意见模型 · 文件助手 Agent
https://github.com/Syruph-dot/MoDuty

MoDuty 是一个 TypeScript-first 的智能文件助手 Agent，运行在 SophDotNet 平台上。它通过 **批注式判断交互协议**（Likert 7 点量表）实现人机之间的高效对齐——用户对 Agent 输出的一系列（逐句）评分，自动驱动 Agent 调整后续行为。

当前主实现位于 `src/`，对外暴露 `createMomokaAgent()`、`createOpenAICompatibleModelClient()` 和 `createMomokaHttpHandler()`。外部软件可以直接把 MoDuty 当作 TypeScript package 调用，也可以通过 HTTP API 调用。

## 特性

- **会话级管理** — 每个会话绑定一个核心目标和一个工作文件夹，Agent 的文件操作被限制在该文件夹内
- **技能自动匹配** — 根据用户输入自动匹配并加载对应技能（summarizer、file_organizer 等），按需扩展
- **记忆系统** — 日记忆 + 长期记忆 + 偏好学习，Agent 在交互中持续进化
- **批注式判断** — 7 点 Likert 量表评分，每次评分触发闭环（反思 → 更新偏好 → 进化提案 → 可选续猜）
- **复古 UI** — 多主题（Aero、Metro 等），三栏布局（Agent 状态 · 对话区 · 工具调用日志）

## 快速启动

### 环境要求

- Node.js ≥ 22
- 一个兼容 OpenAI API 的 API Key（推荐阿里云 DashScope / 通义千问）

### 1. 克隆项目

```bash
git clone <repo-url>
cd MoDuty
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

将 `.env.example` 复制为 `.env`，或直接设置环境变量：

```bash
# .env
MOMOKA_MODEL=qwen3.6-flash
```

> **API Key** 通过环境变量设置（优先顺序）：
> - `ALIYUN_API_KEY` — 阿里云 DashScope 密钥
> - `OPENAI_API_KEY` — 通用 OpenAI 兼容密钥
>
> 默认 Base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`（阿里云 DashScope 兼容模式）。
> 可通过 `OPENAI_BASE_URL` 环境变量覆盖为任何 OpenAI 兼容服务。

```bash
# 示例：使用阿里云 DashScope
export ALIYUN_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 示例：使用 OpenAI
export OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export OPENAI_BASE_URL=https://api.openai.com/v1
```

### 4. 构建并启动 Web 服务器

```bash
npm run build
npm start
```

启动后访问 **http://localhost:8888**

终端会显示：
```
MoDuty TypeScript HTTP Server 启动中...
  访问: http://localhost:8888
```

### 5. 外部软件调用 Momoka Agent

```ts
import {
  createMomokaAgent,
  createOpenAICompatibleModelClient,
} from "momoka-ts";

const agent = createMomokaAgent({
  projectRoot: process.cwd(),
  modelClient: createOpenAICompatibleModelClient(),
});

const reply = await agent.chat({
  message: "总结 README.md",
  topic: "项目文档整理",
  workDir: process.cwd(),
});

console.log(reply.outputId, reply.response);
```

`agent.chat()` 返回 `outputId`、`response`、`toolCalls`、`matchedSkills`、`outputAssessment` 等结构化字段；`agent.judge()` 接收 1-7 分评分并可触发续猜。

## Agent Desktop（磁贴化桌面应用）

MoDuty 附带一个 **Tauri 无边框全屏桌面壳**：多个 Agent（1 Agent = 1 session 上下文串）以磁贴形式呈现在全屏磁贴墙上，磁贴实时反映 Agent 状态（idle / running / waiting_approval / completed / error）与阶段（planning / searching / reading / executing / verifying）。双击磁贴进入**分屏展开模式**：未打开磁贴收缩进左半屏坞，打开磁贴（含 SSE 流式对话窗口）在右半屏按 2n / 2n+1 规则展开，多窗口可拖拽重排、拖回左坞或点 × 收起；Agent 等待审批时浮出审批面板。

### 架构

```
MoDuty/
├── src/
│   ├── agent.ts            # 不动：单引擎（LLM client + tool loop + chat）
│   ├── session-manager.ts  # 不动：session CRUD
│   ├── agent-registry.ts   # 多 Agent 注册表（1:1 绑定 session，JSON 持久化）
│   ├── agent-state.ts      # 生命周期状态机 + phase 推导 + 事件总线
│   └── http.ts             # /api/agents 系列 + 状态 SSE（旧路由保持兼容）
├── desktop/                # React + Vite + TS + Zustand 桌面前端
└── src-tauri/              # Tauri v1 壳（borderless fullscreen，加载 desktop 产物）
```

### 桌面开发模式

```bash
# 终端 1：后端（端口 8888）
npm start          # 或 npx tsx src/server.ts

# 终端 2：Vite dev（端口 5173，/api 代理到 8888）
npm run desktop:dev

# 可选：浏览器直连 http://localhost:5173 即可看到磁贴墙
```

### 桌面构建 / 打包

```bash
# 构建（server + 旧前端 + desktop 前端）
npm run build

# 调试产物（免安装器，直接出可执行文件）
cd src-tauri && cargo tauri build --debug --no-bundle
# 产物：src-tauri/target/debug/momoka-desktop.exe

# 完整安装包（需要 NSIS/WiX，用时较长）
cargo tauri build
```

旧 `static/index.html` / `chat.html` 保留为 debug fallback：仍然通过 `http://localhost:8888` 访问，`serveStatic` 未改动。

### 桌面前端结构

`desktop/` 是独立 npm 包：

```
desktop/src/
├── components/     # Desktop / AgentTile / NewAgentTile / SessionTile / AgentWindow / ApprovalPanel / ControlBar
├── state/          # Zustand store（SSE 事件驱动）
├── lib/            # api base 解析、sseClient（重连+轮询降级）、chatStream SSE 解析
└── styles/         # metro 磁贴 + aero 毛玻璃
```

验证工具：`desktop/scripts/ui-smoke.mjs`（headless Chrome CDP 真机 DOM 冒烟，支持 `SMOKE_APPROVAL=1` 与 `SMOKE_EXPECT_STREAM=<text>` 模式）。

## 交互指南

### Web 界面：会话管理

访问 `http://localhost:8888` 进入**会话列表页**：

1. 点击 **「+ 新建会话」**
2. 填写 **核心目标**（如"整理项目文档结构"）
3. 指定 **工作文件夹**（可点击"浏览"用目录选择器选取）
4. 创建成功后，自动进入对话页面

### Web 界面：对话

在对话页中：

- **左侧面板**显示 Agent 身份和能力说明
- **中间区域**是对话区，底部输入框输入任务
- **右侧面板**实时显示工具调用日志和匹配的技能

示例对话：
```
> 列出当前目录的所有文件
> 读取 README.md 的内容
> 帮我写一个文件归档脚本
> 总结 src/ 目录下的所有 TypeScript 文件
```

### 批注式判断交互（核心）

对话中，Agent 每次回复会带有一个 `output_id`。你可以对其回复进行评分：

| 分数 | 标签 | 含义 |
|------|------|------|
| 1 | 强烈反对 | 方向完全偏离 |
| 2 | 反对 | 方向偏离 |
| 3 | 不太赞同 | 接近但不足 |
| 4 | 中立 | 有其他不冲突但不同的想法 |
| 5 | 有点赞同 | 方向正确，有改进空间 |
| 6 | 赞同 | 方向正确，可深化 |
| 7 | 强烈赞同 | 超出预期，完美匹配 |

每次评分触发四个阶段：

1. **Reflect** — 分析评分含义，生成反思摘要
2. **Update Preferences** — 更新 Agent 的偏好模型
3. **Evolve** — 生成技能进化提案（如新增关键词、调整权重）
4. **Continue**（可选）— 基于反思生成续猜输出，形成完整闭环

> 评分 API：`POST /api/judge`，请求体包含 `output_id`、`score`（1-7）、`context`（被评原文）、`comment`（可选文字批注）、`continue`（是否续猜）。

### 文件工具

Agent 支持以下文件操作（受限于会话绑定的工作文件夹）：

- **读取文件** — `read_file(path)`
- **写入文件** — `write_file(path, content)`
- **列出目录** — `list_files(path)`
- **追加内容** — `append_file(path, content)`
- **查询时间** — `get_current_time()`

所有操作被限制在会话绑定的工作文件夹内，无法路径遍历。

## 项目结构

```
MoDuty/
├── src/
│   ├── index.ts           # 对外 package 入口
│   ├── agent.ts           # MomokaAgent 接口化核心
│   ├── model-client.ts    # OpenAI/DashScope compatible 模型客户端
│   ├── http.ts            # HTTP API adapter
│   ├── server.ts          # Node HTTP server 启动入口
│   ├── memory.ts          # 记忆系统：输出账本、批注账本、偏好存储
│   ├── feedback.ts        # 评分分析与续猜 prompt
│   ├── evolution.ts       # 技能进化提案
│   ├── skill-router.ts    # 技能加载与匹配
│   ├── session-manager.ts # 会话管理
│   ├── tools.ts           # 安全文件工具与工具调用执行
│   └── frontend/          # 浏览器脚本 TypeScript 源
├── skills/
│   ├── index.json         # 技能注册表
│   ├── summarizer/        # 摘要技能
│   └── file_organizer/    # 整理技能
├── prompts/
│   └── AGENTS.md          # Agent system prompt（身份、行为规则、安全边界）
├── static/
│   ├── index.html         # 会话管理页面
│   ├── chat.html          # 对话页面
│   ├── css/               # 多主题样式（aero、metro、mobile-framework）
│   └── js/                # 由 src/frontend/*.ts 生成的浏览器脚本
├── memory/                # 记忆存储目录（自动生成）
├── docs/                  # 文档
├── tests-ts/              # TypeScript 契约测试
└── tests-ts/              # TypeScript 契约测试
```

## API 概览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/config` | GET | 查看配置状态 |
| `/api/sessions` | GET | 列出所有会话 |
| `/api/sessions` | POST | 创建新会话 |
| `/api/sessions/{id}` | GET | 获取会话详情 |
| `/api/sessions/{id}` | DELETE | 删除会话 |
| `/api/sessions/{id}/messages` | GET | 获取会话消息历史 |
| `/api/chat` | POST | 发送聊天消息 |
| `/api/judge` | POST | 提交批注评分 |
| `/api/skills` | GET | 列出已加载技能 |
| `/api/memory` | GET | 查看最近记忆 |
| `/api/directories` | GET | 浏览文件系统目录 |
| `/api/agents` | GET | 列出 Agent（含 state/phase + session 摘要） |
| `/api/agents` | POST | 创建 Agent（自动创建其绑定 session） |
| `/api/agents/{id}` | GET | Agent 详情 + 最近消息 |
| `/api/agents/{id}` | DELETE | 删除 Agent（连带删除其 session） |
| `/api/agents/{id}/messages` | GET | Agent 会话消息历史 |
| `/api/agents/{id}/chat` | POST | SSE 流式对话（作用域锁定 Agent 的 session） |
| `/api/agents/events` | GET | SSE 实时广播 `{type:"agent_state", agent_id, state, phase}` |

> 注意：`/api/agents` 系列需要 server 装配 registry + state machine（`createMomokaServer()` 自动装配；直接使用 `createMomokaHttpHandler(agent)` 时返回 503）。

## 扩展：添加新技能

1. 在 `skills/` 下创建子目录，放入 `SKILL.md`（技能 prompt）
2. 在 `skills/index.json` 中注册：

```json
{
  "name": "my_skill",
  "description": "技能描述",
  "trigger_keywords": ["关键词1", "关键词2"],
  "utility_score": 0.8,
  "version": "1.0.0",
  "path": "my_skill/SKILL.md"
}
```

当用户输入包含触发关键词时，Skill Loader 自动匹配并注入该技能的 prompt 到 Agent 上下文中。

## 注意

- 默认使用 **阿里云 DashScope 兼容模式**，一个阿里云 API Key 即可使用通义千问系列模型
- 也支持任意 OpenAI 兼容 API（通过 `OPENAI_BASE_URL` 切换）
- 模型名称通过 `MOMOKA_MODEL` 环境变量指定
- 首次使用时，确保 memory 目录（`memory/`）已创建

## 协议

MoDuty &copy; 2026 SophDotNet · 批注式判断交互协议 · Likert 7-Point Scale
