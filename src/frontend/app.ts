/**
 * MOMOKA 核心工具函数 — 所有页面共享
 */

const API_BASE = '/api';

// 双轨收束：旧 web UI 已降级为只读遗留视图。
// 新建/删除/对话一律走 MOMOKA 桌面应用（Agent Desktop）；写请求在客户端直接拦截。
const LEGACY_READ_ONLY = true;
const LEGACY_READ_ONLY_HINT = '遗留视图已只读：请使用 MOMOKA 桌面应用新建会话与对话';

// --- 工具函数 ---
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function uid(prefix) {
    prefix = prefix || 'id';
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function formatTime() {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// --- API 封装 ---
async function apiPost(path, body) {
    if (LEGACY_READ_ONLY) throw new Error(LEGACY_READ_ONLY_HINT);
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
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
    apiDelete,
});
