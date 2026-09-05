# 磁贴墙治理方案（A + B + D 组合）— 桌面端 MoDuty

> 状态：设计方案（待评审） ｜ 范围：`desktop/src`（App.tsx / Desktop.tsx / AgentTile.tsx / agentsStore.ts） 日期：2026-09-01 决策背景：Agent 数量增长后，全屏磁贴墙出现「磁贴泛滥」——所有 Agent 平铺、互相挤压、无检索入口。 选定组合：**A 搜索+筛选+排序** ＋ **B 按工作区分组** ＋ **D 活跃/归档两层制**（本次不做 C 分页）。

---

## 1. 现状与问题

| 项 | 现状 | 问题 |
| --- | --- | --- |
| 磁贴布局 | `agentsStore.tiles` 记录每个 Agent 自由网格坐标，`Desktop.tsx` 全屏平铺 | Agent 一多就铺满墙、满屏拥挤 |
| 展示信息 | `AgentTile.tsx` 展示 name/state/phase 等 | 无检索、无分组、无优先级 |
| 数据源 | `Agent`（types.ts）已有 `workspace_dir`、`created_at`、`last_active_at`、`session.message_count`、`session.last_message_at`；SSE 实时更新 state | **字段都有，但 UI 完全没用起来** |
| 持久化 | `tiles` 已存 localStorage（`momoka:tiles:packed-colfirst-v2`） | 可沿用同一套 localStorage 模式存 UI 偏好 |

**核心结论**：问题不在数据，而在「所有 Agent 无差别平铺、只能靠肉眼找」。治理策略 = **让墙只展示马上要用到的，其余全部可检索可展开**。

---

## 2. 方案总览：三级漏斗

```
        ┌─────────────────────────────────────────┐
        │  D 磁贴墙（活跃层）      ← 默认看到的    │
        │  只放：手动钉住的 + 最近活跃的          │
        └──────────────────┬──────────────────────┘
                           │ B 按工作区折叠分组（组头可展开/收起）
        ┌──────────────────▼──────────────────────┐
        │  全文检索 A（搜索框，命中任意字段）       │
        │  筛选 chips：工作区 / 时间段 / 状态       │
        │  排序：最近活跃 / 新建 / 消息数           │
        └──────────────────┬──────────────────────┘
                           │
        ┌──────────────────▼──────────────────────┐
        │  归档库（D）：侧边面板，列表形式+搜索     │
        │  自动归档：N 天未活跃 → 移出墙            │
        └─────────────────────────────────────────┘
```

- **D 负责减量**：墙上默认只出现活跃/钉住的 Agent，从源头消除泛滥。
- **B 负责组织**：同工作区的 Agent 聚在一起，可折叠，墙变有序。
  - 注释：聚在一起的，和前后组在布局上分开，按X轴分开，某一组占有一个X区间的空间，并在上面预留空间左对齐显示组称，使用Segoe UI细体
- **A 负责兜底**：任何时候都能用搜索/筛选精确命中，不依赖肉眼扫墙。
- 三个方案作用于「视图层」，**不改变 tiles 物理网格**，尽量减少对现有布局系统的侵入。

---

## 3. 设计原则

1. **视图层改造，布局层不动**：`tiles` 网格坐标继续保留；分组/归档/过滤都是「显示哪些磁贴、怎样排列显示」，不重写拖拽摆放逻辑。
2. **UI 偏好本地化**：`pinnedIds` / `archivedIds` / 筛选器状态属于用户界面偏好，存 localStorage（模式同现有 `tiles`），**不改后端 API、不新增 Agent 字段**。
3. **默认保守**：新功能全部默认温和（自动归档阈值 14 天），不迁移、不批量动用户现有磁贴。
4. **离线可用**：搜索先做**本地过滤**（agents 数组已在内存，字段齐全），不依赖 `/api/sessions/search`；后续如需全文命中 goal 正文可再接入。

---

## 4. 方案 A：搜索 + 筛选 + 排序

### 4.1 入口

在 `ControlBar.tsx` 浮动控制条增加一个**搜索/筛选按钮**，点击展开顶部「治理栏」（新组件 `AgentFilterBar.tsx`）。禁用圆角矩形。

### 4.2 搜索

- 输入即过滤（本地，防止刚输入立刻发生检索爆炸，按下Enter后再开始搜索），匹配字段：`name`、`role`、`workspace_dir`、`session.goal`、`session.folder_path`。
- 高亮命中文本（`AgentTile` 内 name/goal 做 `<mark>`）。
- 命中 0 时显示空态提示「未找到，可尝试放宽筛选」+「打开归档库再找」按钮。

### 4.3 筛选 chips（可多选叠加）

| Chip 组 | 选项 | 取值 |
| --- | --- | --- |
| 工作区 | 全部 / 各 workspace_dir（去重列表，显示相对路径或目录名） | `workspace_dir` |
| 时间段（按 last_active_at） | 今天 / 本周 / 本月 / 更早 / 全部 | 日期窗口 |
| 状态 | 运行中 / 等待审批 / 空闲 / 全部 | `state` |

