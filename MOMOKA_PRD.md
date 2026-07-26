---
type: project
status: idea
created: 2026-05-29
author: Syr
tags:
  - human-computer-interaction
  - agent-design
  - feedback-loop
  - soft-logic-gating
  - zero-text-input
---

# MOMOKA：批注式判断交互协议 — 产品需求文档

## 1. 项目概述

### 1.1 愿景

MOMOKA 是一个实验性的人机交互设计项目，旨在重新定义人类与 AI Agent 之间的沟通范式。其核心愿景是：**用户无需主动输入，计算机主动认识世界**。

在传统交互模式中，用户通过自然语言向 AI 描述意图（"写一封邮件"、"分析这份数据"），AI 执行后返回结果。MOMOKA 颠覆这一模式：用户用自然语言开启一个会话主题，AI围绕这个会话主题， 自主观察、猜测用户需求并输出内容，用户仅需通过极低成本的"批注式判断"来反馈认可度，从而驱动 AI 持续学习与调整。
需要仿造 OpenClaw 以及其它开源项目，让这个 Agent 具有跨会话记忆、自我迭代进化的设计。

### 1.2 设计哲学

- **极致懒人模式**：交互成本降至最低，用户无需打字、无需结构化指令
- **主动认知**：AI 从被动执行者转变为主动探索者，自主构建对用户需求的理解
- **渐进式对齐**：通过持续的低成本反馈，模型逐步与用户偏好深度对齐
- **猜测即学习**：每一次猜测都是一次学习机会，正确或错误的猜测都贡献于用户模型的完善

---

## 2. 核心创新点

### 2.1 零文本输入交互

传统 LLM Agent 依赖用户以自然语言下达指令。MOMOKA 将用户的角色从"指令者"转变为"评判者"：

- AI 自主决定下一步做什么（基于用户历史偏好 + 当前上下文）
- AI 生成输出（建议、分析、创作、操作等）
- 用户仅需用 7 级认可度进行批注
- 交互门槛从"会表达"降为"会判断"

### 2.2 7 级批注式判断（Likert 7-Point Scale）

用户与系统的核心交互单元是一个 Likert 7 点量表的批注意见：

| 级别 | 标签 | 含义 |
|------|------|------|
| 1 | 强烈反对 | 完全偏离用户意图或价值观 |
| 2 | 反对 | 不认可，有明显问题 |
| 3 | 不太赞同 | 方向略有偏差，接近但不够好 |
| 4 | 中立 | 不确定 / 可接受但无亮点 |
| 5 | 有点赞同 | 方向正确，有改进空间 |
| 6 | 赞同 | 符合预期，可接受 |
| 7 | 强烈赞同 | 超出预期，完美匹配 |

这一设计需要注意，用户的批注大概率是不覆盖整个输出文段的。用户对某文段有所批注，意义实际上为，用户对这一块地方有所触动，有自己的想法，而对于AI的这里的输出，持赞同/平行/反对态度。就算用户给出的是4，也说明用户有其它的不冲突同时不直接赞同的想法，需要AI去发散想出来

### 2.3 主动猜测-学习循环

MOMOKA 的操作流程构成一个持续的学习闭环：

```
[AI 自主输出] → [用户 7 级批注] → [AI 学习调整] → [AI 自主输出] → ...
```

与传统 Agent 的单次指令-响应模式不同，MOMOKA 的交互是**持续的、累积的**。每一次批注都在更新用户偏好模型，每一次输出都在利用累积的偏好信息。
AI要通过一系列的评分反馈，去分析用户的思维方式、决策特点，力求猜到用户的思考。

---

## 3. 技术架构

### 3.1 核心设计原则：Markdown 即 DNA

MOMOKA 遵循 2025-2026 年开源 Agent 社区达成的一项关键共识：**Agent 的所有持久状态、技能、记忆与进化规则，均应外置为 Markdown 文件**。这一选择带来四项根本优势：

| 原则 | 含义 |
|------|------|
| **完全透明** | 任何 `.md` 文件可用文本编辑器直接查看与修改，不存在黑盒向量数据库 |
| **Git 原生** | 每一次进化都是一次可审计、可回滚的 commit；`git revert` 即可撤销任何一次"学坏了"的更新 |
| **人机共读** | 同一份文件既被 LLM 解析执行，也可被人类阅读审计——消除"模型脑子里在想什么"的不透明性 |
| **零参数更新** | 所有学习通过文件系统的读写完成，模型权重保持冻结——部署后可持续进化而无 GPU 成本 |

