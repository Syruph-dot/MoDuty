# Compact 与 Redirect 现状与待办

状态：Compact（自动压缩）与 Redirect（交接文档）均已实现；本文件记录已确认的产品约束、代码锚点与仍然开放的问题。

## 已确认的产品约束

- Compact 与 Redirect 是两个独立功能。Compact 是常规 Agent 上下文压缩，不生成、读取或依赖 Redirect 的交接文档。
- 用户发送消息后，按该会话当前使用模型的上下文窗口估算本次将发送的输入量；**达到窗口的 80%，或本次估算已经超过该模型的可用输入预算**时，在模型处理当前请求前自动 Compact。（2026-09-28 修正：触发条件与拒绝条件必须同一口径，否则会出现「本该压缩却被直接拒绝」的死区。）
- Compact 摘要调用与当前会话使用同一个模型；窗口预算取该模型对应条目的 context window，不使用 high-tier 默认窗口。会话模型不在已启用模型池中时回退档位默认并留痕，不把配置问题放大成会话卡死。
- Compact 后的模型输入只保留 Compact block，以及正常运行必需的系统提示、工具定义和当前用户输入；不再附加 Compact 覆盖范围内的旧原始 Turns。原始 transcript 完整保留，供查阅与恢复。
- Redirect 只做**提示词工程与信息流通**（2026-09-28 拍板）：系统不生成交接文档，只负责路径约定、可用性判断与首条输入注入；文档写什么、什么时候写，由 Agent 用它本来就有的文件工具完成。
- 交接文档路径约定：工作目录下 `.momoka/handoffs/<session-id>.md`（写入同样受 workspace manifest 边界检查）。
- 本轮输入估算达到当前模型窗口的 **45%** 时，在动态上下文里注入一次「该写/更新交接文档了」的提醒；提醒不改变本轮任务，写不写由 Agent 决定。
- Redirect 按钮只在交接文档**存在且非空**时启用；不可用时变暗禁用，不显示原因，也不判断新旧。
- 按下 Redirect 后创建并立即打开新会话：沿用母会话的工作目录与模型；系统自动生成首条输入，包含母会话 `&ses_<id>`、交接文档相对路径和「先读取再接续」的指令。

## 已实现（代码锚点）

- 自动 Compact 与预算口径：`src/agent.ts` 的 `runChat`（`reachedCompactThreshold`、`compactSessionUnlocked`、`inputLimitFor`），trace 事件 `auto_compact`。
- 压缩范围：`src/compact-handoff.ts` 的 `buildCompactHandoff`（压缩全部完整 turn，`retainedTurnCount` 为 0）。
- 会话模型与窗口解析：`src/agent.ts` 的 `configuredContextWindow(sessionId)`；回退留痕 trace 事件 `model_fallback`。
- 交接文档约定与文案：`src/redirect-handoff.ts`（`redirectRelativePath`、`redirectHandoffStatus`、`buildHandoffReminder`、`buildRedirectContinuationMessage`）。
- 接续接口与按钮：`src/http/agent-routes.ts` 的 `/api/agents/:id/redirect`（GET 状态 / POST 建接续会话）；桌面 `AgentWindow.tsx` 轮询状态并控制按钮。

## 待办

- [ ] 超限兜底：压缩后仍装不下（系统提示 + 工具规格 + 本轮输入本身超出窗口）时返回明确的 413；是否需要自动改用更大窗口的模型，另议。
- [ ] 45% 提醒的文案与时机需要用真实会话观察：既要避免 Agent 每轮都去写文件，也要避免该写的时候没写。
- [ ] 接续会话不继承母会话的历史消息（只通过交接文档接续）；是否需要在首条输入里显式声明这一点，待观察后定。
- [ ] 交接文档不做版本/时效判断，Agent 忘记更新时按钮仍然可用——是保持简单还是加一个轻量提示，待定。
