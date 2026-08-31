import { useGhostStore } from "../state/ghostStore";

/**
 * Win8 磁贴"量化灰色提示框"：拖动/缩放过程中显示松手后的落点与量化尺寸。
 * - 半透明灰块 + 虚线边框，高于磁贴本体 z-index
 * - 只读展示（pointer-events: none）
 */
export default function GhostPreview() {
  const pixels = useGhostStore((state) => state.pixels);
  if (!pixels) return null;
  return (
    <div
      className="tile-ghost"
      style={{ left: pixels.x, top: pixels.y, width: pixels.w, height: pixels.h }}
      aria-hidden="true"
    />
  );
}