这一范式被 OpenClaw、Memento-Skills、EvoForge、A-Evolve、AceForge、Agent Taxonomy、IRAF 等项目独立验证，已成为**继预训练和微调之后的第三条 AI 适应路径：部署时学习（Deployment-Time Learning）**。

### 3.2 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                     MOMOKA Agent Core                     │
│  ┌───────────┐  ┌──────────┐  ┌────────────────────┐   │
│  │ 猜测引擎  │  │ 判断解析 │  │ 技能路由器         │   │
│  │ (Guess)   │  │ (Judge)  │  │ (Skill Router)     │   │
│  └─────┬─────┘  └────┬─────┘  └─────────┬──────────┘   │
│        │             │                  │               │
│        └─────────────┼──────────────────┘               │
│                      ▼                                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │              TypeScript MomokaAgent Core          │   │
│  │  Runner.run(agent, tools, system_prompt)          │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              外部化 Markdown 知识库（文件系统）           │
│                                                          │
│  agents/           skills/          memory/              │
│  ├─ AGENTS.md      ├─ file_ops/     ├─ MEMORY.md         │
│  ├─ SOUL.md        │  └─ SKILL.md   ├─ 2026-05-29.md     │
│  ├─ USER.md        ├─ summarizer/   ├─ .dreams/          │
│  ├─ GOALS.md       │  └─ SKILL.md   │  ├─ short-term.json│
│  └─ GENOME.md      ├─ ...           │  └─ long-term/     │
│                    └─ index.json    └─ .evolog/          │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.3 Markdown 文件体系设计

借鉴 OpenClaw 的 7 文件体系、Agent Taxonomy 的 GENOME.md、IRAF 的 agents.md/skills.md/clauses.md 三蓝图架构，MOMOKA 定义以下核心文件：

#### 3.3.1 身份与行为层（每次会话加载）

| 文件 | 用途 | 加载时机 |
|------|------|---------|
| `agents/AGENTS.md` | 行为契约：角色边界、安全红线、协作规则、权限范围、降级策略 | 每次会话，最高优先级 |
| `agents/SOUL.md` | 人格内核：价值观权重向量、情绪响应阈值、认知偏差检查清单、沟通风格 | 每次会话 |
| `agents/USER.md` | 用户模型（三层）：L1 显式声明（用户自述偏好）、L2 隐式推断（从批注历史挖掘）、L3 关系映射（跨领域偏好关联） | 每次会话 |
| `agents/GOALS.md` | 目标树：当前活跃目标、优先级、完成条件、子目标依赖关系 | 每次会话 |
| `agents/GENOME.md` | 进化基因：当前版本号、已获取的技能基因列表、继承链、适应度指标 | 每次会话 |

#### 3.3.2 技能层（按需检索加载）

| 路径 | 用途 |
|------|------|
| `skills/{skill_name}/SKILL.md` | 单个技能的行为声明、多步工作流、前置条件、后置条件、辅助脚本引用 |
| `skills/index.json` | 技能索引：名称、描述、触发条件、效用分数、最后更新时间 |

每个 `SKILL.md` 采用统一的结构化模板：

```markdown
---
name: file-summarizer
version: 1.2.0
utility_score: 0.87
trigger_keywords: [总结, 概括, 摘要, summarize]
prerequisites: [file_reader]
created: 2026-05-29
evolved_from: []
---

# 文件总结技能

## 行为声明
读取文本文件并生成结构化摘要。

## 工作流
1. 调用 file_reader 读取目标文件
2. 识别文档类型（技术文档/散文/日志/代码）
3. 按类型选择摘要模板
4. 生成摘要（不超过原文 20% 长度）
5. 标注关键信息点

## 失败处理
- 若文件过大（>50KB）：分段读取，逐段摘要后合并
- 若文件非文本：报告无法处理，建议转换工具
```

#### 3.3.3 记忆层（静态注入层 vs 批注账本层）

| 路径 | 用途 | 加载策略 |
|------|------|---------|
| `memory/MEMORY.md` | 长期记忆：已验证的事实、决策记录、持久学习 | 作为 system prompt 的静态记忆源 |
| `memory/YYYY-MM-DD.md` | 日记忆：当天观察、临时笔记、交互日志 | 当天 + 昨天过滤后注入 system prompt |
| `memory/.annotations/ledger.json` | 批注账本：用户评分、选区、文字批注、技能关联证据 | 不直接进 system prompt；运行时按相关性择取 |
| `memory/.outputs/outputs.json` | 输出台账：每次 Agent 输出的 prompt/response/tool calls | 为批注账本与续猜链路提供可追溯上下文 |
| `memory/.dreams/short-term-recall.json` | 兼容镜像：旧路径读者仍可读取同一批注记录 | 仅兼容写入，不再作为主组织层 |
| `memory/.dreams/long-term/` | 长期记忆候选池：待晋升的记忆片段 | Dreaming 流程消费 |

