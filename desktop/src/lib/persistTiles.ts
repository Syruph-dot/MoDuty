import type { TileGeometry } from "../types";

const STORAGE_KEY = "momoka:tiles:v1";

type TileMap = Record<string, TileGeometry>;

/**
 * 磁贴几何持久化（localStorage）。
 * - 读：整个 map 一次返回；坏数据/缺字段条目会被丢弃
 * - 写：单 key 增量写，避免拖拽过程频繁序列化整个 map
 * - 缺省：默认左上角 (32, 32)，尺寸 280×168
 */
export const DEFAULT_TILE_GEOMETRY: TileGeometry = { x: 32, y: 32, w: 280, h: 168 };

export function loadAllTiles(): TileMap {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: TileMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const geom = sanitizeGeometry(value);
      if (geom) {
        result[key] = geom;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveTile(id: string, geometry: TileGeometry): void {
  if (typeof localStorage === "undefined") return;
  const all = loadAllTiles();
  all[id] = sanitizeGeometry(geometry) ?? DEFAULT_TILE_GEOMETRY;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 配额满 / 隐私模式：静默失败，磁贴位置只在本次会话有效
  }
}

export function removeTile(id: string): void {
  if (typeof localStorage === "undefined") return;
  const all = loadAllTiles();
  if (!(id in all)) return;
  delete all[id];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 静默失败
  }
}

function sanitizeGeometry(value: unknown): TileGeometry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const x = numberInRange(raw.x, -10000, 100000);
  const y = numberInRange(raw.y, -10000, 100000);
  const w = numberInRange(raw.w, 160, 4000);
  const h = numberInRange(raw.h, 96, 4000);
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

function numberInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}
