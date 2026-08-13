/**
 * MOMOKA 聊天页 — 会话级对话界面
 */

let sessionId = '';
let session = null;
let lastOutputId = '';
let isProcessing = false;
let loadedMessageIds = new Set();
let selectionJudge = {
    outputId: '',
    text: '',
    bubble: null,
};

// ── 初始化 ──
document.addEventListener('DOMContentLoaded', initChat);

async function initChat() {
    // 从 URL 获取 session_id
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get('id');
    if (!sessionId) {
        showPageError('缺少会话 ID，请从会话列表进入。');
        return;
    }

    try {
        const data = await apiGet(`/sessions/${sessionId}`);
        session = data.session;
        renderSessionHeader();
        await loadMessages();
        await refreshApprovals();

        // 如果会话没有消息，自动将核心目标作为首条消息发给 Agent
        if (session.message_count === 0) {
            await sendGoalAsFirstMessage();
        }
    } catch (err) {
        showPageError('加载会话失败: ' + err.message);
    }
}

// ── 会话头部 ──
function renderSessionHeader() {
    document.getElementById('sessionName').textContent = session.name || '未命名会话';
    document.getElementById('sessionGoal').textContent = session.goal || '';
    const folderDisplay = session.folder_path ? session.folder_path.replace(/\\/g, '/') : '';
    document.getElementById('sessionFolder').textContent = folderDisplay;
    document.getElementById('sessionFolder').title = folderDisplay;
}

// ── 加载历史消息 ──
async function loadMessages() {
    try {
        const data = await apiGet(`/sessions/${sessionId}/messages`);
        const messages = data.messages || [];
        loadedMessageIds = new Set(messages.map(m => m.id));

        for (const msg of messages) {
            if (msg.eventType === 'approval_execution') {
                addToolLog(msg.toolName || 'approved_tool', msg.toolArgs || {}, msg.toolResult || msg.content);
            }
            if (msg.role === 'user') {
                addMessage('user', msg.content, msg.id, false);
            } else {
                addMessage('agent', msg.content, msg.output_id || msg.id, Boolean(msg.output_id), msg.matched_skills, msg.tool_calls);
            }
        }
        scrollToBottom();
    } catch (err) {
        console.warn('加载历史消息失败:', err);
    }
}

// ── 发送消息 ──
async function sendMessage() {
    if (isProcessing) return;

    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message) return;

    isProcessing = true;
    input.value = '';
    input.disabled = true;
    document.getElementById('sendBtn').disabled = true;
    setStatus('thinking', '思考中...');

    addMessage('user', message, uid('msg'), false);

    try {
        await runStreamingChat({
            session_id: sessionId,
            message: message,
            output_id: uid('out'),
            topic: session ? session.goal : message,
        });
    } catch (err) {
        // 错误已在流式气泡中渲染
    } finally {
        isProcessing = false;
        input.disabled = false;
        document.getElementById('sendBtn').disabled = false;
        input.focus();
    }
}

// ── 自动将会话核心目标作为首条消息发送 ──
async function sendGoalAsFirstMessage() {
    if (!session || !session.goal || isProcessing) return;

    const goal = session.goal;
    isProcessing = true;
    setStatus('thinking', '思考中...');

    addMessage('user', goal, uid('msg'), false);

    try {
        await runStreamingChat({
            session_id: sessionId,
            message: goal,
            output_id: uid('out'),
            topic: goal,
        });
    } catch (err) {
        // 错误已在流式气泡中渲染
    } finally {
        isProcessing = false;
    }
}

// ── 流式对话（SSE） ──
const STREAM_TIMEOUT_MS = 180000;
let activeAbort = null;