### 3.4 自我进化闭环：Read → Guess → Judge → Reflect → Write

MOMOKA 的进化机制融合了 Memento-Skills 的 **Read-Write-Reflect** 循环与 OpenClaw 的 **Dreaming 三阶段巩固**系统，形成五阶段闭环：

```
┌──────────────────────────────────────────────────────┐
│                   MOMOKA 进化闭环                       │
│                                                        │
│   ┌─────────┐    ┌─────────┐    ┌──────────┐          │
│   │  READ   │───▶│  GUESS  │───▶│  JUDGE   │          │
│   │ 检索技能 │    │ 自主输出 │    │ 接收批注  │          │
│   └─────────┘    └─────────┘    └────┬─────┘          │
│        ▲                             │                │
│        │              ┌──────────────┘                │
│        │              ▼                               │
│   ┌─────────┐    ┌──────────┐                        │
│   │  WRITE  │◀───│ REFLECT  │                        │
│   │ 更新文件 │    │ 反思失败  │                        │
│   └─────────┘    └──────────┘                        │
│                                                        │
└──────────────────────────────────────────────────────┘
```

#### 阶段 1: READ — 技能检索
- 技能路由器根据当前上下文 + 用户批注历史，从 `skills/` 目录检索最相关技能
- 同时加载 `memory/MEMORY.md` 中与当前话题相关的长期记忆
- 路由策略：语义相似度 + 用户偏好权重 + 时间衰减因子的混合打分

#### 阶段 2: GUESS — 主动猜测输出
- Agent 不等待用户指令，基于当前加载的技能和记忆自主生成输出
- 输出包含：建议、分析、操作或追问
- 每个输出标记置信度（用于后续反思阶段的信用分配）

#### 阶段 3: JUDGE — 接收用户批注
- 用户通过 Likert 7 点量表对输出进行批注
- 批注可覆盖输出的部分文段或整体
- 批注被记录为结构化信号：`{位置, 级别, 时间戳, 上下文}`

#### 阶段 4: REFLECT — 反思分析
- 将批注信号与输出对应，分析：
  - 哪些猜测方向被证实有效（6-7 分）→ 强化
  - 哪些方向被否定（1-2 分）→ 修正或废弃
  - 哪些方向用户补充了其他想法（4 分）→ 需要发散探索
- 反思结果写入 `memory/YYYY-MM-DD.md` 作为日记忆

#### 阶段 5: WRITE — 文件进化
根据反思结果，触发三种写入操作：

| 操作 | 触发条件 | 效果 |
|------|----------|------|
| **Skill Rewrite** | 单个技能多次获得低分 | 针对性修订 SKILL.md：添加 guardrail、替代策略 |
| **Skill Discovery** | 用户需求落入未知领域 | 从成功交互中提取新模式，生成新 SKILL.md |
| **Gene Upgrade** | 技能组合表现持续优异 | 更新 GENOME.md 中的适应度指标和继承链 |

### 3.5 跨会话记忆与 Dreaming 系统

借鉴 OpenClaw 的三阶段 Dreaming 架构（Light Sleep → REM Sleep → Deep Sleep），MOMOKA 在用户空闲时自动运行记忆巩固流程：

#### Light Sleep（浅睡眠）— 摄取与去重
- **不调用 LLM**，纯文本处理
- 从日记忆文件、批注记录中搜集候选记忆片段
- Jaccard 相似度去重（阈值 0.9）
- 为每个候选记录首次出现时间和出现次数

#### REM Sleep（快速眼动睡眠）— 模式识别
- 对所有候选信号做跨日模式分析
- 识别反复出现的主题（"用户连续三天关注代码重构"）
- 计算主题强度：`strength = min(1, (count / totalEntries) × 2)`
- 生成叙事性"梦境日记"（仅供人类审查，不自动注入上下文）

#### Deep Sleep（深度睡眠）— 六维评分与记忆晋升
决定一条记忆能否晋升为长期记忆（写入 `memory/MEMORY.md`）：

| 信号 | 权重 | 含义 |
|------|------|------|
| 频率 (Frequency) | 0.24 | 被回忆的总次数 |
| 相关性 (Relevance) | 0.30 | 每次检索时的平均质量分 |
| 多样性 (Diversity) | 0.15 | 不同查询/日期上下文的覆盖宽度 |
| 时效性 (Recency) | 0.15 | 指数衰减，半衰期 14 天 |
| 巩固度 (Consolidation) | 0.10 | 多日重现信号强度 |
| 概念丰富度 (Conceptual) | 0.06 | 概念标签密度 |