### 4.4 排序（单选，默认「最近活跃」）

- 最近活跃：`last_active_at` 降序（覆盖无 session 的 Agent，用 `created_at` 兜底）
- 最新创建：`created_at` 降序
- 消息最多：`session.message_count` 降序（无 session 视为 0）

### 4.5 状态

`agentsStore` 新增 `filters: { query, workspaces: string[], timeRange, states, sort }`，`getVisibleAgents()` 为派生选择器（过滤 + 排序 + 分组），组件用 zustand selector 订阅，避免整墙重渲染。

---

## 5. 方案 B：按工作区（workspace_dir）分组

### 5.1 视图模式

`agentsStore` 新增 `viewMode: 'free' | 'grouped'`（localStorage 持久化）：

- **free（默认，现状）**：保持现有自由网格磁贴墙，不做任何改动。
- **grouped**：磁贴按 `workspace_dir` 分组成「工作区面板」，整个墙改为纵向滚动流；顶部加**工作区切换 tab**（全部 / 工作区A / 工作区B…）。

### 5.2 grouped 视图的布局

- 顶部一排 tab = 工作区列表（含「全部」），点击只显示该工作区的组。
- 每个工作区一个「组」：`<section>` 组头（文件夹名 + 活跃数/总数 + 折叠箭头），组内磁贴用**同尺寸小磁贴网格**（复用 `TileShell` 但强制统一尺寸，如 220×160），不使用自由 tiles 坐标。
- 折叠态持久化：`collapsedWorkspaces: string[]` 存 localStorage。
- 无 workspace_dir 的归入「未分类」组，排最后。

### 5.3 与现有 tiles 的关系

- grouped 视图是**展示视图**，不写回 `tiles`（`updateTilePosition` 只在 free 视图拖拽时触发），避免两套几何数据互相打架。
- 从 grouped 视图双击打开 Agent 的行为不变（`openAgentIds` 逻辑原样）。

### 5.4 分组内排序

复用 4.4 的排序选择，组内同样按该排序排列。

---

## 6. 方案 D：活跃 / 归档两层制

### 6.1 状态定义

- **Active（墙内）**：满足任一 → 手动钉住（pinned）｜ `last_active_at` 距今 ≤ 活跃阈值（默认 14 天）。
- **Archived（归档库）**：其余全部。归档是**显示层状态**，不删除 Agent、不动其后端会话。

### 6.2 数据

`agentsStore` 新增：

```ts
pinnedIds: string[]      // 手动钉住，永远在墙内
archivedIds: string[]    // 手动归档，强制出墙（显式操作优先于时间规则）
archiveDays: number      // 自动归档阈值，默认 14，0 = 关闭自动归档
```

三者均持久化 localStorage。规则优先级：`pinnedIds` &gt; 手动 `archivedIds` &gt; 自动归档（把 `last_active_at` 超阈值且未 pinned 的 Agent 在**派生层**视为 archived，不写死 archivedIds，保证「最近活跃」能自动回墙）。

### 6.3 交互

- **磁贴右键菜单**（`ContextMenu.tsx` 已有）新增两项：`钉住 / 取消钉住`、`移至归档`；归档库面板内每行有 `恢复/取消归档`。
- 归档 Agent 被 SSE 事件带活跃（新消息）时，**自动解除自动归档回墙**（手动归档的仍不动，除非用户手动恢复）。

### 6.4 归档库入口

- 控制条新增「归档库」按钮，打开 `ArchivePanel.tsx`（侧边滑出面板，列表视图：name / workspace / 最后活跃时间 / 消息数）。
- 归档库自带搜索（复用 A 的 query 匹配）与「全部恢复」按钮。
- 墙底横幅提示：「另有 N 个归档会话，点此查看」——防止用户以为会话丢了。

### 6.5 自动归档

- 在 Agent 列表加载、SSE 活跃事件时惰性计算，不做定时器。
- 阈值可在 `SettingsDialog.tsx` 中配置（14 / 30 / 60 天 / 关闭）。

---

## 7. 组件与文件改动清单

| 文件 | 改动 |
| --- | --- |
| `desktop/src/state/agentsStore.ts` | 新增 `filters`、`viewMode`、`pinnedIds`、`archivedIds`、`archiveDays`、`collapsedWorkspaces`、`getVisibleAgents()`、localStorage 存取；持久化 key 统一前缀 `momoka:tiles:mgmt-v1` 之类 |
| `desktop/src/components/ControlBar.tsx` | 新增「搜索/筛选」「归档库」「视图切换(free/grouped)」按钮 |
| `desktop/src/components/AgentFilterBar.tsx`（新） | 搜索框 + chips + 排序下拉 |
| `desktop/src/components/ArchivePanel.tsx`（新） | 归档库侧边面板 |
| `desktop/src/components/Desktop.tsx` | 根据 `viewMode` 与 `getVisibleAgents()` 分支渲染：free 墙 / grouped 分组流 / 空态 |
| `desktop/src/components/AgentTile.tsx` | 命中高亮、钉住角标、归档态置灰、右键菜单项 |
| `desktop/src/components/ContextMenu.tsx` | 钉住 / 归档菜单项 |
| `desktop/src/components/SettingsDialog.tsx` | 归档阈值配置项 |
| `desktop/src/App.tsx` | 挂载新面板、顶栏结构 |

