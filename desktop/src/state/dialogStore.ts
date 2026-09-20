import { create } from "zustand";

/** 通用确认弹窗配置 */
export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
}

interface DialogStore {
  /** 新建 Agent 弹窗是否打开 */
  newAgentOpen: boolean;
  /** 打开新建弹窗时光标相对磁贴墙的坐标（用于新磁贴落位） */
  newAgentSpawn: { x: number; y: number } | null;
  /** 可选：新建 Agent 时直接指定归属组（右键菜单按鼠标位置推断 / 组名 + 号点击） */
  newAgentGroupId: string | null;
  openNewAgent: (spawn?: { x: number; y: number }, groupId?: string) => void;
  closeNewAgent: () => void;
  /** 内联重命名目标 Agent id（null 表示未在重命名；由 TileShell 右键菜单触发，AgentTile 就地编辑） */
  renameTarget: string | null;
  openRename: (id: string) => void;
  closeRename: () => void;
  /** 通用确认弹窗（如删除 Agent 前的二次确认） */
  confirm: ConfirmOptions | null;
  openConfirm: (opts: ConfirmOptions) => void;
  closeConfirm: () => void;
  /** 壁纸选择弹窗是否打开 */
  wallpaperOpen: boolean;
  openWallpaper: () => void;
  closeWallpaper: () => void;
  /** 设置弹窗是否打开 */
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  /** 值日生页（值日生窗口：整页调度视图）是否打开 */
  dutyOpen: boolean;
  openDuty: () => void;
  closeDuty: () => void;
  /** 记忆面板（整页检视/纠正视图）是否打开 */
  memoryOpen: boolean;
  openMemory: () => void;
  closeMemory: () => void;
  /** 「Add widget」通用选择器卡片是否打开（非前景、非阻挡式） */
  widgetPickerOpen: boolean;
  /** 打开选择器时记录的光标相对磁贴墙坐标（选完落位用） */
  widgetPickerSpawn: { x: number; y: number } | null;
  openWidgetPicker: (spawn?: { x: number; y: number }) => void;
  closeWidgetPicker: () => void;
  /** 重命名 widget 弹窗目标 id（null 表示未打开） */
  renameWidgetTarget: string | null;
  openRenameWidget: (id: string) => void;
  closeRenameWidget: () => void;
}

/** 顶层弹窗开关：右键菜单触发 → 任何地方都能监听 */
export const useDialogStore = create<DialogStore>((set) => ({
  newAgentOpen: false,
  newAgentSpawn: null,
  newAgentGroupId: null,
  openNewAgent: (spawn, groupId) => set({ newAgentOpen: true, newAgentSpawn: spawn ?? null, newAgentGroupId: groupId ?? null }),
  closeNewAgent: () => set({ newAgentOpen: false, newAgentSpawn: null, newAgentGroupId: null }),
  renameTarget: null,
  openRename: (id) => set({ renameTarget: id }),
  closeRename: () => set({ renameTarget: null }),
  confirm: null,
  openConfirm: (opts) => set({ confirm: opts }),
  closeConfirm: () => set({ confirm: null }),
  wallpaperOpen: false,
  openWallpaper: () => set({ wallpaperOpen: true }),
  closeWallpaper: () => set({ wallpaperOpen: false }),
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  dutyOpen: false,
  openDuty: () => set({ dutyOpen: true }),
  closeDuty: () => set({ dutyOpen: false }),
  memoryOpen: false,
  openMemory: () => set({ memoryOpen: true }),
  closeMemory: () => set({ memoryOpen: false }),
  widgetPickerOpen: false,
  widgetPickerSpawn: null,
  openWidgetPicker: (spawn) => set({ widgetPickerOpen: true, widgetPickerSpawn: spawn ?? null }),
  closeWidgetPicker: () => set({ widgetPickerOpen: false, widgetPickerSpawn: null }),
  renameWidgetTarget: null,
  openRenameWidget: (id) => set({ renameWidgetTarget: id }),
  closeRenameWidget: () => set({ renameWidgetTarget: null }),
}));
