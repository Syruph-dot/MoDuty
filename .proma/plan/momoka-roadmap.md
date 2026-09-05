# MOMOKA 迭代路线图（v2026-09-05）

> 基于用户最新指令重写。核心原则：**Widget 优先、CLI 驱动、增量计算、D3.js 力导向、局部渲染交互**。

---

## 现有资产盘点

| 模块 | 状态 | 复用价值 |
|------|------|----------|
| `SessionManager` | 成熟 | 会话 CRUD、跨会话检索、transcript.md 自动生成、流式消息 |
| `Widget 系统` | 成熟 | `widgetRegistry`、`tileStore` 几何统一、`WidgetInstance` 模型 |
| `DutyGirl Widget` | 成熟 | `&ses_` 候选、MOMOKA CLI 调度、SSE 流式对话 |
| `Momoka CLI` | 成熟 | `agent create/chat/reset/stop`、`session list/inspect`、`&ses_` 链接传递 |
| `model-client.ts` | 单轨道 | 需改造为 `high/low/exact` 双轨道 + 手动覆盖 |
| `relation-graph.ts` | 存根 | 需实现增量会话关系图 |
| `automation skill` | Proma 内置 | 定时任务（日报触发可选，但用户要求 CLI 手动触发） |
| `desktop 公共样式` | 完备 | `tile-shell.css`、磁贴动画、Portal 对话框隔离 |

---

## Phase 1：日报 Widget（约 1.5 周）

> **定位**：桌面磁贴 Widget，非 Agent。展示日历 → 点击日期 → 时间轴日报。点击「生成日报」按钮 → 调用 Momoka CLI → 消费「上次生成后到现在」的增量会话变更。

### 1.1 后端：增量会话变更检测 API

| 任务 | 细节 | 产出文件 |
|------|------|----------|
| **新增 `lastDailyGenAt` 持久化** | 记录「上次日报生成开始时间戳」（ISO 字符串），存 `memory/.daily-gen-meta.json` | `src/daily-meta.ts` |
| **新增 `getChangedSessionsSince(timestamp)`** | 返回 `{ newSessions: [], changedSessions: [{id, name, goal, changedTurnRanges: [[from,to],...], snippet}] }`<br>• 新建：`createdAt > timestamp`<br>• 变更：`lastMessageAt > timestamp` 且 `createdAt <= timestamp`<br>• `changedTurnRanges`：对比上次生成时的 `messageCount` 与当前，推算新增 turn 区间 | `src/session-manager.ts` 扩展方法 |
| **新增 HTTP 端点** | `GET /api/daily/changed-sessions?since=ISO` → 供 Widget 调用 | `src/http.ts` 新增路由 |
| **新增 HTTP 端点** | `POST /api/daily/generate` body: `{ since, modelTier? }` → 触发日报生成（调用 Momoka CLI 或直接跑低成本模型） | `src/http.ts` |

### 1.2 前端：日报 Widget 组件

| 任务 | 细节 | 产出文件 |
|------|------|----------|
| **注册 `daily` widget** | `kind: "daily"`，默认 2×2，`fixedSize: false` | `desktop/src/state/widgetRegistry.tsx` |
| **组件 `DailyWidget.tsx`** | 三态：<br>1. **日历视图**（月历网格，标记有日报的日期）<br>2. **时间轴视图**（点击日期展开，按时段渲染日报条目）<br>3. **生成中/结果态**（调用 CLI，轮询进度） | `desktop/src/components/widgets/DailyWidget.tsx` |
| **日历导航** | 月份切换、今日高亮、有日报日期加圆点 | 同上 |
| **时间轴渲染** | 分组按时段（凌晨/上午/下午/晚上），每条显示：会话名、目标、新增/变更 turn 摘要、跳转按钮（打开会话磁贴） | 同上 |
| **「生成日报」按钮** | 点击 → `POST /api/daily/generate` → SSE 或轮询 → 完成后自动刷新当日时间轴 | 同上 |
| **样式** | 复用 `tile-shell.css` 变量，深/浅主题自适应 | `desktop/src/styles/tiles.css` 追加 |

### 1.3 Momoka CLI 集成日报生成

