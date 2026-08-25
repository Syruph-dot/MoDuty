import { create } from "zustand";

import type { SnapGuide } from "../lib/snapController";

interface SnapGuideStore {
  /** 当前活跃的对齐辅助线（拖动 / resize 时显示，松手清空） */
  guides: SnapGuide[];
  setGuides: (guides: SnapGuide[]) => void;
  clear: () => void;
}

/** 拖动 / resize 过程中的对齐辅助线全局状态。Desktop 渲染一层覆盖层显示这些线。 */
export const useSnapGuideStore = create<SnapGuideStore>((set) => ({
  guides: [],
  setGuides: (guides) => set({ guides }),
  clear: () => set({ guides: [] }),
}));
