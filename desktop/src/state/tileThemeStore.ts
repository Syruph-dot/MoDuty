import { create } from "zustand";

const STORAGE_KEY = "momoka:tileTheme:v1";

/**
 * 磁贴字体主题（前端纯配置，localStorage 持久化）：
 * - fontFamily  —— CSS font-family 字符串（空 = 继承默认字体）
 * - fontSourceUrl —— 可选外部字体资源 URL（如 Google Fonts / 自托管 woff2），
 *                    配置后自动向 <head> 注入 <link rel="stylesheet">（"字体样式可引入"）
 * - nameSize / bigSize / metaSize / footerSize —— 磁贴各区域字号（pt），可配置项
 */
export interface TileTheme {
  fontFamily: string;
  fontSourceUrl: string;
  nameSize: number;
  bigSize: number;
  metaSize: number;
  footerSize: number;
}

export const DEFAULT_TILE_THEME: TileTheme = {
  fontFamily: "",
  fontSourceUrl: "",
  nameSize: 22,
  bigSize: 52,
  metaSize: 11,
  footerSize: 11,
};

interface TileThemeState extends TileTheme {
  update: (patch: Partial<TileTheme>) => void;
  reset: () => void;
}

const FONT_LINK_ID = "momoka-font-source";

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function loadTheme(): TileTheme {
  if (typeof localStorage === "undefined") return { ...DEFAULT_TILE_THEME };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TILE_THEME };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      fontFamily: typeof parsed.fontFamily === "string" ? parsed.fontFamily : "",
      fontSourceUrl: typeof parsed.fontSourceUrl === "string" ? parsed.fontSourceUrl : "",
      nameSize: sanitizeNumber(parsed.nameSize, DEFAULT_TILE_THEME.nameSize, 12, 40),
      bigSize: sanitizeNumber(parsed.bigSize, DEFAULT_TILE_THEME.bigSize, 20, 96),
      metaSize: sanitizeNumber(parsed.metaSize, DEFAULT_TILE_THEME.metaSize, 8, 18),
      footerSize: sanitizeNumber(parsed.footerSize, DEFAULT_TILE_THEME.footerSize, 8, 18),
    };
  } catch {
    return { ...DEFAULT_TILE_THEME };
  }
}

function saveTheme(theme: TileTheme): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // 配额满 / 隐私模式：静默失败，配置只在本次会话有效
  }
}

export const useTileThemeStore = create<TileThemeState>((set) => ({
  ...loadTheme(),
  update: (patch) => {
    const next = { ...useTileThemeStore.getState(), ...patch };
    set(patch);
    saveTheme(next);
  },
  reset: () => {
    set({ ...DEFAULT_TILE_THEME });
    saveTheme(DEFAULT_TILE_THEME);
  },
}));

/** 把外部字体资源 <link> 应用到 document.head；字体 URL 变化时自动替换，返回清理函数 */
export function applyFontSourceLink(): () => void {
  const apply = () => {
    const url = useTileThemeStore.getState().fontSourceUrl.trim();
    const existing = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
    if (!url) {
      existing?.remove();
      return;
    }
    if (existing) {
      if (existing.href !== url) {
        existing.href = url;
      }
      return;
    }
    const link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  };
  apply();
  return useTileThemeStore.subscribe(apply);
}