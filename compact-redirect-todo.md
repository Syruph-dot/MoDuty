# Compact 与 Redirect 待办

状态：设计约束已由用户确认；尚未实现。

## 已确认的产品约束

- Compact 与 Redirect 是两个独立功能。Compact 是常规 Agent 上下文压缩，不生成、读取或依赖 Redirect 的 handoff Markdown。
- 用户发送消息后，按该会话当前使用模型的上下文窗口设置估算本次将发送的输入量；达到窗口的 80% 时，在模型处理当前请求前自动 Compact。
- Compact 摘要调用与当前会话使用同一个模型；窗口预算也取该模型对应的设置，不使用 high-tier 默认窗口。
- Compact 后的模型输入只保留 Compact block，以及正常运行必需的系统提示、工具定义和当前用户输入；不再附加 Compact 覆盖范围内或其后的旧原始 Turns。原始 transcript 继续完整保存在会话记录中，供查阅与恢复。
- Redirect 独立使用 Agent 维护的工作目录文件 `.momoka/handoffs/<session-id>.md`。接近阈值后，在完整 Turn 结束时自动提醒 Agent 更新 handoff；该操作不属于 Compact。
- Redirect 按钮只在 handoff 文件存在且有效时启用；不可用时只变暗并禁用，不显示原因。
- 按下 Redirect 后创建并立即打开新会话；系统自动生成首条输入，包含母会话 `&ses_<id>`、handoff 文件相对路径和先读取 handoff 再接续任务的指令。新会话沿用母会话的工作目录；新会话的模型继承策略待定。

## Compact 实施

- [ ] 将 Compact 触发检查接入用户消息发送前的请求预检：估算系统提示、工具定义、已有上下文和当前用户输入的本次输入量；达到当前模型已配置 context window 的 80% 时自动压缩，再发送请求。
- [ ] 统一模型与窗口解析：从当前 Agent/会话的实际模型解析同一模型条目的 context window；Compact 摘要调用明确使用该会话模型。
- [ ] 调整压缩范围和后续提示组装：Compact block 覆盖压缩点之前的全部会话历史；后续正常调用不再追加原始历史 Turns，只追加最新 Compact block、运行必需上下文和当前用户输入。
- [ ] 保留原始 transcript 不变；Compact block 不能替代磁盘上的原始记录，也不能导致原消息被删除或改写。
- [ ] 若压缩后 Compact block、系统提示、工具定义与当前输入仍超过模型预算，停止发送并返回明确的超限状态；不得静默截断当前输入或回退注入旧 Turns。
- [ ] 验收覆盖：阈值低于 80% 不触发、达到 80% 先压缩再调用、恰好跨阈值的当前输入保留、连续 Compact 更新摘要、原 transcript 完整、不同模型使用各自窗口、Compact block 后无旧原始 Turns 注入。

## Redirect 与 handoff 实施

- [ ] 为每个母会话在其工作目录维护 `.momoka/handoffs/<session-id>.md`；文档由 Agent 更新，记录目标、进度、已验证证据、重要决策、产物路径、未完成事项和下一步，并保留母会话链接。
- [ ] Compact 达到 80% 阈值后设置 handoff 待更新状态；当前完整 Turn 结束后，独立提醒 Agent 更新 Markdown。不得将 handoff 文件写入或混入 Compact block。
- [ ] handoff 写入遵守 workspace manifest 的读写边界；写入成功并验证文件有效后才启用 Redirect。
- [ ] handoff 不存在或无效时，Redirect 按钮变暗且不可点击，不显示原因；新 Turn 使 handoff 过期时恢复禁用，待 Agent 更新后重新启用。
- [ ] Redirect 点击操作创建新会话并沿用母会话工作目录；系统自动在首条输入中注入 `&ses_<parent-session-id>`、handoff 文件相对路径和读取指令；创建成功后立即跳转到新会话。
- [ ] 决定 Redirect 新会话的模型选择策略；此决策与 Compact 摘要调用必须使用当前会话模型的要求分开处理。
- [ ] 验收覆盖：hand-off 未就绪时按钮禁用；文件更新成功后启用；点击后新会话链接指向正确母会话并读取正确文件；创建失败不关闭或丢失母会话；不同会话 handoff 文件互不覆盖。
