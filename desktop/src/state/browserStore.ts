import { create } from "zustand";

import { createBrowser as apiCreateBrowser, deleteBrowser as apiDeleteBrowser, listBrowsers } from "../lib/api";
import { insertTile } from "../lib/gridLayout";
import { loadAllTiles, removeTile, saveTile, spawnXToCol } from "../lib/persistTiles";
import type { BrowserInfo, TileGrid } from "../types";
import type { BrowserServiceEvent } from "../lib/browserEvents";
import { useWindowManagerStore } from "./windowManagerStore";

interface BrowserStore {
  browsers: BrowserInfo[];
  /** 磁贴网格：browser.id → 网格坐标/尺寸（localStorage 持久化） */
  tiles: Record<string, TileGrid>;
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

const BROWSER_TILE_PREFIX = "browser:";

function loadBrowserTiles(): Record<string, TileGrid> {
  const all = loadAllTiles();
  const tiles: Record<string, TileGrid> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(BROWSER_TILE_PREFIX)) {
      tiles[key.slice(BROWSER_TILE_PREFIX.length)] = value;
    }
  }
  return tiles;
}

export const useBrowserStore = create<BrowserStore>()((set) => ({
  browsers: [],
  tiles: {},
  openBrowserIds: [],

  async hydrate() {
    const tiles = loadBrowserTiles();
    const browsers = await listBrowsers().catch(() => []);
    set((state) => ({
      browsers,
      tiles: { ...state.tiles, ...tiles },
      openBrowserIds: state.openBrowserIds.filter((id) => browsers.some((b) => b.id === id)),
    }));
  },

  async createBrowser(input) {
    const browser = await apiCreateBrowser({ mode: input.mode ?? "incognito", name: input.name });
    set((state) => ({
      browsers: [browser, ...state.browsers],
      tiles: state.tiles[browser.id]
        ? state.tiles
        : insertTile(state.tiles, browser.id, spawnXToCol(0)),
    }));
    return browser;
  },

  async deleteBrowser(id) {
    await apiDeleteBrowser(id);
    set((state) => {
      const { [id]: _removed, ...tiles } = state.tiles;
      removeTile(`browser:${id}`);
      return {
        browsers: state.browsers.filter((b) => b.id !== id),
        tiles,
        openBrowserIds: state.openBrowserIds.filter((openId) => openId !== id),
      };
    });
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
      set((state) => {
        if (state.browsers.some((b) => b.id === browser.id)) {
          return state;
        }
        const tiles = state.tiles[browser.id]
          ? state.tiles
          : insertTile(state.tiles, browser.id, spawnXToCol(0));
        return {
          browsers: [browser, ...state.browsers],
          tiles,
          openBrowserIds: state.openBrowserIds.includes(browser.id)
            ? state.openBrowserIds
            : [...state.openBrowserIds, browser.id], // Agent/任何创建路径 → 右半舞台打开
        };
      });
      return;
    }
    if (event.type === "browser_deleted") {
      set((state) => {
        const { [browser.id]: _removed, ...tiles } = state.tiles;
        removeTile(`browser:${browser.id}`);
        return {
          browsers: state.browsers.filter((b) => b.id !== browser.id),
          tiles,
          openBrowserIds: state.openBrowserIds.filter((id) => id !== browser.id),
        };
      });
      return;
    }
    // browser_state：就地更新
    set((state) => ({
      browsers: state.browsers.map((b) => (b.id === browser.id ? browser : b)),
    }));
  },

  moveTile(id, grid) {
    set((state) => ({ tiles: { ...state.tiles, [id]: grid } }));
  },

  commitTile(id, grid) {
    set((state) => {
      const tiles = { ...state.tiles, [id]: grid };
      saveTile(`browser:${id}`, grid);
      return { tiles };
    });
  },
}));