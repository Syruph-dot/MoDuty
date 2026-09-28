# 受管浏览器跨会话状态现状与待办

状态：实例清单持久化、重启恢复与「关闭 / 删除」生命周期已实现；本文件记录已确认的产品约束、代码锚点与仍然开放的问题。

## 已确认的产品约束

- 浏览器 `persistent` / `incognito` 两种模式。持久 profile 存在 `<profileRoot>/<browser-id>`，`profileRoot` 默认 `~/.momoka/browser-profiles`，可用 `MOMOKA_BROWSER_PROFILE_ROOT` 覆盖。
- **创建默认是持久化模式**（2026-09-28 拍板）：无痕只能由调用方显式指定 `mode=incognito`。Agent 工具描述、服务端默认值与桌面创建入口保持一致。
- 关闭与删除是两件事：关闭保留 profile（登录态留着），删除实例同时清除该 profile 的登录数据。桌面右键菜单按这两种语义分别命名。
- profile 之间登录态相互隔离；同一 profile 可被不同 workspace 的会话显式复用，workspace 归属不作为访问硬门槛。
- 持久化对象是 profile（Cookie、站点存储等），**不等于**自动恢复已打开的 URL、标签或窗口布局。

## 已实现（代码锚点）

- 实例清单：`src/browser-service.ts` 的 `instances.json`（创建/删除持久化实例时原子写入；`persistRegistry`）。
- 重启恢复：`BrowserService` 构造时 `restorePersistentInstances()` 按注册表恢复实例（校验 ID 形状、目录存在且非符号链接），并把旧版本遗留的 profile 目录按目录名恢复成实例；桌面磁贴随 `/api/browsers` 的实例列表重建。
- 生命周期：`closeInstance`（保留 profile，补发 `browser_state` 事件）与 `deleteInstance`（删除 profile 目录，失败不再静默吞掉）。
- 默认模式与描述：`src/browser-service.ts`、`desktop/src/state/browserStore.ts`、`src/tools.ts` 的 `browse_create` 描述。
- 桌面入口：`desktop/src/components/Desktop.tsx` 右键菜单的「关闭浏览器（保留登录态）」/「删除浏览器并清除登录数据」。

## 待办

- [ ] 是否恢复导航状态（URL、标签、布局）另作产品选择；当前只恢复实例与 profile 绑定，避免把站点凭证与导航状态混为一谈。
- [ ] 恢复出来的旧实例统一命名为「浏览器」，无法还原用户起过的名字；是否把名字写进 `instances.json` 之外的元数据，待定。
- [ ] 旧数据迁移策略：现有 profile 目录会被按目录名恢复，但没有任何版本/归属标记；需要在真实数据上确认不会误恢复无关目录。
- [ ] 无痕实例关闭后的临时数据清理需要一次实测确认。
- [ ] 验收：同一 persistent profile 在应用/服务重启后以稳定 ID 恢复；不同 workspace 的会话可显式复用该 profile；不同 profile 的登录态互相隔离；删除后不能再恢复该登录态。

## 代码锚点

- `src/browser-service.ts`：实例 Map、持久 profile 路径、`close/delete/launch` 生命周期。
- `desktop/src/state/browserStore.ts`：启动 hydrate 与无服务端实例时的磁贴清理。
- Proma 参考：`.proma/references/Proma/apps/electron/src/main/lib/browser-profile-policy.ts`、`browser-controller.ts`。
