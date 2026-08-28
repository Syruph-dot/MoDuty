/**
 * MOMOKA 会话管理 — 会话列表页前端逻辑
 */

let sessions = [];

// ── 加载会话列表 ──
async function loadSessions() {
    try {
        const data = await apiGet('/sessions');
        sessions = data.sessions || [];
        renderSessionList();
    } catch (err) {
        showError('加载会话列表失败: ' + err.message);
    }
}

// ── 渲染会话列表 ──
function renderSessionList() {
    const list = document.getElementById('sessionList');
    const empty = document.getElementById('emptyHint');

    if (!sessions.length) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    list.innerHTML = sessions.map(s => {
        const folderDisplay = s.folder_path ? s.folder_path.replace(/\\/g, '/') : '';
        const msgCount = s.message_count || 0;
        const lastTime = formatDate(s.last_message_at) || formatDate(s.created_at);
        return `
            <div class="session-card" data-id="${s.id}" onclick="openSession('${s.id}')">
                <div class="session-card-main">
                    <div class="session-card-name">${escapeHtml(s.name)}</div>
                    <div class="session-card-goal">${escapeHtml(s.goal)}</div>
                    <div class="session-card-meta">
                        <span class="session-card-folder">${escapeHtml(folderDisplay)}</span>
                    </div>
                </div>
                <div class="session-card-side">
                    <div class="session-card-msgs">${msgCount} 条消息</div>
                    <div class="session-card-time">${lastTime}</div>
                </div>
            </div>
        `;
    }).join('');
}

// ── 打开会话（进入聊天页） ──
function openSession(sessionId) {
    window.location.href = `chat.html?id=${sessionId}`;
}

// ── 删除会话 ──
async function deleteSession(sessionId) {
    if (!confirm('确定删除此会话及其所有消息？')) return;
    try {
        await apiDelete(`/sessions/${sessionId}`);
        sessions = sessions.filter(s => s.id !== sessionId);
        renderSessionList();
    } catch (err) {
        showError('删除会话失败: ' + err.message);
    }
}

// ── 创建会话弹窗 ──
function showCreateModal() {
    document.getElementById('createModal').classList.add('open');
    document.getElementById('goalInput').focus();
}

function hideCreateModal() {
    document.getElementById('createModal').classList.remove('open');
}

async function createSession() {
    const goal = document.getElementById('goalInput').value.trim();
    const folderPath = document.getElementById('folderInput').value.trim();

    if (!goal) {
        showError('请输入会话核心目标');
        return;
    }
    if (!folderPath) {
        showError('请选择工作文件夹');
        return;
    }

    const btn = document.getElementById('createBtn');
    btn.disabled = true;
    btn.textContent = '创建中...';

    try {
        const data = await apiPost('/sessions', { goal, folder_path: folderPath });
        // 跳转到聊天页
        window.location.href = `chat.html?id=${data.session.id}`;
    } catch (err) {
        showError(err.message);
        btn.disabled = false;
        btn.textContent = '创建会话';
    }
}

// ── 文件夹选择（服务端目录浏览器） ──

let dirBrowserCurrent = '';     // 当前浏览路径
let dirBrowserSelected = '';    // 最终选中路径

function selectFolder() {
    dirBrowserCurrent = '';
    dirBrowserSelected = '';
    document.getElementById('selectDirBtn').disabled = true;
    document.getElementById('dirSelected').textContent = '未选择';
    document.getElementById('dirBrowserModal').classList.add('open');
    loadDirList('');
}

function hideDirBrowser() {
    document.getElementById('dirBrowserModal').classList.remove('open');
}

async function loadDirList(path) {
    const listEl = document.getElementById('dirList');
    const breadcrumbEl = document.getElementById('dirBreadcrumb');
    listEl.innerHTML = '<div class="dir-loading">加载中...</div>';

    try {
        const url = path ? `/api/directories?path=${encodeURIComponent(path)}` : '/api/directories';
        const resp = await fetch(url);
        if (!resp.ok) {
            const err = await resp.json();
            listEl.innerHTML = `<div class="dir-error">错误: ${err.error || resp.statusText}</div>`;
            return;
        }
        const data = await resp.json();

        dirBrowserCurrent = data.path || '';
        renderBreadcrumb(breadcrumbEl, data);
        renderDirList(listEl, data);
    } catch (err) {
        listEl.innerHTML = `<div class="dir-error">加载失败: ${err.message}</div>`;
    }
}