| 任务 | 细节 | 产出文件 |
|------|------|----------|
| **CLI 新增 `daily generate` 子命令** | `momoka daily generate [--since ISO] [--model low]` → 调用 `/api/daily/generate` | `bin/momoka.mjs` |
| **日报生成 Prompt 模板** | 输入：`changedSessions` 结构化数据<br>输出：Markdown，按时段分组，每条含：会话链接 `&ses_xxx`、变更位置 `turns 12-15`、一句话摘要<br>模板存 `prompts/daily-generation.md` | `prompts/daily-generation.md` |
| **低成本模型轨道** | `model-client.ts` 支持 `modelTier: 'low'` 走便宜模型（如 `qwen-turbo`/`gpt-3.5-turbo`） | `src/model-client.ts` 重构 |

---

## Phase 2：会话关系图谱（约 1 周）

> **定位**：增量解析会话间关系，构建有向图（节点=会话，边=引用/派生/相似）。无需语法解析，直接利用现有 `transcript.md`、`searchContentInSession`、Ampersand 引用。

### 2.1 关系抽取逻辑

| 关系类型 | 来源 | 判定规则 |
|----------|------|----------|
| `references` (→) | 消息内容含 `&ses_xxx` / `&tile_yyy` | 正则提取句柄，建立有向边 |
| `derived_from` (→) | 会话 goal 显式提及另一会话名/ID | 启发式：goal 包含其他会话 `name` 或 `id` |
| `similar_to` (↔) | `searchContentInSession` 高分命中 | 双向边，权重 = 相似度分数 |
| `continues` (→) | 同一 `folderPath` 下连续创建的会话 | 时间序 + 同目录 → 顺序边 |

### 2.2 实现

| 任务 | 细节 | 产出文件 |
|------|------|----------|
| **实现 `refreshSessionGraph(sessionsDir, sessionId?)`** | 增量：只处理 `lastMessageAt > lastGraphUpdate` 的会话；全量：可选 `force=true`<br>输出写入 `memory/.session-graph.json`：`{ nodes: [{id, name, goal, type, updatedAt}], edges: [{source, target, type, weight, evidence}] }` | `src/relation-graph.ts` 完整实现 |
| **HTTP 端点** | `GET /api/graph/sessions?since=ISO&limit=500` → 前端力导向图消费 | `src/http.ts` |
| **定时/触发刷新** | `SessionManager.addMessage` 后调用 `refreshSessionGraph`（防抖 5s）；或日报生成后触发 | `src/session-manager.ts` 集成 |

---

## Phase 3：力导向图磁贴（约 1.5 周）

> **定位**：可打开的桌面磁贴 Widget（`kind: "graph"`），内嵌 D3.js 力导向布局。支持局部渲染（视口裁剪）、节点点击交互（展开/跳转/固定）。

### 3.1 依赖与样例参考

```bash
cd desktop && npm i d3 @types/d3
```

**参考 D3 官网样例**：
- Force-Directed Graph：https://observablehq.com/@d3/force-directed-graph
- Force with Clustering：https://observablehq.com/@d3/force-directed-graph-with-clustering
- Drag & Pin：https://observablehq.com/@d3/drag-force-directed-graph

### 3.2 组件实现

| 任务 | 细节 | 产出文件 |
|------|------|----------|
| **注册 `graph` widget** | 默认 3×3，可 resize | `widgetRegistry.tsx` |
| **`GraphWidget.tsx` 核心** | • `useEffect` 初始化 `d3.forceSimulation`<br>• 节点：会话（按 type 着色：daily/agent/chat）<br>• 边：`references` 实线、`similar_to` 虚线、`continues` 箭头<br>• **局部渲染**：SVG `viewBox` 跟随平移缩放，只渲染视口内节点+边（`d3.zoom` + `filter`）<br>• **交互**：<br>  - 拖拽节点 → 固定（`fx/fy`）<br>  - 双击节点 → 展开/收起 1 度邻居（动态增减 nodes/links 并 `simulation.alpha(1).restart()`）<br>  - 点击节点 → 右侧面板显示会话摘要、跳转按钮（`window.dispatchEvent('momoka:open-session', {id})`）<br>  - 悬停 → 高亮邻居、显示 tooltip | `desktop/src/components/widgets/GraphWidget.tsx` |
| **约束参数面板** | 可折叠侧边栏：引力/斥力、连线长度、碰撞半径、中心力、是否启用聚类 | 同上 |
| **性能** | 节点 > 300 时自动启用 `canvas` 渲染或 `webgl`（可选），默认 SVG 足够 | 同上 |

