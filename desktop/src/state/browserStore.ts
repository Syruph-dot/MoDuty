import { create } from "zustand";

import { createBrowser as apiCreateBrowser, deleteBrowser as apiDeleteBrowser, listBrowsers } from "../lib/api";
import { spawnXToCol } from "../lib/persistTiles";
import { useTileStore } from "./tileStore";
import type { BrowserInfo, TileGrid } from "../types";
import type { BrowserServiceEvent } from "../lib/browserEvents";
import { useWindowManagerStore } from "./windowManagerStore";

/**
 * browserStore（v3 重构后）：只管 browser 远端实体列表与打开集合；
 * 磁贴几何/组属 → tileStore（单一事实源）；moveTile/commitTile 保留为兼容入口（转发 tileStore）。
 */
interface BrowserStore {
  browsers: BrowserInfo[];
  /** 已打开的浏览器磁贴 id（打开顺序） */
  openBrowserIds: string[];
  hydrate: () => Promise<void>;
  createBrowser: (input: { name?: string; mode?: "persistent" | "incognito" }) => Promise<BrowserInfo | null>;
  deleteBrowser: (id: string) => Promise<void>;
  openBrowser: (id: string) => void;
  closeBrowser: (id: string) => void;
  updateBrowser: (browser: BrowserInfo) => void;
  /** 消费浏览器事件（created → 自动入座并打开；deleted → 移除；state → 就地更新） */
  applyBrowserEvent: (event: BrowserServiceEvent) => void;
  moveTile: (id: string, grid: TileGrid) => void;
  commitTile: (id: string, grid: TileGrid) => void;
}

export const useBrowserStore = create<BrowserStore>()((set) => ({
  browsers: [],
  openBrowserIds: [],

  async hydrate() {
    const browsers = await listBrowsers().catch(() => []);
    const tiles = useTileStore.getState();
    // 服务端现存 browser → 确保有磁贴；v3 里残留的 browser 磁贴（服务端已删）→ 清理
    const serverIds = new Set(browsers.map((b) => b.id));
    for (const tile of Object.values(tiles.tiles)) {
      if (tile.kind === "browser" && !serverIds.has(tile.id)) tiles.removeTile(tile.id);
    }
    for (const b of browsers) {
      tiles.ensureTile(b.id, "browser");
    }
    set((state) => ({
      browsers,
      openBrowserIds: state.openBrowserIds.filter((id) => serverIds.has(id)),
    }));
  },

  async createBrowser(input) {
    const browser = await apiCreateBrowser({ mode: input.mode ?? "incognito", name: input.name });
    useTileStore.getState().ensureTile(browser.id, "browser", { colHint: spawnXToCol(0) });
    set((state) => ({ browsers: [browser, ...state.browsers] }));
    return browser;
  },

  async deleteBrowser(id) {
    await apiDeleteBrowser(id);
    useTileStore.getState().removeTile(id);
    set((state) => ({
      browsers: state.browsers.filter((b) => b.id !== id),
      openBrowserIds: state.openBrowserIds.filter((openId) => openId !== id),
    }));
  },

  openBrowser(id) {
    useWindowManagerStore.getState().markOpened("browser", id);
    window.dispatchEvent(new CustomEvent("momoka:tile-opened"));
    set((state) => ({
      openBrowserIds: state.openBrowserIds.includes(id) ? state.openBrowserIds : [...state.openBrowserIds, id],
    }));
  },

  closeBrowser(id) {
    set((state) => ({ openBrowserIds: state.openBrowserIds.filter((openId) => openId !== id) }));
  },

  updateBrowser(browser) {
    set((state) => ({
      browsers: state.browsers.map((b) => (b.id === browser.id ? browser : b)),
    }));
  },

  applyBrowserEvent(event) {
    const browser = event.browser;
    if (event.type === "browser_created") {
      useWindowManagerStore.getState().markOpened("browser", browser.id);
      useTileStore.getState().ensureTile(browser.id, "browser");
      set((state) => {
        if (state.browsers.some((b) => b.id === browser.id)) {
          return state;
        }
        return {
          browsers: [browser, ...state.browsers],
          openBrowserIds: state.openBrowserIds.includes(browser.id)
            ? state.openBrowserIds
            : [...state.openBrowserIds, browser.id], // Agent/任何创建路径 → 右半舞台打开
        };
      });
      return;
    }
    if (event.type === "browser_deleted") {
      useTileStore.getState().removeTile(browser.id);
      set((state) => ({
        browsers: state.browsers.filter((b) => b.id !== browser.id),
        openBrowserIds: state.openBrowserIds.filter((id) => id !== browser.id),
      }));
      return;
    }
    // browser_state：就地更新
    set((state) => ({
      browsers: state.browsers.map((b) => (b.id === browser.id ? browser : b)),
    }));
  },

  moveTile(id, grid) {
    useTileStore.getState().moveTile(id, grid);
  },

  commitTile(id, grid) {
    useTileStore.getState().commitTile(id, grid);
  },
}));
