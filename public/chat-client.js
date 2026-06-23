'use strict';

(function () {
  const messagesArea = document.getElementById('messages-area');
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

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
      body: JSON.stringify({ message: text, clarifications }),
    })
      .then(r => r.json())
      .then(data => {
        typingEl.remove();
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

    const confClass = `confidence confidence-${data.confidence_level || 'low'}`;
    const confBadge = data.off_topic ? '' : `<span class="${confClass}">${data.confidence_level || 'low'} confidence</span>`;

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