**不改**：`tiles` 几何逻辑、后端 API、Agent 类型字段（除非后续需要全文搜索再议）。

---

## 8. 实施步骤（建议顺序）

1. **Phase 1 — A 搜索/筛选/排序（独立可用，收益最快）**
   - `filters` + `getVisibleAgents()` + `AgentFilterBar`，ControlBar 入口。
   - 验收：100 个 mock Agent 下，输入关键字/选工作区/排序均即时生效，墙只显示命中项。
2. **Phase 2 — D 归档两层制**
   - `pinnedIds` / `archivedIds` / 自动归档派生 + 右键菜单 + `ArchivePanel`。
   - 验收：默认墙只显示 14 天内活跃 + 钉住；归档可恢复；SSE 活跃自动回墙。
3. **Phase 3 — B 分组视图**
   - `viewMode: 'grouped'` + 工作区 tab + 折叠组头 + 组内排序。
   - 验收：grouped/free 切换不丢 tiles 坐标；两个视图行为一致。

每阶段独立可交付、可回滚；A 单独完成即可缓解大半「泛滥」。

---

## 8.5 已实装：拖拽成组 + 组带（Band）布局（2026-09-01）

### 组带模型（打破全局网格）
- **两层结构**：`lib/bandLayout.ts` 输出 Band 序列（`x` 起始坐标累加、组间 **120px** 间隔）+ 组内局部网格（`col/row` 仅带内有效）。
- **未分组 session = 最后一个「未分组」组**（永远排最后）；browser/widget 并入最右「系统」带（不参与成组/排斥）。
- 网格只是组内资产：`displaceTiles` / `resolveOverlaps` / 量化 / resize 全部在**带内局部 map** 运行，不跨组污染。
- 渲染 = `band.x + 局部网格`（`gridToPixels` 增加 `offsetX`）。

### 交互语义（单计时 hover 状态机，`Desktop.tsx`）
| 拖到目标磁贴/组名（跨带） | 行为 |
| --- | --- |
| <1s 松手 | **成组/移组**（`joinGroup` / `createGroup`；目标为未分组带磁贴 → 回未分组并落目标位置） |
| ≥1s 松手 | **排斥落位**（`repelDropIntoGroup` / `repelDropToUngrouped`：源落入目标位置，目标带内 `resolveOverlaps` 挤开 → **最终无重叠**） |
| 同带/系统带/空白 | 自由拖动照旧（灰框 ghost + 量化 + 让位 + 540ms 缓动） |

视觉：0.5s 蓝亮（成组就绪，`--drop`）→ 1s 橙亮（排斥就绪，`--repel`）。

### 保留项（重构未动）
540ms 缓动、灰框 ghost、量化吸附、resize 量化缩放（clip）、displace 让位、`compactGroupMembers` 首列左推、组名左对齐 Segoe UI Light 双击编辑、Win8 直角、localStorage 持久化、搜索/归档/拼音分组视图。

### 数据迁移（一次性）
- `momoka:tiles:v2` → `compactGrid` 列优先整理 + `saveAllTiles` 写回（标记 `momoka:tiles:compacted-v3`），消除历史重叠（浏览器实测 52 对网格重叠 → 0）。
- `momoka:tiles:groups-v1` 不变（`groupMembers` 本就是带内局部坐标）。
- `tiles` 语义重定义为「未分组带局部坐标」（带内紧凑重排由 `bandLayout` 派生，不依赖归档 agent 的旧 col）。

### 本次删除/清理
`swapPositions`（交换位置）→ 由排斥落位取代；`ghostStore.displaceEnabled` 开关、TileShell 指针自检抑制、Desktop 全局 baseCol `groupLayout` / 全局 `freeGridMap`、`sameGroupHover` 特判、`onDragCursor` 回调 —— 全部移除，由 band 归属判定自然覆盖。

---

## 9. 不做的事（边界）

- ❌ 不做后端分页/`?page=` 改造（本地过滤足够，Agent 总量千级以内）。
- ❌ 不做自动「整理/合并」会话（删改用户数据需另行决策）。
- ❌ 不做 C 分页磁贴网格（用户已选择组合 ABD；如后续需要，Phase 2 的「墙内上限」可自然过渡到分页）。
- ❌ 不迁移旧网页端 index.html（本次范围仅桌面端；如需要可另开任务）。