**晋升门控**（三项必须同时满足）：
- `score ≥ 0.80`
- `totalSignalCount ≥ 3`
- `max(uniqueQueries, recallDays.length) ≥ 3`

### 3.6 技能生命周期管理

借鉴 AceForge 的 12 阶段技能生成管线与 Agent Taxonomy 的 Lamarckian 继承模型：

```
[观察工具使用] → [检测模式] → [生成 SKILL.md 草案]
       │                              │
       ▼                              ▼
  [结晶阈值判定]              [双模型验证管线]
  (触发 3 次 → 候选)          Generator → Reviewer
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                 APPROVE       REVISE       REJECT
                    │             │             │
                    ▼             ▼             ▼
                部署到        返回修改       丢弃草案
               skills/
                    │
                    ▼
              [生命周期状态]
  Proposed → Deployed → Committed → Mature
```

#### Lamarckian 继承链

借鉴 Agent Taxonomy 的"失败→规则→习惯→身份"进化路径：

```
failure → rule → habit → identity
  │         │       │        │
  ▼         ▼       ▼        ▼
单次失败  提炼为   多次验证  固化为
触发反思  SKILL.md  后自动   SOUL.md
         中的规则  触发执行  中的偏好
```

关键洞察：**获取性特征（通过交互学到的技能）可以直接继承，无需达尔文式的代际选择周期**。这意味着用户教会 Agent 的一个技能，可以立即跨会话复用，而不需要等待"进化选择"。

### 3.7 Git-Native 进化治理

参考 IRAF 和 A-Evolve 的 Git 原生架构：

```
每一次文件变更 = 一次 Git commit
commit message 格式: "evo: {操作类型} {目标文件} — {变更摘要}"

示例:
  evo: skill-rewrite skills/file_summarizer/SKILL.md — 增加大文件分段策略
  evo: memory-promote memory/MEMORY.md — 晋升用户偏好"简洁回复风格"
  evo: gene-upgrade agents/GENOME.md — 适应度 v1.3.2 → v1.3.3
```

**安全机制**：
- 每次 skill rewrite 前自动 `git stash`（Lifeline 机制，借鉴 GBase）
- `git revert` 可撤销任何一次"学坏了"的进化
- `clauses.md`（IRAF 式治理宪章）定义最小通过分数和禁止操作清单

### 3.8 开源项目策略对照

下表中总结了可用于 MOMOKA 各项需求的开源策略来源：

| MOMOKA 需求 | 采用策略 | 来源项目 |
|------------|---------|---------|
| 技能外置化 | SKILL.md 结构化技能文件 | Memento-Skills, AceForge |
| 技能检索 | 混合打分路由器（语义 + 偏好 + 时间） | Memento-Skills (InfoNCE Router) |
| 跨会话记忆 | 三层存储 + Dreaming 巩固 + 六维晋升 | OpenClaw |
| 自我进化 | Read-Guess-Judge-Reflect-Write 五阶段闭环 | Memento-Skills + OpenClaw |
| 身份持久化 | SOUL.md + GENOME.md 双文件体系 | OpenClaw + Agent Taxonomy |
| 进化安全 | Git stash + revert + clauses.md 治理宪章 | IRAF + GBase (Lifeline) |
| 技能生成 | 双模型验证管线 (Generator + Reviewer) | AceForge |
| Lamarckian 继承 | failure → rule → habit → identity 进化链 | Agent Taxonomy |
| 空闲时训练 | Light → REM → Deep Sleep 三阶段巩固 | OpenClaw (Dreaming) |
| 质量保障 | Quality Gates 多臂审查 + Unit-Test Gate | GBase + Memento-Skills |

---

## 4. 实施路径

### 4.1 第一阶段：文件助手 Agent（当前作业）

本次作业是 MOMOKA 的最小可行实现（MVP），聚焦于验证核心技术栈：

**目标**：使用 TypeScript 构建一个具备基本工具调用能力、可被外部软件直接调用的文件助手 Agent。

**实现范围**：
- 内置工具：时间工具、文件读取、文件写入、文件列表、文件追加
- System prompt：定义 Agent 的角色与行为边界（`agents/AGENTS.md` 的雏形）
- 工具调用日志：完整记录每步 tool call 及其结果
- 外部化配置：Agent 的 system prompt 从外部 `.md` 文件加载（而非硬编码）