async function runStreamingChat(payload) {
    const outId = payload.output_id || uid('out');
    const holder = createStreamingAgentBubble(outId);
    lastOutputId = outId;

    activeAbort = new AbortController();
    const timeoutTimer = setTimeout(() => {
        if (activeAbort) activeAbort.abort();
    }, STREAM_TIMEOUT_MS);
    showStopButton(true);

    let fullText = '';
    let rafPending = false;
    let lastToolCard = null;

    const flush = () => {
        rafPending = false;
        holder.bubble.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
        scrollToBottom();
    };

    try {
        const res = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, payload, { stream: true })),
            signal: activeAbort.signal,
        });
        if (!res.ok || !res.body) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalData = null;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                for (const line of frame.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    let event;
                    try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
                    if (event.type === 'token') {
                        fullText += event.text || '';
                        if (!rafPending) {
                            rafPending = true;
                            requestAnimationFrame(flush);
                        }
                    } else if (event.type === 'tool_start') {
                        lastToolCard = createToolCard(event.name, event.args, '执行中...');
                    } else if (event.type === 'tool_result') {
                        if (lastToolCard) {
                            updateToolCardResult(lastToolCard, event.result);
                            lastToolCard = null;
                        } else {
                            addToolLog(event.name, event.args || {}, event.result);
                        }
                    } else if (event.type === 'approval_requested') {
                        setStatus('thinking', '等待审批...');
                        refreshApprovals();
                    } else if (event.type === 'done') {
                        finalData = event;
                    } else if (event.type === 'error') {
                        throw new Error(event.error || '服务器错误');
                    }
                }
            }
        }

        if (rafPending) requestAnimationFrame(flush);
        if (!finalData) throw new Error('连接意外结束（未收到完成事件）');

        const data = finalData;
        if (data.session_id) {
            session.message_count = (session.message_count || 0) + 1;
            session.last_message_at = new Date().toISOString();
        }
        const skillPayload = data.skill_reasons || data.matched_skills;
        updateSkillTags(skillPayload);
        holder.bubble.insertAdjacentHTML('afterend', renderJudgeBar(data.output_id || outId));
        await refreshApprovals();
        setStatus('idle', '就绪');
        return data;
    } catch (err) {
        const stopped = activeAbort && activeAbort.signal.aborted;
        holder.bubble.innerHTML = escapeHtml(fullText) +
            `<div style="color:#c33;font-size:11px;margin-top:4px">${stopped ? '已停止' : `错误: ${escapeHtml(err.message)}`}</div>`;
        setStatus('error', stopped ? '已停止' : '错误');
        throw err;
    } finally {
        clearTimeout(timeoutTimer);
        showStopButton(false);
        activeAbort = null;
    }
}

function createStreamingAgentBubble(outId) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'chat-message agent';
    div.setAttribute('data-msg-id', outId);
    div.innerHTML = '<div class="msg-label">MOMOKA</div><div class="msg-bubble"></div>';
    container.appendChild(div);
    scrollToBottom();
    return { bubble: div.querySelector('.msg-bubble') };
}

function createToolCard(toolName, args, resultText) {
    const container = document.getElementById('toolLogs');
    const placeholder = container.querySelector('.tool-log-empty');
    if (placeholder) placeholder.remove();
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
        <div class="tool-card-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
            <span class="tool-card-name">[TOOL] ${escapeHtml(toolName)}</span>
            <span class="tool-card-time">${formatTime()}</span>
        </div>
        <div class="tool-card-body">
            <div class="tool-card-args"><strong>参数:</strong> ${escapeHtml(typeof args === 'string' ? args : JSON.stringify(args))}</div>
            <div class="tool-card-result">${escapeHtml(resultText || '')}</div>
        </div>
    `;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
    return card;
}

function updateToolCardResult(card, resultText) {
    const resultEl = card.querySelector('.tool-card-result');
    if (resultEl) resultEl.textContent = resultText || '';
    const container = document.getElementById('toolLogs');
    container.scrollTop = container.scrollHeight;
}

function stopStreaming() {
    if (activeAbort) activeAbort.abort();
}

function showStopButton(visible) {
    const btn = document.getElementById('stopBtn');
    if (btn) btn.style.display = visible ? '' : 'none';
}

// ── 添加消息 ──
function addMessage(role, text, msgId, showJudge, matchedSkills, toolCalls) {
    const container = document.getElementById('chatMessages');
    if (!msgId) msgId = uid('msg');

    if (role === 'agent') {
        lastOutputId = msgId;
    }

    const div = document.createElement('div');
    div.className = `chat-message ${role}`;
    div.setAttribute('data-msg-id', msgId);

    const label = role === 'user' ? '你' : 'MOMOKA';

    let html = `<div class="msg-label">${label}</div>`;
    html += `<div class="msg-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;

    if (role === 'agent' && showJudge) {
        html += renderJudgeBar(msgId);
    }

    div.innerHTML = html;
    container.appendChild(div);
    scrollToBottom();
}

