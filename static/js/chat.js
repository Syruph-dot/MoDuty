// Generated from src/frontend/chat.ts. Do not edit static/js output directly.
"use strict";
(() => {
  // src/frontend/chat.ts
  var sessionId = "";
  var session = null;
  var lastOutputId = "";
  var isProcessing = false;
  var loadedMessageIds = /* @__PURE__ */ new Set();
  var selectionJudge = {
    outputId: "",
    text: "",
    bubble: null
  };
  document.addEventListener("DOMContentLoaded", initChat);
  async function initChat() {
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get("id");
    if (!sessionId) {
      showPageError("\u7F3A\u5C11\u4F1A\u8BDD ID\uFF0C\u8BF7\u4ECE\u4F1A\u8BDD\u5217\u8868\u8FDB\u5165\u3002");
      return;
    }
    try {
      const data = await apiGet(`/sessions/${sessionId}`);
      session = data.session;
      renderSessionHeader();
      await loadMessages();
      await refreshApprovals();
      if (session.message_count === 0) {
        await sendGoalAsFirstMessage();
      }
    } catch (err) {
      showPageError("\u52A0\u8F7D\u4F1A\u8BDD\u5931\u8D25: " + err.message);
    }
  }
  function renderSessionHeader() {
    document.getElementById("sessionName").textContent = session.name || "\u672A\u547D\u540D\u4F1A\u8BDD";
    document.getElementById("sessionGoal").textContent = session.goal || "";
    const folderDisplay = session.folder_path ? session.folder_path.replace(/\\/g, "/") : "";
    document.getElementById("sessionFolder").textContent = folderDisplay;
    document.getElementById("sessionFolder").title = folderDisplay;
  }
  async function loadMessages() {
    try {
      const data = await apiGet(`/sessions/${sessionId}/messages`);
      const messages = data.messages || [];
      loadedMessageIds = new Set(messages.map((m) => m.id));
      for (const msg of messages) {
        if (msg.eventType === "approval_execution") {
          addToolLog(msg.toolName || "approved_tool", msg.toolArgs || {}, msg.toolResult || msg.content);
        }
        if (msg.role === "user") {
          addMessage("user", msg.content, msg.id, false);
        } else {
          addMessage("agent", msg.content, msg.output_id || msg.id, Boolean(msg.output_id), msg.matched_skills, msg.tool_calls);
        }
      }
      scrollToBottom();
    } catch (err) {
      console.warn("\u52A0\u8F7D\u5386\u53F2\u6D88\u606F\u5931\u8D25:", err);
    }
  }
  async function sendMessage() {
    if (isProcessing) return;
    const input = document.getElementById("chatInput");
    const message = input.value.trim();
    if (!message) return;
    isProcessing = true;
    input.value = "";
    input.disabled = true;
    document.getElementById("sendBtn").disabled = true;
    setStatus("thinking", "\u601D\u8003\u4E2D...");
    addMessage("user", message, uid("msg"), false);
    try {
      await runStreamingChat({
        session_id: sessionId,
        message,
        output_id: uid("out"),
        topic: session ? session.goal : message
      });
    } catch (err) {
    } finally {
      isProcessing = false;
      input.disabled = false;
      document.getElementById("sendBtn").disabled = false;
      input.focus();
    }
  }
  async function sendGoalAsFirstMessage() {
    if (!session || !session.goal || isProcessing) return;
    const goal = session.goal;
    isProcessing = true;
    setStatus("thinking", "\u601D\u8003\u4E2D...");
    addMessage("user", goal, uid("msg"), false);
    try {
      await runStreamingChat({
        session_id: sessionId,
        message: goal,
        output_id: uid("out"),
        topic: goal
      });
    } catch (err) {
    } finally {
      isProcessing = false;
    }
  }
  var STREAM_TIMEOUT_MS = 18e4;
  var activeAbort = null;
  async function runStreamingChat(payload) {
    const outId = payload.output_id || uid("out");
    const holder = createStreamingAgentBubble(outId);
    lastOutputId = outId;
    activeAbort = new AbortController();
    const timeoutTimer = setTimeout(() => {
      if (activeAbort) activeAbort.abort();
    }, STREAM_TIMEOUT_MS);
    showStopButton(true);
    let fullText = "";
    let rafPending = false;
    let lastToolCard = null;
    const flush = () => {
      rafPending = false;
      holder.bubble.innerHTML = escapeHtml(fullText).replace(/\n/g, "<br>");
      scrollToBottom();
    };
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({}, payload, { stream: true })),
        signal: activeAbort.signal
      });
      if (!res.ok || !res.body) {
        const data2 = await res.json().catch(() => ({}));
        throw new Error(data2.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalData = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let event;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (event.type === "token") {
              fullText += event.text || "";
              if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(flush);
              }
            } else if (event.type === "tool_start") {
              lastToolCard = createToolCard(event.name, event.args, "\u6267\u884C\u4E2D...");
            } else if (event.type === "tool_result") {
              if (lastToolCard) {
                updateToolCardResult(lastToolCard, event.result);
                lastToolCard = null;
              } else {
                addToolLog(event.name, event.args || {}, event.result);
              }
            } else if (event.type === "approval_requested") {
              setStatus("thinking", "\u7B49\u5F85\u5BA1\u6279...");
              refreshApprovals();
            } else if (event.type === "done") {
              finalData = event;
            } else if (event.type === "error") {
              throw new Error(event.error || "\u670D\u52A1\u5668\u9519\u8BEF");
            }
          }
        }
      }
      if (rafPending) requestAnimationFrame(flush);
      if (!finalData) throw new Error("\u8FDE\u63A5\u610F\u5916\u7ED3\u675F\uFF08\u672A\u6536\u5230\u5B8C\u6210\u4E8B\u4EF6\uFF09");
      const data = finalData;
      if (data.session_id) {
        session.message_count = (session.message_count || 0) + 1;
        session.last_message_at = (/* @__PURE__ */ new Date()).toISOString();
      }
      const skillPayload = data.skill_reasons || data.matched_skills;
      updateSkillTags(skillPayload);
      holder.bubble.insertAdjacentHTML("afterend", renderJudgeBar(data.output_id || outId));
      await refreshApprovals();
      setStatus("idle", "\u5C31\u7EEA");
      return data;
    } catch (err) {
      const stopped = activeAbort && activeAbort.signal.aborted;
      holder.bubble.innerHTML = escapeHtml(fullText) + `<div style="color:#c33;font-size:11px;margin-top:4px">${stopped ? "\u5DF2\u505C\u6B62" : `\u9519\u8BEF: ${escapeHtml(err.message)}`}</div>`;
      setStatus("error", stopped ? "\u5DF2\u505C\u6B62" : "\u9519\u8BEF");
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      showStopButton(false);
      activeAbort = null;
    }
  }
  function createStreamingAgentBubble(outId) {
    const container = document.getElementById("chatMessages");
    const div = document.createElement("div");
    div.className = "chat-message agent";
    div.setAttribute("data-msg-id", outId);
    div.innerHTML = '<div class="msg-label">MOMOKA</div><div class="msg-bubble"></div>';
    container.appendChild(div);
    scrollToBottom();
    return { bubble: div.querySelector(".msg-bubble") };
  }
  function createToolCard(toolName, args, resultText) {
    const container = document.getElementById("toolLogs");
    const placeholder = container.querySelector(".tool-log-empty");
    if (placeholder) placeholder.remove();
    const card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML = `
        <div class="tool-card-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
            <span class="tool-card-name">[TOOL] ${escapeHtml(toolName)}</span>
            <span class="tool-card-time">${formatTime()}</span>
        </div>
        <div class="tool-card-body">
            <div class="tool-card-args"><strong>\u53C2\u6570:</strong> ${escapeHtml(typeof args === "string" ? args : JSON.stringify(args))}</div>
            <div class="tool-card-result">${escapeHtml(resultText || "")}</div>
        </div>
    `;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
    return card;
  }
  function updateToolCardResult(card, resultText) {
    const resultEl = card.querySelector(".tool-card-result");
    if (resultEl) resultEl.textContent = resultText || "";
    const container = document.getElementById("toolLogs");
    container.scrollTop = container.scrollHeight;
  }
  function stopStreaming() {
    if (activeAbort) activeAbort.abort();
  }
  function showStopButton(visible) {
    const btn = document.getElementById("stopBtn");
    if (btn) btn.style.display = visible ? "" : "none";
  }
  function addMessage(role, text, msgId, showJudge, matchedSkills, toolCalls) {
    const container = document.getElementById("chatMessages");
    if (!msgId) msgId = uid("msg");
    if (role === "agent") {
      lastOutputId = msgId;
    }
    const div = document.createElement("div");
    div.className = `chat-message ${role}`;
    div.setAttribute("data-msg-id", msgId);
    const label = role === "user" ? "\u4F60" : "MOMOKA";
    let html = `<div class="msg-label">${label}</div>`;
    html += `<div class="msg-bubble">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
    if (role === "agent" && showJudge) {
      html += renderJudgeBar(msgId);
    }
    div.innerHTML = html;
    container.appendChild(div);
    scrollToBottom();
  }
  function scrollToBottom() {
    const container = document.getElementById("chatMessages");
    container.scrollTop = container.scrollHeight;
  }
  function renderJudgeBar(outputId) {
    const labels = [
      { score: 1, title: "\u5F3A\u70C8\u53CD\u5BF9" },
      { score: 2, title: "\u53CD\u5BF9" },
      { score: 3, title: "\u4E0D\u592A\u8D5E\u540C" },
      { score: 4, cls: "neutral", title: "\u4E2D\u7ACB" },
      { score: 5, title: "\u6709\u70B9\u8D5E\u540C" },
      { score: 6, title: "\u8D5E\u540C" },
      { score: 7, title: "\u5F3A\u70C8\u8D5E\u540C" }
    ];
    let html = `<div class="judge-bar" data-output-id="${outputId}">`;
    html += '<span class="judge-label">\u8BC4\u5206:</span>';
    for (const l of labels) {
      html += `<button class="judge-btn ${l.cls || ""}" onclick="selectJudgeScore(this,'${outputId}')" title="${l.title}">${l.score}</button>`;
    }
    html += `<input class="judge-comment" id="comment-${outputId}" type="text" maxlength="500" placeholder="\u6279\u6CE8(\u9009\u586B)" aria-label="\u6587\u5B57\u6279\u6CE8">`;
    html += `<button class="judge-send-btn" onclick="sendJudgeByBar('${outputId}')" title="\u63D0\u4EA4\u8BC4\u5206\u4E0E\u6279\u6CE8">\u53D1\u9001</button>`;
    html += `<span class="judge-feedback" id="feedback-${outputId}"></span>`;
    html += "</div>";
    return html;
  }
  function selectJudgeScore(btn, outputId) {
    const bar = btn.closest(".judge-bar");
    if (!bar) return;
    bar.querySelectorAll(".judge-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  }
  function sendJudgeByBar(outputId) {
    const bar = document.querySelector(`.judge-bar[data-output-id="${outputId}"]`);
    if (!bar) return;
    const activeBtn = bar.querySelector(".judge-btn.active");
    if (!activeBtn) {
      const fb = document.getElementById(`feedback-${outputId}`);
      if (fb) {
        fb.textContent = "\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u8BC4\u5206";
        fb.className = "judge-feedback score-3";
      }
      return;
    }
    const score = parseInt(activeBtn.textContent);
    sendJudge(outputId, score, "block");
  }
  function ensureSelectionJudgeBar() {
    let popover = document.getElementById("selectionJudgeBar");
    if (popover) return popover;
    popover = document.createElement("div");
    popover.id = "selectionJudgeBar";
    popover.className = "selection-judge-popover";
    popover.innerHTML = `
        <div class="selection-score-row">
            <span class="judge-label">\u8BC4\u5206:</span>
            <button class="judge-btn" data-score="1" title="\u5F3A\u70C8\u53CD\u5BF9">1</button>
            <button class="judge-btn" data-score="2" title="\u53CD\u5BF9">2</button>
            <button class="judge-btn" data-score="3" title="\u4E0D\u592A\u8D5E\u540C">3</button>
            <button class="judge-btn neutral" data-score="4" title="\u4E2D\u7ACB">4</button>
            <button class="judge-btn" data-score="5" title="\u6709\u70B9\u8D5E\u540C">5</button>
            <button class="judge-btn" data-score="6" title="\u8D5E\u540C">6</button>
            <button class="judge-btn" data-score="7" title="\u5F3A\u70C8\u8D5E\u540C">7</button>
        </div>
        <div class="selection-input-row">
            <input class="judge-comment selection-comment" id="selectionJudgeComment" type="text" maxlength="500" placeholder="\u6279\u6CE8(\u9009\u586B)" aria-label="\u9009\u4E2D\u6587\u5B57\u6279\u6CE8">
            <button class="judge-send-btn selection-send-btn" title="\u8FFD\u52A0\u6B64\u6761\u5212\u8BCD\u8BC4\u5206\u4E0E\u6279\u6CE8">\u8BBE\u7F6E</button>
        </div>
        <span class="judge-feedback" id="selectionJudgeFeedback"></span>
    `;
    popover.addEventListener("click", function(e) {
      const btn = e.target.closest(".judge-btn[data-score]");
      if (!btn) return;
      popover.querySelectorAll(".judge-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
    popover.addEventListener("click", function(e) {
      const sendBtn = e.target.closest(".selection-send-btn");
      if (!sendBtn) return;
      const activeBtn = popover.querySelector(".judge-btn.active");
      if (!activeBtn) {
        const fb = document.getElementById("selectionJudgeFeedback");
        if (fb) {
          fb.textContent = "\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u8BC4\u5206";
          fb.className = "judge-feedback score-3";
        }
        return;
      }
      const score = Number(activeBtn.dataset.score);
      sendJudge(selectionJudge.outputId, score, "selection");
    });
    document.body.appendChild(popover);
    return popover;
  }
  function hideSelectionJudgeBar() {
    const popover = document.getElementById("selectionJudgeBar");
    if (popover) popover.classList.remove("visible");
  }
  function showSelectionJudgeBar(rect, bubble, selectedText) {
    const message = bubble.closest(".chat-message");
    const outputId = message ? message.getAttribute("data-msg-id") : "";
    if (!outputId || !message.querySelector(".judge-bar")) {
      hideSelectionJudgeBar();
      return;
    }
    selectionJudge = {
      outputId,
      text: selectedText,
      bubble
    };
    const popover = ensureSelectionJudgeBar();
    const comment = popover.querySelector("#selectionJudgeComment");
    if (comment) comment.value = "";
    popover.classList.add("visible");
    const top = Math.max(8, rect.top + window.scrollY - popover.offsetHeight - 8);
    const center = rect.left + window.scrollX + rect.width / 2;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - popover.offsetWidth - 8;
    const left = Math.max(8 + window.scrollX, Math.min(maxLeft, center - popover.offsetWidth / 2));
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }
  document.addEventListener("mouseup", function(e) {
    if (e.target.closest("#selectionJudgeBar")) return;
    const bubble = e.target.closest(".chat-message.agent .msg-bubble");
    if (!bubble) {
      hideSelectionJudgeBar();
      return;
    }
    const selection = window.getSelection();
    const sel = selection.toString().trim();
    if (!sel || selection.rangeCount === 0) {
      hideSelectionJudgeBar();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!bubble.contains(range.commonAncestorContainer)) {
      hideSelectionJudgeBar();
      return;
    }
    showSelectionJudgeBar(range.getBoundingClientRect(), bubble, sel);
  });
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") hideSelectionJudgeBar();
  });
  document.addEventListener("scroll", hideSelectionJudgeBar, true);
  async function sendJudge(outputId, score, scope) {
    if (isProcessing) return;
    const bar = document.querySelector(`.judge-bar[data-output-id="${outputId}"]`);
    const isSelection = scope === "selection";
    if (!bar && !isSelection) return;
    isProcessing = true;
    let selectedText = "";
    let comment = "";
    if (isSelection) {
      selectedText = selectionJudge.outputId === outputId ? selectionJudge.text : "";
      const selectionComment = document.getElementById("selectionJudgeComment");
      comment = selectionComment ? selectionComment.value.trim() : "";
    } else {
      const commentInput = document.getElementById(`comment-${outputId}`);
      comment = commentInput ? commentInput.value.trim() : "";
    }
    const labelMap = { 1: "\u5F3A\u70C8\u53CD\u5BF9", 2: "\u53CD\u5BF9", 3: "\u4E0D\u592A\u8D5E\u540C", 4: "\u4E2D\u7ACB", 5: "\u6709\u70B9\u8D5E\u540C", 6: "\u8D5E\u540C", 7: "\u5F3A\u70C8\u8D5E\u540C" };
    const label = labelMap[score] || "\u672A\u77E5";
    console.log("[MOMOKA] \u63D0\u4EA4\u6279\u6CE8\u8D26\u672C\u4E8B\u4EF6:", {
      output_id: outputId,
      score,
      label,
      context: selectedText,
      comment,
      continue: !isSelection
    });
    const shouldContinue = !isSelection;
    let hadError = false;
    try {
      if (shouldContinue) setStatus("thinking", "\u7EED\u731C\u4E2D...");
      const res = await fetch(`${API_BASE}/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          output_id: outputId,
          score,
          context: selectedText,
          comment,
          continue: shouldContinue
        })
      });
      const data = await res.json();
      const fb = document.getElementById(`feedback-${outputId}`);
      if (!res.ok) {
        if (fb) {
          fb.textContent = data.error || "\u8BC4\u5206\u63D0\u4EA4\u5931\u8D25";
          fb.className = "judge-feedback score-1";
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (fb) {
        fb.textContent = isSelection ? `\u9009\u533A ${score}/7: ${data.analysis}` : data.analysis;
        fb.className = `judge-feedback score-${score}`;
      }
      if (isSelection) hideSelectionJudgeBar();
      console.log(`[MOMOKA] \u8BC4\u5206: ${score}/7 \u2014 ${data.label} \u2014 ${data.analysis}`);
      if (data.next_tool_calls && data.next_tool_calls.length > 0) {
        for (const tc of data.next_tool_calls) {
          addToolLog(tc.tool, tc.args, tc.result);
        }
      }
      if (data.next_response) {
        addMessage("agent", data.next_response, data.next_output_id, true);
      }
      if (data.next_skill_reasons) {
        updateSkillTags(data.next_skill_reasons);
      }
    } catch (err) {
      hadError = true;
      console.error("\u8BC4\u5206\u63D0\u4EA4\u5931\u8D25:", err);
      setStatus("error", "\u9519\u8BEF");
    } finally {
      isProcessing = false;
      if (!hadError) setStatus("idle", "\u5C31\u7EEA");
    }
  }
  function addToolLog(toolName, args, result) {
    const container = document.getElementById("toolLogs");
    const placeholder = container.querySelector(".tool-log-empty");
    if (placeholder) placeholder.remove();
    const card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML = `
        <div class="tool-card-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
            <span class="tool-card-name">[TOOL] ${escapeHtml(toolName)}</span>
            <span class="tool-card-time">${formatTime()}</span>
        </div>
        <div class="tool-card-body">
            <div class="tool-card-args"><strong>\u53C2\u6570:</strong> ${escapeHtml(typeof args === "string" ? args : JSON.stringify(args))}</div>
            <div class="tool-card-result">${escapeHtml(result || "")}</div>
        </div>
    `;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }
  async function refreshApprovals() {
    const panel = document.getElementById("approvalPanel");
    if (!panel || !session?.folder_path) return;
    panel.replaceChildren();
    try {
      const data = await apiGet(`/approvals?work_dir=${encodeURIComponent(session.folder_path)}`);
      const approvals = (data.approvals || []).filter((item) => item.status === "pending");
      if (approvals.length === 0) {
        const empty = document.createElement("span");
        empty.style.cssText = "color:#999;font-size:11px";
        empty.textContent = "\u6682\u65E0\u5F85\u5BA1\u6279\u64CD\u4F5C";
        panel.appendChild(empty);
        return;
      }
      for (const approval of approvals) {
        const card = document.createElement("div");
        card.className = "tool-card";
        const title = document.createElement("div");
        title.className = "tool-card-name";
        title.textContent = `[\u5BA1\u6279] ${approval.toolName || approval.tool_name || "run_shell"}`;
        const command = document.createElement("div");
        command.className = "tool-card-args";
        command.textContent = String(approval.args?.command || approval.args?.command_text || "");
        const workspaces = document.createElement("div");
        workspaces.className = "tool-card-args";
        const sourceWorkspace = approval.workspace || approval.sourceWorkspace || "";
        const targetWorkspace = approval.targetWorkspace || approval.target_workspace || sourceWorkspace;
        workspaces.textContent = sourceWorkspace === targetWorkspace ? `\u5DE5\u4F5C\u533A: ${sourceWorkspace}` : `\u6765\u6E90: ${sourceWorkspace} \u2192 \u76EE\u6807: ${targetWorkspace}`;
        const actions = document.createElement("div");
        const approve = document.createElement("button");
        approve.type = "button";
        approve.textContent = "\u6279\u51C6\u5E76\u6267\u884C";
        approve.addEventListener("click", () => decideApproval(approval.id, "approved"));
        const reject = document.createElement("button");
        reject.type = "button";
        reject.textContent = "\u62D2\u7EDD";
        reject.style.marginLeft = "4px";
        reject.addEventListener("click", () => decideApproval(approval.id, "rejected"));
        actions.append(approve, reject);
        card.append(title, command, workspaces, actions);
        panel.appendChild(card);
      }
    } catch (err) {
      const error = document.createElement("span");
      error.style.cssText = "color:#c33;font-size:11px";
      error.textContent = `\u5BA1\u6279\u5217\u8868\u52A0\u8F7D\u5931\u8D25: ${err.message}`;
      panel.appendChild(error);
    }
  }
  async function decideApproval(approvalId, decision) {
    const operatorInput = document.getElementById("approvalOperator");
    const operator = operatorInput ? operatorInput.value.trim() : "";
    if (!operator) {
      if (operatorInput) operatorInput.focus();
      setStatus("error", "\u8BF7\u8F93\u5165\u5BA1\u6279\u64CD\u4F5C\u8005");
      return;
    }
    try {
      const data = await apiPost(`/approvals/${encodeURIComponent(approvalId)}/decision`, {
        work_dir: session.folder_path,
        decision,
        operator
      });
      if (data.event) {
        renderApprovalExecutionEvent(data.event);
      }
      setStatus("idle", decision === "approved" ? data.event ? "\u6267\u884C\u7ED3\u679C\u5DF2\u8FD4\u56DE" : "\u5DF2\u6279\u51C6\u5E76\u6267\u884C" : "\u5DF2\u62D2\u7EDD\u64CD\u4F5C");
      await refreshApprovals();
    } catch (err) {
      setStatus("error", `\u5BA1\u6279\u5931\u8D25: ${err.message}`);
    }
  }
  function renderApprovalExecutionEvent(event) {
    if (event.sessionId && event.sessionId !== sessionId) return;
    addToolLog(event.toolName || "approved_tool", event.args || {}, event.result || "");
    const messageId = event.messageId || `approval_execution_${event.approvalId || uid("evt")}`;
    if (!loadedMessageIds.has(messageId)) {
      addMessage("agent", event.message || `\u5DF2\u6267\u884C\u6279\u51C6\u7684 ${event.toolName || "\u5DE5\u5177"}\u3002`, messageId, false);
      loadedMessageIds.add(messageId);
    }
  }
  function updateSkillTags(skills) {
    const container = document.getElementById("skillTags");
    const indicator = document.getElementById("skill-indicator");
    if (!skills || skills.length === 0) {
      container.innerHTML = '<span style="color:#999;font-size:11px">\u6682\u65E0</span>';
      if (indicator) indicator.textContent = "";
      return;
    }
    const normalized = typeof skills[0] === "string" ? skills.map((name) => ({ name, reasons: [] })) : skills;
    container.innerHTML = normalized.map((s) => {
      const name = s.name || "";
      const reasons = (s.reasons || []).slice(0, 3).join(" \xB7 ");
      const score = typeof s.score === "number" ? `score:${s.score}` : "";
      const title = [reasons, score].filter(Boolean).join(" | ");
      return `<span class="skill-tag" title="${escapeHtml(title)}">${escapeHtml(name)}</span>`;
    }).join("");
    if (indicator) {
      indicator.textContent = `\u6280\u80FD: ${normalized.map((s) => s.name).join(", ")}`;
    }
  }
  function setStatus(state, text) {
    const indicator = document.getElementById("status-indicator");
    if (!indicator) return;
    const dots = { idle: "idle", thinking: "thinking", error: "error" };
    indicator.innerHTML = `<span class="status-dot ${dots[state] || "idle"}"></span>${text}`;
  }
  function showPageError(msg) {
    const container = document.getElementById("chatMessages") || document.querySelector(".chat-main");
    if (container) {
      container.innerHTML = `<div style="padding:40px;text-align:center;color:#c33">${escapeHtml(msg)}</div>`;
    }
  }
  function goBack() {
    window.location.href = "index.html";
  }
  function handleKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
  function clearChatDisplay() {
    const container = document.getElementById("chatMessages");
    container.innerHTML = `
        <div class="chat-message agent" data-msg-id="welcome">
            <div class="msg-label">MOMOKA</div>
            <div class="msg-bubble">\u5DF2\u6E05\u7A7A\u663E\u793A\u3002\u5386\u53F2\u6D88\u606F\u4FDD\u7559\u3002\u7EE7\u7EED\u5BF9\u8BDD\uFF1F</div>
        </div>
    `;
    document.getElementById("toolLogs").innerHTML = '<div class="tool-log-empty">\u7B49\u5F85\u5DE5\u5177\u8C03\u7528...</div>';
    updateSkillTags([]);
  }
  Object.assign(window, {
    initChat,
    renderSessionHeader,
    loadMessages,
    sendMessage,
    sendGoalAsFirstMessage,
    addMessage,
    scrollToBottom,
    renderJudgeBar,
    selectJudgeScore,
    sendJudgeByBar,
    ensureSelectionJudgeBar,
    hideSelectionJudgeBar,
    showSelectionJudgeBar,
    sendJudge,
    addToolLog,
    renderApprovalExecutionEvent,
    refreshApprovals,
    decideApproval,
    updateSkillTags,
    setStatus,
    showPageError,
    goBack,
    handleKeydown,
    clearChatDisplay,
    stopStreaming
  });
})();
