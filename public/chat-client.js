'use strict';

(function () {
  const messagesArea = document.getElementById('messages-area');
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  // The chat this page is writing to. Empty until the first message of a brand-new
  // chat is sent, at which point the server returns the new id and we adopt it.
  let sessionId = window.__SESSION_ID__ || null;

  // Auto-grow textarea
  input.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
  });

  // Send on Enter (Shift+Enter for newline)
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFromInput();
    }
  });

  sendBtn.addEventListener('click', sendFromInput);

  // ── Sidebar chat actions (pin / delete) ───────────────────────────────────
  // Delegated so it also covers chats injected after a new conversation starts.
  const sidebar = document.querySelector('.chat-sidebar');
  if (sidebar) {
    sidebar.addEventListener('click', function (e) {
      const pinBtn = e.target.closest('.pin-btn');
      const delBtn = e.target.closest('.delete-btn');
      if (!pinBtn && !delBtn) return;
      e.preventDefault();
      const item = (pinBtn || delBtn).closest('.session-item');
      const id = item && item.dataset.id;
      if (!id) return;

      if (pinBtn) {
        fetch('/api/chat/session/' + id + '/pin', { method: 'POST' })
          .then(r => r.json())
          .then(() => location.reload())   // reload re-sorts pinned-first, keeps current chat
          .catch(() => {});
      } else {
        if (!confirm('Delete this chat? This cannot be undone.')) return;
        fetch('/api/chat/session/' + id, { method: 'DELETE' })
          .then(r => r.json())
          .then(() => {
            // Leaving the chat you're viewing → go to the most recent remaining one.
            if (id === sessionId) window.location.href = '/chat';
            else location.reload();
          })
          .catch(() => {});
      }
    });
  }

  function sendFromInput() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    appendUserMessage(text);
    postMessage(text, []);
  }

  // Core request. `clarifications` is [] on a first ask, or the owner's triage
  // answers on the follow-up round.
  function postMessage(text, clarifications) {
    sendBtn.disabled = true;
    const typingEl = appendTypingIndicator();
    scrollToBottom();

    fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, clarifications, session_id: sessionId }),
    })
      .then(r => r.json())
      .then(data => {
        typingEl.remove();
        // Adopt the chat id the server assigned (first message of a new chat),
        // and reflect it in the URL so a refresh stays in the same chat.
        if (data.session_id && data.session_id !== sessionId) {
          sessionId = data.session_id;
          try { history.replaceState(null, '', '/chat?session=' + sessionId); } catch (e) { /* noop */ }
          ensureSidebarEntry(sessionId, data.session_title || sidebarTitle(text));
        }
        if (data.error) {
          appendErrorMessage(data.error);
        } else if (data.needs_clarification) {
          appendClarification(data.original_message || text, data.clarifying_questions || []);
        } else {
          appendAIMessage(data);
        }
        scrollToBottom();
      })
      .catch(() => {
        typingEl.remove();
        appendErrorMessage('Network error. Please check your connection and try again.');
        scrollToBottom();
      })
      .finally(() => {
        sendBtn.disabled = false;
        input.focus();
      });
  }

  function appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'message user-message';
    el.innerHTML = `
      <div class="bubble-wrap">
        <div class="bubble">${escHtml(text)}</div>
        <div class="meta">${fmtTime(new Date())}</div>
      </div>`;
    messagesArea.appendChild(el);
  }

  function appendTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'message ai-message typing-indicator';
    el.innerHTML = `
      <div class="ai-avatar">W</div>
      <div class="bubble-wrap">
        <div class="bubble">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>
      </div>`;
    messagesArea.appendChild(el);
    return el;
  }

  // ── Clarifying-question card ──────────────────────────────────────────────
  // Renders Whoof AI's triage questions as selectable option chips plus an
  // optional free-text field per question (AskUserQuestion-style), then a submit.
  function appendClarification(originalMessage, questions) {
    const el = document.createElement('div');
    el.className = 'message ai-message';

    const intro = `Before I answer, a few quick questions so I can tell whether this is something to watch at home or worth a vet visit:`;

    const qBlocks = questions.map((q, qi) => {
      const opts = (q.options || []).map((opt, oi) => `
        <button type="button" class="clarify-option" data-qi="${qi}" data-val="${escHtml(opt)}">${escHtml(opt)}</button>
      `).join('');
      const textField = q.allow_text !== false ? `
        <input type="text" class="clarify-text" data-qi="${qi}" placeholder="Or type your own answer…" />
      ` : '';
      return `
        <div class="clarify-question" data-qi="${qi}">
          <div class="clarify-q-text">${escHtml(q.question)}</div>
          <div class="clarify-options">${opts}</div>
          ${textField}
        </div>`;
    }).join('');

    el.innerHTML = `
      <div class="ai-avatar">W</div>
      <div class="bubble-wrap">
        <div class="bubble">
          <div class="clarify-intro">${escHtml(intro)}</div>
          <div class="clarify-card">
            ${qBlocks}
            <button type="button" class="btn btn-primary clarify-submit" disabled>Get Whoof AI's answer</button>
          </div>
        </div>
      </div>`;

    messagesArea.appendChild(el);

    const card = el.querySelector('.clarify-card');
    const submitBtn = card.querySelector('.clarify-submit');

    // Option chips — single-select per question; selecting clears that q's text field.
    card.querySelectorAll('.clarify-option').forEach(btn => {
      btn.addEventListener('click', function () {
        const qi = this.dataset.qi;
        card.querySelectorAll(`.clarify-option[data-qi="${qi}"]`).forEach(b => b.classList.remove('selected'));
        this.classList.add('selected');
        const txt = card.querySelector(`.clarify-text[data-qi="${qi}"]`);
        if (txt) txt.value = '';
        refreshSubmitState();
      });
    });

    // Free-text — typing clears any selected chip for that question.
    card.querySelectorAll('.clarify-text').forEach(txt => {
      txt.addEventListener('input', function () {
        const qi = this.dataset.qi;
        if (this.value.trim()) {
          card.querySelectorAll(`.clarify-option[data-qi="${qi}"]`).forEach(b => b.classList.remove('selected'));
        }
        refreshSubmitState();
      });
    });

    function collectAnswers() {
      return questions.map((q, qi) => {
        const txt = card.querySelector(`.clarify-text[data-qi="${qi}"]`);
        if (txt && txt.value.trim()) return { question: q.question, answer: txt.value.trim() };
        const sel = card.querySelector(`.clarify-option[data-qi="${qi}"].selected`);
        if (sel) return { question: q.question, answer: sel.dataset.val };
        return { question: q.question, answer: '' };
      });
    }

    function refreshSubmitState() {
      const answers = collectAnswers();
      submitBtn.disabled = answers.some(a => !a.answer);
    }

    submitBtn.addEventListener('click', function () {
      const answers = collectAnswers();
      if (answers.some(a => !a.answer)) return;

      // Lock the card so it reads as answered, and show the owner's choices.
      card.querySelectorAll('button, input').forEach(n => { n.disabled = true; });
      card.classList.add('answered');
      submitBtn.textContent = 'Sent';

      const summary = answers.map(a => `${a.question} ${a.answer}`).join(' · ');
      appendUserMessage(summary);

      postMessage(originalMessage, answers);
      scrollToBottom();
    });
  }

  function appendAIMessage(data) {
    const el = document.createElement('div');
    el.className = 'message ai-message' + (data.escalated ? ' emergency' : '');

    const emergencyBanner = data.escalated
      ? `<div class="emergency-banner">⚠️ URGENT — See a vet or emergency clinic now</div>`
      : '';

    const sourcesHtml = data.sources?.length
      ? `<details class="sources">
           <summary>Sources (${data.sources.length})</summary>
           <ul>${data.sources.map(s => {
             const loc = [s.source, s.section].filter(Boolean).map(escHtml).join(' › ');
             const pg = s.page_number ? ` (p.${s.page_number})` : '';
             return `<li><strong>${loc}</strong>${pg}${s.chunk_type && s.chunk_type !== 'body' ? ` [${escHtml(s.chunk_type)}]` : ''}</li>`;
           }).join('')}</ul>
         </details>`
      : '';

    // "General guidance" badge when the answer came from Claude's own knowledge
    // rather than the cited guideline documents.
    const fallbackBadge = (data.used_fallback && !data.off_topic && !data.escalated)
      ? `<span class="badge badge-general" title="Not from a cited guideline — Whoof AI's general veterinary knowledge">general guidance</span>`
      : '';

    // Confidence shows only on KB-grounded clinical answers — recall/decision/off-topic
    // replies send no confidence_level and should read as plain statements.
    const confBadge = data.confidence_level
      ? `<span class="confidence confidence-${data.confidence_level}">${data.confidence_level} confidence</span>`
      : '';

    el.innerHTML = `
      <div class="ai-avatar">W</div>
      <div class="bubble-wrap">
        ${emergencyBanner}
        <div class="bubble markdown-content"></div>
        ${sourcesHtml}
        <div class="meta">
          ${confBadge}
          ${fallbackBadge}
          ${fmtTime(new Date(data.created_at || Date.now()))}
        </div>
      </div>`;

    const bubbleEl = el.querySelector('.bubble');
    bubbleEl.innerHTML = marked.parse(data.answer || '');

    messagesArea.appendChild(el);
  }

  function appendErrorMessage(msg) {
    const el = document.createElement('div');
    el.className = 'message ai-message';
    el.innerHTML = `
      <div class="ai-avatar">W</div>
      <div class="bubble-wrap">
        <div class="bubble" style="color: var(--danger)">⚠️ ${escHtml(msg)}</div>
      </div>`;
    messagesArea.appendChild(el);
  }

  // Short title for the sidebar, mirroring the server's titleFromMessage().
  function sidebarTitle(text) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? clean.slice(0, 47).trimEnd() + '…' : clean;
  }

  const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14l-1.7-2.5a2 2 0 0 1-.3-1V5a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v8.5a2 2 0 0 1-.3 1L5 17z"></path></svg>';
  const TRASH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

  // Inject a freshly-created chat into the sidebar so it shows up without a reload.
  function ensureSidebarEntry(id, title) {
    const list = document.querySelector('.session-list');
    if (!list || list.querySelector(`.session-item[data-id="${id}"]`)) return;

    const empty = list.querySelector('.session-empty');
    if (empty) empty.remove();

    let label = list.querySelector('.session-list-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'session-list-label';
      label.textContent = 'Chats';
      list.prepend(label);
    }

    list.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));

    const item = document.createElement('div');
    item.className = 'session-item active';
    item.dataset.id = id;
    item.innerHTML =
      `<a href="/chat?session=${id}" class="session-link" title="${escHtml(title)}">${escHtml(title)}</a>` +
      '<div class="session-actions">' +
        `<button type="button" class="session-action pin-btn" title="Pin chat" aria-label="Pin chat">${PIN_SVG}</button>` +
        `<button type="button" class="session-action delete-btn" title="Delete chat" aria-label="Delete chat">${TRASH_SVG}</button>` +
      '</div>';
    label.after(item);
  }

  function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(date) {
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }
})();