function renderBreadcrumb(el, data) {
    const path = data.path || '';
    if (!path) {
        el.innerHTML = '<span class="crumb-item crumb-root">我的电脑</span>';
        return;
    }

    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);

    let crumbs = '';
    let pathSoFar = '';
    for (let i = 0; i < parts.length; i++) {
        if (i === 0 && parts[i].endsWith(':')) {
            pathSoFar = parts[i] + '\\';
        } else {
            pathSoFar += (i === 0 ? '' : '/') + parts[i];
        }
        const isLast = i === parts.length - 1;
        const label = parts[i];
        if (isLast) {
            crumbs += `<span class="crumb-item crumb-current">${escapeHtml(label)}</span>`;
        } else {
            crumbs += `<span class="crumb-item crumb-link" data-nav="${escapeHtml(pathSoFar)}">${escapeHtml(label)}</span>`;
            crumbs += `<span class="crumb-sep">/</span>`;
        }
    }
    // 在 Windows 下，第一个面包屑前加"我的电脑"入口
    if (path.includes(':')) {
        crumbs = `<span class="crumb-item crumb-link" data-nav="">我的电脑</span><span class="crumb-sep">/</span>` + crumbs;
    } else if (data.parent) {
        crumbs = `<span class="crumb-item crumb-link" data-nav="${escapeHtml(data.parent)}">⬆ ..</span><span class="crumb-sep">/</span>` + crumbs;
    }
    el.innerHTML = crumbs;
}

function renderDirList(el, data) {
    if (!data || !data.entries || !data.entries.length) {
        el.innerHTML = '<div class="dir-empty">（空目录）</div>';
        return;
    }

    let html = '';
    // 如果有父级，添加上一级导航
    if (data.parent) {
        html += `<div class="dir-item dir-item-up" data-nav="${escapeHtml(data.parent)}">⬆ ..</div>`;
    } else if (data.path) {
        // 当前有路径但没有父级 → 回到驱动器列表
        html += `<div class="dir-item dir-item-up" data-nav="">⬆ 我的电脑</div>`;
    }

    for (const entry of data.entries) {
        if (!entry.is_dir) continue; // 只显示目录
        const icon = entry.name.endsWith(':') ? '💾' : '📁';
        html += `<div class="dir-item dir-item-folder" data-path="${escapeHtml(entry.path)}">
            <span class="dir-item-icon">${icon}</span>
            <span class="dir-item-name">${escapeHtml(entry.name)}</span>
        </div>`;
    }

    if (html === '') {
        html = '<div class="dir-empty">（无子目录）</div>';
    }

    el.innerHTML = html;
}

function confirmDirSelection() {
    if (!dirBrowserSelected) return;
    document.getElementById('folderInput').value = dirBrowserSelected;
    hideDirBrowser();
}

// 目录浏览器事件委托（处理导航、选择）
document.addEventListener('click', function(e) {
    // 关闭目录浏览器弹窗（点击遮罩）
    const browserModal = document.getElementById('dirBrowserModal');
    if (e.target === browserModal) {
        hideDirBrowser();
        return;
    }

    // 面包屑导航 / 上级目录导航
    const navItem = e.target.closest('[data-nav]');
    if (navItem) {
        const path = navItem.dataset.nav;
        loadDirList(path);
        return;
    }

    // 选择目录
    const folderItem = e.target.closest('.dir-item-folder');
    if (folderItem && folderItem.dataset.path) {
        const path = folderItem.dataset.path;

        // 高亮选中的目录
        document.querySelectorAll('.dir-item-folder.selected').forEach(el => el.classList.remove('selected'));
        folderItem.classList.add('selected');

        // 更新选中状态
        dirBrowserSelected = path;
        document.getElementById('dirSelected').textContent = `已选: ${path}`;
        document.getElementById('selectDirBtn').disabled = false;
        return;
    }

    // 双击目录进入（使用单击 + 延迟判断，但这里不实现双击以避免干扰单击选择）
    // 双击由用户在目录上快速双击，通过单独的 dblclick 处理
});

// 双击进入目录
document.addEventListener('dblclick', function(e) {
    const folderItem = e.target.closest('.dir-item-folder');
    if (folderItem && folderItem.dataset.path) {
        loadDirList(folderItem.dataset.path);
    }
});

// 回车快捷创建
function onGoalKeydown(e) {
    if (e.key === 'Enter') {
        document.getElementById('folderInput').focus();
    }
}
function onFolderKeydown(e) {
    if (e.key === 'Enter') {
        createSession();
    }
}

// ── 错误提示 ──
function showError(msg) {
    const el = document.getElementById('errorToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 4000);
}

// ── 初始化 ──
document.addEventListener('DOMContentLoaded', loadSessions);

// 点击弹窗外部关闭
document.addEventListener('click', function(e) {
    const modal = document.getElementById('createModal');
    if (e.target === modal) hideCreateModal();
});

Object.assign(window, {
    loadSessions,
    renderSessionList,
    openSession,
    deleteSession,
    showCreateModal,
    hideCreateModal,
    createSession,
    selectFolder,
    hideDirBrowser,
    loadDirList,
    renderBreadcrumb,
    renderDirList,
    confirmDirSelection,
    onGoalKeydown,
    onFolderKeydown,
    showError,
});
