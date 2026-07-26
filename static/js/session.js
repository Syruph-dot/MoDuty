// Generated from src/frontend/session.ts. Do not edit static/js output directly.
"use strict";
(() => {
  // src/frontend/session.ts
  var sessions = [];
  async function loadSessions() {
    try {
      const data = await apiGet("/sessions");
      sessions = data.sessions || [];
      renderSessionList();
    } catch (err) {
      showError("\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u5931\u8D25: " + err.message);
    }
  }
  function renderSessionList() {
    const list = document.getElementById("sessionList");
    const empty = document.getElementById("emptyHint");
    if (!sessions.length) {
      list.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    list.innerHTML = sessions.map((s) => {
      const folderDisplay = s.folder_path ? s.folder_path.replace(/\\/g, "/") : "";
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
                    <div class="session-card-msgs">${msgCount} \u6761\u6D88\u606F</div>
                    <div class="session-card-time">${lastTime}</div>
                    <button class="session-card-del" onclick="event.stopPropagation(); deleteSession('${s.id}')" title="\u5220\u9664\u4F1A\u8BDD">\u2715</button>
                </div>
            </div>
        `;
    }).join("");
  }
  function openSession(sessionId) {
    window.location.href = `chat.html?id=${sessionId}`;
  }
  async function deleteSession(sessionId) {
    if (!confirm("\u786E\u5B9A\u5220\u9664\u6B64\u4F1A\u8BDD\u53CA\u5176\u6240\u6709\u6D88\u606F\uFF1F")) return;
    try {
      await apiDelete(`/sessions/${sessionId}`);
      sessions = sessions.filter((s) => s.id !== sessionId);
      renderSessionList();
    } catch (err) {
      showError("\u5220\u9664\u4F1A\u8BDD\u5931\u8D25: " + err.message);
    }
  }
  function showCreateModal() {
    document.getElementById("createModal").classList.add("open");
    document.getElementById("goalInput").focus();
  }
  function hideCreateModal() {
    document.getElementById("createModal").classList.remove("open");
  }
  async function createSession() {
    const goal = document.getElementById("goalInput").value.trim();
    const folderPath = document.getElementById("folderInput").value.trim();
    if (!goal) {
      showError("\u8BF7\u8F93\u5165\u4F1A\u8BDD\u6838\u5FC3\u76EE\u6807");
      return;
    }
    if (!folderPath) {
      showError("\u8BF7\u9009\u62E9\u5DE5\u4F5C\u6587\u4EF6\u5939");
      return;
    }
    const btn = document.getElementById("createBtn");
    btn.disabled = true;
    btn.textContent = "\u521B\u5EFA\u4E2D...";
    try {
      const data = await apiPost("/sessions", { goal, folder_path: folderPath });
      window.location.href = `chat.html?id=${data.session.id}`;
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = "\u521B\u5EFA\u4F1A\u8BDD";
    }
  }
  var dirBrowserCurrent = "";
  var dirBrowserSelected = "";
  function selectFolder() {
    dirBrowserCurrent = "";
    dirBrowserSelected = "";
    document.getElementById("selectDirBtn").disabled = true;
    document.getElementById("dirSelected").textContent = "\u672A\u9009\u62E9";
    document.getElementById("dirBrowserModal").classList.add("open");
    loadDirList("");
  }
  function hideDirBrowser() {
    document.getElementById("dirBrowserModal").classList.remove("open");
  }
  async function loadDirList(path) {
    const listEl = document.getElementById("dirList");
    const breadcrumbEl = document.getElementById("dirBreadcrumb");
    listEl.innerHTML = '<div class="dir-loading">\u52A0\u8F7D\u4E2D...</div>';
    try {
      const url = path ? `/api/directories?path=${encodeURIComponent(path)}` : "/api/directories";
      const resp = await fetch(url);
      if (!resp.ok) {
        const err = await resp.json();
        listEl.innerHTML = `<div class="dir-error">\u9519\u8BEF: ${err.error || resp.statusText}</div>`;
        return;
      }
      const data = await resp.json();
      dirBrowserCurrent = data.path || "";
      renderBreadcrumb(breadcrumbEl, data);
      renderDirList(listEl, data);
    } catch (err) {
      listEl.innerHTML = `<div class="dir-error">\u52A0\u8F7D\u5931\u8D25: ${err.message}</div>`;
    }
  }
  function renderBreadcrumb(el, data) {
    const path = data.path || "";
    if (!path) {
      el.innerHTML = '<span class="crumb-item crumb-root">\u6211\u7684\u7535\u8111</span>';
      return;
    }
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    let crumbs = "";
    let pathSoFar = "";
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && parts[i].endsWith(":")) {
        pathSoFar = parts[i] + "\\";
      } else {
        pathSoFar += (i === 0 ? "" : "/") + parts[i];
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
    if (path.includes(":")) {
      crumbs = `<span class="crumb-item crumb-link" data-nav="">\u6211\u7684\u7535\u8111</span><span class="crumb-sep">/</span>` + crumbs;
    } else if (data.parent) {
      crumbs = `<span class="crumb-item crumb-link" data-nav="${escapeHtml(data.parent)}">\u2B06 ..</span><span class="crumb-sep">/</span>` + crumbs;
    }
    el.innerHTML = crumbs;
  }
  function renderDirList(el, data) {
    if (!data || !data.entries || !data.entries.length) {
      el.innerHTML = '<div class="dir-empty">\uFF08\u7A7A\u76EE\u5F55\uFF09</div>';
      return;
    }
    let html = "";
    if (data.parent) {
      html += `<div class="dir-item dir-item-up" data-nav="${escapeHtml(data.parent)}">\u2B06 ..</div>`;
    } else if (data.path) {
      html += `<div class="dir-item dir-item-up" data-nav="">\u2B06 \u6211\u7684\u7535\u8111</div>`;
    }
    for (const entry of data.entries) {
      if (!entry.is_dir) continue;
      const icon = entry.name.endsWith(":") ? "\u{1F4BE}" : "\u{1F4C1}";
      html += `<div class="dir-item dir-item-folder" data-path="${escapeHtml(entry.path)}">
            <span class="dir-item-icon">${icon}</span>
            <span class="dir-item-name">${escapeHtml(entry.name)}</span>
        </div>`;
    }
    if (html === "") {
      html = '<div class="dir-empty">\uFF08\u65E0\u5B50\u76EE\u5F55\uFF09</div>';
    }
    el.innerHTML = html;
  }
  function confirmDirSelection() {
    if (!dirBrowserSelected) return;
    document.getElementById("folderInput").value = dirBrowserSelected;
    hideDirBrowser();
  }
  document.addEventListener("click", function(e) {
    const browserModal = document.getElementById("dirBrowserModal");
    if (e.target === browserModal) {
      hideDirBrowser();
      return;
    }
    const navItem = e.target.closest("[data-nav]");
    if (navItem) {
      const path = navItem.dataset.nav;
      loadDirList(path);
      return;
    }
    const folderItem = e.target.closest(".dir-item-folder");
    if (folderItem && folderItem.dataset.path) {
      const path = folderItem.dataset.path;
      document.querySelectorAll(".dir-item-folder.selected").forEach((el) => el.classList.remove("selected"));
      folderItem.classList.add("selected");
      dirBrowserSelected = path;
      document.getElementById("dirSelected").textContent = `\u5DF2\u9009: ${path}`;
      document.getElementById("selectDirBtn").disabled = false;
      return;
    }
  });
  document.addEventListener("dblclick", function(e) {
    const folderItem = e.target.closest(".dir-item-folder");
    if (folderItem && folderItem.dataset.path) {
      loadDirList(folderItem.dataset.path);
    }
  });
  function onGoalKeydown(e) {
    if (e.key === "Enter") {
      document.getElementById("folderInput").focus();
    }
  }
  function onFolderKeydown(e) {
    if (e.key === "Enter") {
      createSession();
    }
  }
  function showError(msg) {
    const el = document.getElementById("errorToast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 4e3);
  }
  document.addEventListener("DOMContentLoaded", loadSessions);
  document.addEventListener("click", function(e) {
    const modal = document.getElementById("createModal");
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
    showError
  });
})();
