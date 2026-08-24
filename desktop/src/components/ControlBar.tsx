import { appWindow } from "@tauri-apps/api/window";

/**
 * Floating control bar for the borderless fullscreen window.
 * The Tauri window has decorations:false and starts fullscreen, so there is
 * no OS chrome to close/minimize it — these buttons are that chrome.
 * In a plain browser (dev without Tauri) the buttons are hidden.
 */
export default function ControlBar() {
  const inTauri = typeof window !== "undefined" && "__TAURI__" in window;

  if (!inTauri) {
    return (
      <div className="control-bar control-bar--browser" aria-hidden="true">
        <span className="control-bar__hint">browser mode</span>
      </div>
    );
  }

  return (
    <div className="control-bar" role="toolbar" aria-label="Window controls">
      <button
        type="button"
        className="control-bar__btn"
        aria-label="Minimize window"
        onClick={() => {
          void appWindow.minimize();
        }}
      >
        −
      </button>
      <button
        type="button"
        className="control-bar__btn control-bar__btn--close"
        aria-label="Close MOMOKA Desktop"
        onClick={() => {
          void appWindow.close();
        }}
      >
        ×
      </button>
    </div>
  );
}