function scrollToBottom() {
    const container = document.getElementById('chatMessages');
    container.scrollTop = container.scrollHeight;
}

// ── 评分栏 ──
function renderJudgeBar(outputId) {
    const labels = [
        { score: 1, title: '强烈反对' },
        { score: 2, title: '反对' },
        { score: 3, title: '不太赞同' },
        { score: 4, cls: 'neutral', title: '中立' },
        { score: 5, title: '有点赞同' },
        { score: 6, title: '赞同' },
        { score: 7, title: '强烈赞同' },
    ];

    let html = `<div class="judge-bar" data-output-id="${outputId}">`;
    html += '<span class="judge-label">评分:</span>';
    for (const l of labels) {
        html += `<button class="judge-btn ${l.cls || ''}" onclick="selectJudgeScore(this,'${outputId}')" title="${l.title}">${l.score}</button>`;
    }
    html += `<input class="judge-comment" id="comment-${outputId}" type="text" maxlength="500" placeholder="批注(选填)" aria-label="文字批注">`;
    html += `<button class="judge-send-btn" onclick="sendJudgeByBar('${outputId}')" title="提交评分与批注">发送</button>`;
    html += `<span class="judge-feedback" id="feedback-${outputId}"></span>`;
    html += '</div>';
    return html;
}

