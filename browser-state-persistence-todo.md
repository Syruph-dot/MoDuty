# 受管浏览器跨会话状态待办

状态：调查完成，关键产品约束已确认；实现方案待讨论。本清单不代表已经开始改代码。

## 已确认现状

- Proma 使用 Electron `persist:` 分区；profile key 优先按 workspace 隔离，同一 workspace 下的不同 Agent 会话共享浏览器站点数据。没有 workspace 的会话按 session 隔离。关闭受管浏览器时关闭视图和运行态，持久分区仍保留站点登录数据。
- Proma 的持久化对象是浏览器存储/profile（例如 Cookie 和站点存储），不等于自动恢复原来的标签页、URL 或窗口布局。
- MoDuty 已有 `persistent` / `incognito` 两种模式。持久 profile 存在 `~/.momoka/browser-profiles/<browser-id>`；关闭实例保留目录，删除实例会删除目录；创建默认是无痕模式。
- MoDuty 浏览器实例注册表目前是 `BrowserService` 内存 Map。ID 每次新建都随机生成，启动时没有从磁盘重建实例清单；桌面 hydrate 会将服务端不存在的浏览器磁贴移除。因此，服务重启后现有持久 profile 可能留在磁盘，但没有恢复该 profile 的实例 ID/磁贴的入口。此问题需要解决：重启后必须能恢复既有浏览器实体及其稳定 ID/profile 绑定。
- 产品约束已确认：浏览器 profile 可以彼此隔离；同一 profile 可由不同 workspace 的会话复用，workspace 归属不能成为访问/复用硬门槛。

## 待办

- [ ] 设计可隔离、可复用的 profile 绑定：不同 profile 的登录态相互隔离；任意 workspace 的会话都可选择并复用 persistent profile；workspace 身份不作访问硬限制。
- [ ] 持久化浏览器实例清单及稳定实例 ID/profile 标识；应用/服务重启后恢复实例列表、磁贴和既有 profile 绑定，不遗失仍在磁盘上的登录态入口。
- [ ] 明确状态恢复范围：恢复 profile 登录态；是否同时恢复打开的 URL、标签和布局另作产品选择，避免把站点凭证与导航状态混为一谈。
- [ ] 补充明确的“关闭浏览器”与“删除并清除登录数据”生命周期；无痕关闭后清理临时数据。
- [ ] 定义并验证验收：同一 persistent profile 在应用/服务重启后以稳定 ID 恢复；不同 workspace 的会话可显式复用该 profile；不同 profile 的登录态互相隔离；无痕关闭后不残留；删除 profile 后不能再恢复该登录态。
- [ ] 确定默认模式和旧数据迁移策略；现有 profile 目录可能保留了有用登录态，迁移不可覆盖或误删。

## 代码锚点

- `src/browser-service.ts`：实例 Map、随机 ID、persistent profile 路径、close/delete/launch 生命周期。
- `desktop/src/state/browserStore.ts`：启动 hydrate 与无服务端实例时清理浏览器磁贴。
- `src/tools.ts`：Agent 创建浏览器的默认模式为 incognito。
- Proma 参考：`.proma/references/Proma/apps/electron/src/main/lib/browser-profile-policy.ts`、`browser-controller.ts`。