**技术栈**：
- Python 3.11+
- TypeScript / Node.js
- 本地文件系统工具

**交付物**：
1. 可运行的 `src/server.ts` 与可导入的 `createMomokaAgent()`
2. `agents/AGENTS.md` — 文件助手的 system prompt
3. 一次完整的运行记录（含工具调用日志）

### 4.2 第二阶段：批注式判断集成

在第一阶段基础上引入 MOMOKA 的核心交互模式：

- 实现 Likert 7 点评分的结构化解析
- Agent 输出后等待用户批注（非文本回复）
- 批注历史写入 `memory/YYYY-MM-DD.md`
- 初步的偏好推断（从多次批注中识别方向性偏好）

### 4.3 第三阶段：自我进化能力

- 实现五阶段进化闭环（Read → Guess → Judge → Reflect → Write）
- 引入 `skills/` 目录和 SKILL.md 模板
- 实现技能路由器（基于语义相似度的混合检索）
- 引入 Dreaming 系统的 Light Sleep 阶段（摄取与去重）
- Git 自动快照（Lifeline 机制）

### 4.4 第四阶段：完整 MOMOKA

- 完整的七文件 Markdown 体系
- 六维评分的 Deep Sleep 记忆晋升
- Lamarckian 继承链（failure → rule → habit → identity）
- 双模型技能验证管线
- Quality Gates 多臂审查

---

## 附录 A：关键开源项目索引

| 项目 | 仓库 | 核心贡献 |
|------|------|---------|
| OpenClaw | [github.com/VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) | Markdown 七文件体系 + Dreaming 三阶段记忆巩固 |
| Memento-Skills | [github.com/Memento-Teams/Memento-Skills](https://github.com/Memento-Teams/Memento-Skills) | Read-Write-Reflect 闭环 + 技能路由器 + 零参数进化 |
| GBase | [github.com/garyqlin/gbase](https://github.com/garyqlin/gbase) | Mirror Memory + RSI 引擎 + Quality Gates + Lifeline |
| MetaClaw | [github.com/aiming-lab/MetaClaw](https://github.com/aiming-lab/MetaClaw) | 双回路进化（技能快回路 + RL 慢回路）+ 机会主义调度 |
| EvoForge | [github.com/haizelabs/EvoForge](https://github.com/haizelabs/EvoForge) | 种群进化 + evolve.md/program.md + 跨代知识传递 |
| A-Evolve | 开源（2026.04） | 五阶段进化循环 + Git 原生可重现性 |
| AceForge | [npm: aceforge](https://www.npmjs.com/package/aceforge) | 12 阶段技能生成管线 + 双模型验证 + 安全审计 |
| Agent Taxonomy | [github.com/suryast/agent-taxonomy](https://github.com/suryast/agent-taxonomy) | GENOME.md + Lamarckian 继承 + 技能即基因 |
| IRAF | [dev.to](https://dev.to/otoniel_rojas_a416bb9a595/the-iterative-refinement-agentic-framework-iraf-a-git-native-architecture-for-autonomous-4nb9) | agents.md/skills.md/clauses.md 三蓝图 + Git 原生 |
| deepseek-auto-evolving-harness | [github.com/liuchen6667/deepseek-auto-evolving-harness](https://github.com/liuchen6667/deepseek-auto-evolving-harness) | self_evolution.md 引导的基准驱动进化 |

## 附录 B：术语表

| 术语 | 定义 |
|------|------|
| **Deployment-Time Learning** | 部署后通过文件系统读写实现的持续学习，区别于预训练和微调 |
| **Markdown 即 DNA** | 将 Agent 的身份、技能、记忆全部外置为 `.md` 文件的设计范式 |
| **批注式判断** | 用户通过 Likert 7 点量表对 AI 输出进行反馈，替代自然语言指令 |
| **Lamarckian 继承** | 通过交互获得的特征（技能/规则）可直接跨会话继承，无需代际选择 |
| **Dreaming** | Agent 在用户空闲时自动运行的记忆巩固流程（Light → REM → Deep Sleep） |
| **Quality Gates** | 多 Agent 审查管线：一个生成，一个审计，第三个裁决 |
| **Lifeline** | 每次修改前自动 `git stash`，确保任何变更可即时回滚 |
| **Crystallization Threshold** | 技能从"偶然行为"晋升为"正式技能"所需的最小触发次数 |
| **Skill Router** | 根据当前上下文从技能库中检索最相关技能的路由模块 |
| **GENOME.md** | 记录 Agent 进化基因的文件：版本号、技能基因列表、继承链、适应度指标 |
