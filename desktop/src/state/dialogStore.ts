import { create } from "zustand";

interface DialogStore {
  /** 新建 Agent 弹窗是否打开 */
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
}

/** 顶层弹窗开关：右键菜单触发 → 任何地方都能监听 */
export const useDialogStore = create<DialogStore>((set) => ({
  newAgentOpen: false,
  openNewAgent: () => set({ newAgentOpen: true }),
  closeNewAgent: () => set({ newAgentOpen: false }),
}));