function selectJudgeScore(btn, outputId) {
    const bar = btn.closest('.judge-bar');
    if (!bar) return;
    bar.querySelectorAll('.judge-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

function sendJudgeByBar(outputId) {
    const bar = document.querySelector(`.judge-bar[data-output-id="${outputId}"]`);
    if (!bar) return;
    const activeBtn = bar.querySelector('.judge-btn.active');
    if (!activeBtn) {
        const fb = document.getElementById(`feedback-${outputId}`);
        if (fb) {
            fb.textContent = '请先选择一个评分';
            fb.className = 'judge-feedback score-3';
        }
        return;
    }
    const score = parseInt(activeBtn.textContent);
    sendJudge(outputId, score, 'block');
}

function ensureSelectionJudgeBar() {
    let popover = document.getElementById('selectionJudgeBar');
    if (popover) return popover;

    popover = document.createElement('div');
    popover.id = 'selectionJudgeBar';
    popover.className = 'selection-judge-popover';
    popover.innerHTML = `
        <div class="selection-score-row">
            <span class="judge-label">评分:</span>
            <button class="judge-btn" data-score="1" title="强烈反对">1</button>
            <button class="judge-btn" data-score="2" title="反对">2</button>
            <button class="judge-btn" data-score="3" title="不太赞同">3</button>
            <button class="judge-btn neutral" data-score="4" title="中立">4</button>
            <button class="judge-btn" data-score="5" title="有点赞同">5</button>
            <button class="judge-btn" data-score="6" title="赞同">6</button>
            <button class="judge-btn" data-score="7" title="强烈赞同">7</button>
        </div>
        <div class="selection-input-row">
            <input class="judge-comment selection-comment" id="selectionJudgeComment" type="text" maxlength="500" placeholder="批注(选填)" aria-label="选中文字批注">
            <button class="judge-send-btn selection-send-btn" title="追加此条划词评分与批注">设置</button>
        </div>
        <span class="judge-feedback" id="selectionJudgeFeedback"></span>
    `;

    popover.addEventListener('click', function(e) {
        const btn = e.target.closest('.judge-btn[data-score]');
        if (!btn) return;
        popover.querySelectorAll('.judge-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });

    // 选区发送按钮单独处理
    popover.addEventListener('click', function(e) {
        const sendBtn = e.target.closest('.selection-send-btn');
        if (!sendBtn) return;
        const activeBtn = popover.querySelector('.judge-btn.active');
        if (!activeBtn) {
            const fb = document.getElementById('selectionJudgeFeedback');
            if (fb) { fb.textContent = '请先选择一个评分'; fb.className = 'judge-feedback score-3'; }
            return;
        }
        const score = Number(activeBtn.dataset.score);
        sendJudge(selectionJudge.outputId, score, 'selection');
    });

    document.body.appendChild(popover);
    return popover;
}

function hideSelectionJudgeBar() {
    const popover = document.getElementById('selectionJudgeBar');
    if (popover) popover.classList.remove('visible');
}

function showSelectionJudgeBar(rect, bubble, selectedText) {
    const message = bubble.closest('.chat-message');
    const outputId = message ? message.getAttribute('data-msg-id') : '';
    if (!outputId || !message.querySelector('.judge-bar')) {
        hideSelectionJudgeBar();
        return;
    }

    selectionJudge = {
        outputId: outputId,
        text: selectedText,
        bubble: bubble,
    };

    const popover = ensureSelectionJudgeBar();
    const comment = popover.querySelector('#selectionJudgeComment');
    if (comment) comment.value = '';
    popover.classList.add('visible');

    const top = Math.max(8, rect.top + window.scrollY - popover.offsetHeight - 8);
    const center = rect.left + window.scrollX + rect.width / 2;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - popover.offsetWidth - 8;
    const left = Math.max(8 + window.scrollX, Math.min(maxLeft, center - popover.offsetWidth / 2));
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
}

// ── 文本划选 ──
document.addEventListener('mouseup', function(e) {
    if (e.target.closest('#selectionJudgeBar')) return;
    const bubble = e.target.closest('.chat-message.agent .msg-bubble');
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

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideSelectionJudgeBar();
});

document.addEventListener('scroll', hideSelectionJudgeBar, true);

// ── 评分 ──
async function sendJudge(outputId, score, scope) {
    if (isProcessing) return;

    const bar = document.querySelector(`.judge-bar[data-output-id="${outputId}"]`);
    const isSelection = scope === 'selection';
    if (!bar && !isSelection) return;

    isProcessing = true;
    let selectedText = '';
    let comment = '';
    if (isSelection) {
        selectedText = selectionJudge.outputId === outputId ? selectionJudge.text : '';
        const selectionComment = document.getElementById('selectionJudgeComment');
        comment = selectionComment ? selectionComment.value.trim() : '';
    } else {
        // 评分按钮的 active 状态已由 selectJudgeScore 设置，此处不再重置
        const commentInput = document.getElementById(`comment-${outputId}`);
        comment = commentInput ? commentInput.value.trim() : '';
    }

    const labelMap = {1:'强烈反对',2:'反对',3:'不太赞同',4:'中立',5:'有点赞同',6:'赞同',7:'强烈赞同'};
    const label = labelMap[score] || '未知';
    console.log('[MOMOKA] 提交批注账本事件:', {
        output_id: outputId,
        score,
        label,
        context: selectedText,
        comment,
        continue: !isSelection,
    });

    const shouldContinue = !isSelection; // 划词只 append，块级评分才续猜
    let hadError = false;
    try {
        if (shouldContinue) setStatus('thinking', '续猜中...');
        const res = await fetch(`${API_BASE}/judge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                output_id: outputId,
                score: score,
                context: selectedText,
                comment: comment,
                continue: shouldContinue,
            }),
        });

        const data = await res.json();
        const fb = document.getElementById(`feedback-${outputId}`);

        if (!res.ok) {
            if (fb) {
                fb.textContent = data.error || '评分提交失败';
                fb.className = 'judge-feedback score-1';
            }
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        if (fb) {
            fb.textContent = isSelection ? `选区 ${score}/7: ${data.analysis}` : data.analysis;
            fb.className = `judge-feedback score-${score}`;
        }
        if (isSelection) hideSelectionJudgeBar();

        console.log(`[MOMOKA] 评分: ${score}/7 — ${data.label} — ${data.analysis}`);

        if (data.next_tool_calls && data.next_tool_calls.length > 0) {
            for (const tc of data.next_tool_calls) {
                addToolLog(tc.tool, tc.args, tc.result);
            }
        }

        if (data.next_response) {
            addMessage('agent', data.next_response, data.next_output_id, true);
        }

        if (data.next_skill_reasons) {
            updateSkillTags(data.next_skill_reasons);
        }
    } catch (err) {
        hadError = true;
        console.error('评分提交失败:', err);
        setStatus('error', '错误');
    } finally {
        isProcessing = false;
        if (!hadError) setStatus('idle', '就绪');
    }
}

// ── 工具日志 ──
function addToolLog(toolName, args, result) {
    const container = document.getElementById('toolLogs');
    const placeholder = container.querySelector('.tool-log-empty');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
        <div class="tool-card-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
            <span class="tool-card-name">[TOOL] ${escapeHtml(toolName)}</span>
            <span class="tool-card-time">${formatTime()}</span>
        </div>
        <div class="tool-card-body">
            <div class="tool-card-args"><strong>参数:</strong> ${escapeHtml(typeof args === 'string' ? args : JSON.stringify(args))}</div>
            <div class="tool-card-result">${escapeHtml(result || '')}</div>
        </div>
    `;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
}

// ── 人工审批 ──
async function refreshApprovals() {
    const panel = document.getElementById('approvalPanel');
    if (!panel || !session?.folder_path) return;
    panel.replaceChildren();
    try {
        const data = await apiGet(`/approvals?work_dir=${encodeURIComponent(session.folder_path)}`);
        const approvals = (data.approvals || []).filter(item => item.status === 'pending');
        if (approvals.length === 0) {
            const empty = document.createElement('span');
            empty.style.cssText = 'color:#999;font-size:11px';
            empty.textContent = '暂无待审批操作';
            panel.appendChild(empty);
            return;
        }
        for (const approval of approvals) {
            const card = document.createElement('div');
            card.className = 'tool-card';
            card.setAttribute('data-approval-id', approval.id);
            const title = document.createElement('div');
            title.className = 'tool-card-name';
            title.textContent = `[审批] ${approval.toolName || approval.tool_name || 'run_shell'}`;
            const command = document.createElement('div');
            command.className = 'tool-card-args';
            command.textContent = String(approval.args?.command || approval.args?.command_text || '');
            const workspaces = document.createElement('div');
            workspaces.className = 'tool-card-args';
            const sourceWorkspace = approval.workspace || approval.sourceWorkspace || '';
            const targetWorkspace = approval.targetWorkspace || approval.target_workspace || sourceWorkspace;
            workspaces.textContent = sourceWorkspace === targetWorkspace
                ? `工作区: ${sourceWorkspace}`
                : `来源: ${sourceWorkspace} → 目标: ${targetWorkspace}`;
            const actions = document.createElement('div');
            const approve = document.createElement('button');
            approve.type = 'button';
            approve.textContent = '批准并执行';
            approve.addEventListener('click', () => decideApproval(approval.id, 'approved'));
            const reject = document.createElement('button');
            reject.type = 'button';
            reject.textContent = '拒绝';
            reject.style.marginLeft = '4px';
            reject.addEventListener('click', () => decideApproval(approval.id, 'rejected'));
            actions.append(approve, reject);
            card.append(title, command, workspaces, actions);
            panel.appendChild(card);
        }
    } catch (err) {
        const error = document.createElement('span');
        error.style.cssText = 'color:#c33;font-size:11px';
        error.textContent = `审批列表加载失败: ${err.message}`;
        panel.appendChild(error);
    }
}

async function decideApproval(approvalId, decision) {
    const operatorInput = document.getElementById('approvalOperator');
    const operator = operatorInput ? operatorInput.value.trim() : '';
    if (!operator) {
        if (operatorInput) operatorInput.focus();
        setStatus('error', '请输入审批操作者');
        return;
    }
    // 防重复：点击后立即禁用该卡片按钮，避免重复提交导致“已决定”冲突
    const card = document.querySelector(`.tool-card[data-approval-id="${approvalId}"]`);
    if (card) {
        card.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
    }
    setStatus('thinking', '审批处理中...');
    try {
        const data = await apiPost(`/approvals/${encodeURIComponent(approvalId)}/decision`, {
            work_dir: session.folder_path,
            decision,
            operator,
        });
        if (data.alreadyDecided) {
            setStatus('idle', '该审批已处理过');
        } else {
            if (data.event) {
                renderApprovalExecutionEvent(data.event);
            }
            setStatus('idle', decision === 'approved'
                ? (data.event ? '执行结果已返回' : '已批准并执行')
                : '已拒绝操作');
        }
    } catch (err) {
        setStatus('error', `审批失败: ${err.message}`);
    } finally {
        // 无论成败都同步面板：已决审批不再显示，避免残留卡片继续点击
        await refreshApprovals();
    }
}

function renderApprovalExecutionEvent(event) {
    if (event.sessionId && event.sessionId !== sessionId) return;
    addToolLog(event.toolName || 'approved_tool', event.args || {}, event.result || '');
    const messageId = event.messageId || `approval_execution_${event.approvalId || uid('evt')}`;
    if (!loadedMessageIds.has(messageId)) {
        addMessage('agent', event.message || `已执行批准的 ${event.toolName || '工具'}。`, messageId, false);
        loadedMessageIds.add(messageId);
    }
}

// ── 技能标签 ──
function updateSkillTags(skills) {
    const container = document.getElementById('skillTags');
    const indicator = document.getElementById('skill-indicator');
    if (!skills || skills.length === 0) {
        container.innerHTML = '<span style="color:#999;font-size:11px">暂无</span>';
        if (indicator) indicator.textContent = '';
        return;
    }
    const normalized = typeof skills[0] === 'string'
        ? skills.map(name => ({ name, reasons: [] }))
        : skills;
    container.innerHTML = normalized.map(s => {
        const name = s.name || '';
        const reasons = (s.reasons || []).slice(0, 3).join(' · ');
        const score = typeof s.score === 'number' ? `score:${s.score}` : '';
        const title = [reasons, score].filter(Boolean).join(' | ');
        return `<span class="skill-tag" title="${escapeHtml(title)}">${escapeHtml(name)}</span>`;
    }).join('');
    if (indicator) {
        indicator.textContent = `技能: ${normalized.map(s => s.name).join(', ')}`;
    }
}

// ── 状态指示 ──
function setStatus(state, text) {
    const indicator = document.getElementById('status-indicator');
    if (!indicator) return;
    const dots = { idle: 'idle', thinking: 'thinking', error: 'error' };
    indicator.innerHTML = `<span class="status-dot ${dots[state] || 'idle'}"></span>${text}`;
}

// ── 错误页 ──
function showPageError(msg) {
    const container = document.getElementById('chatMessages') || document.querySelector('.chat-main');
    if (container) {
        container.innerHTML = `<div style="padding:40px;text-align:center;color:#c33">${escapeHtml(msg)}</div>`;
    }
}

// ── 快捷操作 ──
function goBack() {
    window.location.href = 'index.html';
}

function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

// ── 清空会话（仅清空界面显示，不删除历史） ──
function clearChatDisplay() {
    const container = document.getElementById('chatMessages');
    container.innerHTML = `
        <div class="chat-message agent" data-msg-id="welcome">
            <div class="msg-label">MOMOKA</div>
            <div class="msg-bubble">已清空显示。历史消息保留。继续对话？</div>
        </div>
    `;
    document.getElementById('toolLogs').innerHTML = '<div class="tool-log-empty">等待工具调用...</div>';
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
    stopStreaming,
});
