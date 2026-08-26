import { create } from "zustand";

const STORAGE_KEY = "momoka:wallpaper:v1";

/**
 * 桌面壁纸：
 * - mode "default"  →  使用 CSS 渐变（fallback，无数据）
 * - mode "image"    →  用 data URL 作为 background-image（本地图片，经 FileReader 转 base64）
 * - 图片以 data URL 整体存到 localStorage；用户切走/关闭后恢复
 */
export type WallpaperMode = "default" | "image";

export interface WallpaperState {
  mode: WallpaperMode;
  imageDataUrl: string | null;
  setDefault: () => void;
  setImage: (dataUrl: string) => void;
}

function loadFromStorage(): Pick<WallpaperState, "mode" | "imageDataUrl"> {
  if (typeof localStorage === "undefined") {
    return { mode: "default", imageDataUrl: null };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "default", imageDataUrl: null };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode = parsed.mode === "image" ? "image" : "default";
    const imageDataUrl = typeof parsed.imageDataUrl === "string" ? parsed.imageDataUrl : null;
    return { mode, imageDataUrl };
  } catch {
    return { mode: "default", imageDataUrl: null };
  }
}

function saveToStorage(state: Pick<WallpaperState, "mode" | "imageDataUrl">): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 配额满（base64 图片可能上 MB）：静默失败，用户回到默认渐变
  }
}

export const useWallpaperStore = create<WallpaperState>((set) => ({
  ...loadFromStorage(),
  setDefault: () => {
    set({ mode: "default", imageDataUrl: null });
    saveToStorage({ mode: "default", imageDataUrl: null });
  },
  setImage: (dataUrl) => {
    set({ mode: "image", imageDataUrl: dataUrl });
    saveToStorage({ mode: "image", imageDataUrl: dataUrl });
  },
}));

/** 把当前壁纸应用到 .desktop-shell 元素上；返回清理函数 */
export function applyWallpaperTo(shell: HTMLElement | null): () => void {
  if (!shell) return () => undefined;
  const apply = () => {
    const { mode, imageDataUrl } = useWallpaperStore.getState();
    if (mode === "image" && imageDataUrl) {
      shell.style.backgroundImage = `url("${imageDataUrl}")`;
      shell.style.backgroundSize = "cover";
      shell.style.backgroundPosition = "center";
      shell.style.backgroundRepeat = "no-repeat";
    } else {
      shell.style.backgroundImage = "";
    }
  };
  apply();
  return useWallpaperStore.subscribe(apply);
}
