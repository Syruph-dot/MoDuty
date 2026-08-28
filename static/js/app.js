// Generated from src/frontend/app.ts. Do not edit static/js output directly.
"use strict";
(() => {
  // src/frontend/app.ts
  var API_BASE = "/api";
  var LEGACY_READ_ONLY = true;
  var LEGACY_READ_ONLY_HINT = "\u9057\u7559\u89C6\u56FE\u5DF2\u53EA\u8BFB\uFF1A\u8BF7\u4F7F\u7528 MOMOKA \u684C\u9762\u5E94\u7528\u65B0\u5EFA\u4F1A\u8BDD\u4E0E\u5BF9\u8BDD";
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
  function uid(prefix) {
    prefix = prefix || "id";
    return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }
  function formatTime() {
    const now = /* @__PURE__ */ new Date();
    return now.toLocaleTimeString("zh-CN", { hour12: false });
  }
  function formatDate(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  async function apiPost(path, body) {
    if (LEGACY_READ_ONLY) throw new Error(LEGACY_READ_ONLY_HINT);
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  async function apiDelete(path) {
    if (LEGACY_READ_ONLY) throw new Error(LEGACY_READ_ONLY_HINT);
    const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  Object.assign(window, {
    API_BASE,
    LEGACY_READ_ONLY,
    LEGACY_READ_ONLY_HINT,
    escapeHtml,
    uid,
    formatTime,
    formatDate,
    apiPost,
    apiGet,
    apiDelete
  });
})();
