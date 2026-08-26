import { useEffect, useRef, useState } from "react";

import { useDialogStore } from "../state/dialogStore";
import { useWallpaperStore } from "../state/wallpaperStore";

const MAX_BYTES = 4 * 1024 * 1024; // 4MB 上限：localStorage 配额一般 5MB

/**
 * 壁纸选择弹窗：
 * - 「Default gradient」回到 .desktop-shell 上原本的 CSS 渐变
 * - 「Choose local image」用 <input type=file> → FileReader.readAsDataURL 读成 base64
 * - 选中的图会立即应用到 .desktop-shell，并存到 localStorage
 */
export default function WallpaperDialog() {
  const open = useDialogStore((state) => state.wallpaperOpen);
  const close = useDialogStore((state) => state.closeWallpaper);
  const setDefault = useWallpaperStore((state) => state.setDefault);
  const setImage = useWallpaperStore((state) => state.setImage);
  const mode = useWallpaperStore((state) => state.mode);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  if (!open) return null;

  const onBackdropClick = () => close();

  const onPickFile = () => {
    setError(null);
    fileInputRef.current?.click();
  };

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // 允许重选同一张
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件（png / jpg / webp / gif）");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 4MB）`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("读取文件失败");
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        setError("读取结果非图片");
        return;
      }
      setImage(result);
      close();
    };
    reader.readAsDataURL(file);
  };

  const onUseDefault = () => {
    setDefault();
    close();
  };

  return (
    <div className="dialog-backdrop" onClick={onBackdropClick}>
      <div
        className="dialog wallpaper-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="更换桌面壁纸"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title">Change wallpaper</h2>
        <p className="wallpaper-dialog__hint">选择本地图片作为桌面背景，或恢复默认渐变。</p>

        <div className="wallpaper-dialog__options">
          <button
            type="button"
            className={`wallpaper-dialog__option ${mode === "default" ? "wallpaper-dialog__option--active" : ""}`}
            onClick={onUseDefault}
          >
            <span className="wallpaper-dialog__option-title">Default gradient</span>
            <span className="wallpaper-dialog__option-desc">深色玻璃质感（CSS 渐变）</span>
          </button>
          <button
            type="button"
            className={`wallpaper-dialog__option ${mode === "image" ? "wallpaper-dialog__option--active" : ""}`}
            onClick={onPickFile}
          >
            <span className="wallpaper-dialog__option-title">Choose local image</span>
            <span className="wallpaper-dialog__option-desc">支持 png / jpg / webp，最大 4MB</span>
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="wallpaper-dialog__file"
          onChange={onFileChange}
        />

        {error ? (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
