# MOMOKA 最小 Agent Runtime 收敛设计

## 目标

将项目收敛为可直接阅读的第一、二周 Agent 实现：保留手写模型—工具循环、工具权限与审批、会话、trace、聊天界面和划词反馈；移除与这些目标无关的运行图、技能/偏好学习、演化与回放机制。

## 保留范围

- `model-client.ts`：OpenAI-compatible 模型请求和手写 `for` 工具循环。
- `tools.ts`、`approvals.ts`、`trace.ts`：第一、二周及现有扩展工具的 schema、工作区边界、跨工作区审批、cmd 约束和审计 trace。
- `session-manager.ts`：会话、对话消息和审批结果事件的持久化。
- `feedback.ts` 及其必要的输出/批注存储：划词评分、批注、反馈分析和用户显式请求的 continuation。划词反馈不触发偏好学习或演化提案。
- HTTP 服务、聊天页面、会话页面及审批界面。
- 当前额外工具：`get_current_time`、`append_file`、`run_shell`。

## 删除范围

- LangGraph 依赖、`runtime.ts`、`runtime-context.ts` 及 `MemorySaver`/状态图编排。
- `skill-router.ts` 和所有技能匹配、提示词技能注入、技能 UI 标签。
- `evolution.ts`、`replay.ts`、运行回放与运行图存储。
- 偏好学习、长期记忆、每日记忆、技能反馈提升和演化提案；删除对应 API、类型、测试和前端字段。
- 只为上述能力服务的 casing/配置代码与依赖。

## 新运行路径

```text
POST /api/chat
  → MomokaAgentCore.chat
  → SessionManager 写入用户消息并整理历史
  → modelClient.run（最多四轮工具轮次）
      → executeToolCall
      → tool result 写回同一模型消息数组
  → SessionManager 写入最终 agent 消息
  → trace 写入 final_answer
  → HTTP 返回 response 与 tool_calls

POST /api/judge
  → MomokaAgentCore.judge
  → 保存评分/批注
  → feedback.ts 生成反馈分析
  → 仅当 continue=true 时重新调用 modelClient.run
```

审批路径保持独立：跨工作区工具先创建审批记录；批准后执行保存调用一次，并将结果事件写入原会话，不自动调用模型。

## 数据与兼容性

- 现有会话文件继续使用；历史中无法识别的技能、偏好、演化字段读取时忽略。
- `pending_approvals.json`、会话消息、trace 格式继续兼容；新的轻量运行时不依赖旧 run-store。
- `/api/chat`、`/api/judge`、会话和审批 API 保持现有字段；删除的仅是技能、偏好、演化、replay 专用端点/字段。

## 验收

- `npm test`、`npx tsc --noEmit`、`npm run build` 与 `npm audit --omit=dev --audit-level=high` 通过。
- 普通工具调用仍能“工具结果回填 → LLM 总结”。
- 跨工作区读/列/写/追加/命令仍须审批；批准后结果在会话中可见，且不自动调用模型。
- 划词评分和批注仍能保存并显示；评分不再改变偏好、生成演化提案或注入技能。
- `@langchain/langgraph` 不再出现在依赖或源码中。