### 3.3 磁贴集成

- `TileShell.tsx` 自动渲染 `GraphWidget`（通过 `WIDGET_REGISTRY.renderBody`）
- 磁贴标题显示节点数/边数，右键菜单「刷新图谱」「重置布局」「导出 JSON」

---

## 跨阶段共享技术债

| 项目 | 说明 |
|------|------|
| **双轨道模型** | `model-client.ts` 重构：`resolveModelConfig({ tier: 'high'|'low'|'exact', exactModel? })`，配置文件 `config/model-tiers.json` |
| **会话跳转事件** | 统一 `window.dispatchEvent(new CustomEvent('momoka:open-session', {detail:{id}}))`，`Desktop.tsx` 监听并打开对应 AgentTile/Widget |
| **日期工具** | 复用 `desktop/src/lib/utils.ts` 或新增 `date-utils.ts`：`formatISO`、`startOfDay`、`eachDayOfInterval` 等 |
| **TypeScript 类型同步** | `desktop/src/types.ts` 同步新增 `WidgetKind = "daily" | "graph"`、图谱节点/边类型 |

---

## 里程碑与验收标准

| 里程碑 | 验收标准 | 预计完成 |
|--------|----------|----------|
| **M1：日报 Widget 可用** | 1. 磁贴打开显示月历<br>2. 点击日期展开时间轴（有数据）<br>3. 点「生成日报」→ CLI 触发 → 5 秒内出结果 → 当日时间轴自动刷新<br>4. 日报条目含 `&ses_xxx` 可点击跳转 | Week 1 末 |
| **M2：关系图谱落盘** | 1. `GET /api/graph/sessions` 返回合法 nodes/edges<br>2. `references` 边覆盖所有 `&ses_` 引用<br>3. 新建/变更会话后 5s 内图谱增量更新 | Week 2 末 |
| **M3：力导向图磁贴可交互** | 1. 磁贴打开渲染力导向图（>50 节点 60fps）<br>2. 拖拽固定、双击展开、点击跳转、悬停高亮均正常<br>3. 参数面板实时生效 | Week 3 末 |

---

## 立即行动项（Today）

1. **创建 `src/daily-meta.ts`**：`lastDailyGenAt` 读写 + `getChangedSessionsSince` 接口设计
2. **在 `model-client.ts` 引入 `modelTier`**：先加类型与解析逻辑，默认 `high`，`low` 走 `qwen-turbo`/`gpt-3.5-turbo`
3. **注册 `daily` widget 占位**（先只渲染「正在开发」），验证 WidgetRegistry 热加载
4. **安装 D3**：`cd desktop && npm i d3 @types/d3`

---

## 风险与对策

| 风险 | 对策 |
|------|------|
| D3 SVG 性能随节点数下降 | 300+ 节点切 Canvas/WebGL；首版限制 `limit=200` |
| Momoka CLI 异步调用超时 | CLI 子命令设置 120s 超时；Widget 轮询进度而非阻塞 |
| 会话变更位置定位不准 | `changedTurnRanges` 基于 `messageCount` 差分，若流式消息导致 count 不准，改用 `turn` 号显式存储 |
| 双轨道模型配置复杂 | 先硬编码两个模型名，后续再做 Settings UI |

---

## 文件变更清单（预估）

### 新增
- `src/daily-meta.ts`
- `src/relation-graph.ts`（全量重写）
- `prompts/daily-generation.md`
- `desktop/src/components/widgets/DailyWidget.tsx`
- `desktop/src/components/widgets/GraphWidget.tsx`
- `desktop/src/lib/date-utils.ts`（可选）

### 修改
- `src/session-manager.ts`（增量图刷新、变更检测）
- `src/model-client.ts`（双轨道）
- `src/http.ts`（新增 3 个端点）
- `src/tools.ts`（如需新增工具）
- `bin/momoka.mjs`（`daily generate` 子命令）
- `desktop/src/state/widgetRegistry.tsx`（注册 daily/graph）
- `desktop/src/types.ts`（新增类型）
- `desktop/src/styles/tiles.css`（widget 样式追加）

---

> **下一步**：确认无异议后，从 `src/daily-meta.ts` + `model-client.ts` 双轨道重构开始并行推进。