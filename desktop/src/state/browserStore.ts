import { create } from "zustand";

import { browserAction, createBrowser as apiCreateBrowser, deleteBrowser as apiDeleteBrowser, listBrowsers } from "../lib/api";
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
  /** 新建浏览器失败的原因（例如没有 Tauri 壳 → 没有 WebView2 桥），桌面顶部展示 */
  error: string | null;
  hydrate: () => Promise<void>;
  createBrowser: (input: { name?: string; mode?: "persistent" | "incognito" }) => Promise<BrowserInfo | null>;
  deleteBrowser: (id: string) => Promise<void>;
  openBrowser: (id: string) => void;
  closeBrowser: (id: string) => Promise<void>;
  updateBrowser: (browser: BrowserInfo) => void;
  /** 消费浏览器事件（created → 自动入座并打开；deleted → 移除；state → 就地更新） */
  applyBrowserEvent: (event: BrowserServiceEvent) => void;
  moveTile: (id: string, grid: TileGrid) => void;
  commitTile: (id: string, grid: TileGrid) => void;
}

export const useBrowserStore = create<BrowserStore>()((set) => ({
  browsers: [],
  openBrowserIds: [],
  error: null,

  async hydrate() {
    // 读取失败 ≠ 服务端为空：失败时直接放弃本次对账，保留本地磁贴（含分组归属），
    // 否则瞬时错误会当成“服务端已删”而把所有 browser 磁贴落盘清除。
    const browsers = await listBrowsers().catch(() => null);
    if (browsers === null) return;
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
    // 页面一律磁贴内嵌（WebView2 桥），不再有“内嵌 / 外部浏览器”二选一。
    // 桥不在时后端会给出明确原因，这里把它存起来给桌面顶部展示——不往外抛：
    // 调用方（右键菜单）没有 catch，抛出去只会变成一句无人看见的 unhandled rejection。
    try {
      const browser = await apiCreateBrowser({
        mode: input.mode ?? "persistent",
        name: input.name,
      });
      useTileStore.getState().ensureTile(browser.id, "browser", { colHint: spawnXToCol(0) });
      set((state) => ({ browsers: [browser, ...state.browsers], error: null }));
      return browser;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: `新建浏览器失败：${message}` });
      return null;
    }
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

  async closeBrowser(id) {
    await browserAction(id, "close");
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
