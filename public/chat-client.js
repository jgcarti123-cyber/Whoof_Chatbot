'use strict';

(function () {
  const messagesArea = document.getElementById('messages-area');
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  // The chat this page is writing to. Empty until the first message of a brand-new
  // chat is sent, at which point the server returns the new id and we adopt it.
  let sessionId = window.__SESSION_ID__ || null;
  const petName = window.__PET_NAME__ || 'your dog';

  // Leading slash-commands that force a response format. Mirrors the server's list
  // (routes/chat.js). Add more here to extend the slash menu + override behaviour.
  const FORMAT_COMMANDS = [
    { name: 'visualise', aliases: ['visualise', 'visualize'], modality: 'structured',
      hint: 'Lay the answer out as a structured card' },
  ];
  // Returns { modality, cleaned }: the forced modality (or null) and the message with a
  // leading command word stripped, so the bubble + stored question read naturally.
  function parseFormatCommand(text) {
    const m = (text || '').match(/^\/([a-z]+)\b[ \t]*/i);
    if (m) {
      const word = m[1].toLowerCase();
      const cmd = FORMAT_COMMANDS.find(c => c.aliases.indexOf(word) !== -1);
      if (cmd) return { modality: cmd.modality, cleaned: text.slice(m[0].length).trim() };
    }
    return { modality: null, cleaned: (text || '').trim() };
  }

  // Auto-grow textarea
  input.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
    updateSlashHint();
  });

  // Send on Enter (Shift+Enter for newline)
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFromInput();
    }
  });

  sendBtn.addEventListener('click', sendFromInput);

  // ── Slash-command hint ─────────────────────────────────────────────────────
  // Typing "/vis" surfaces a small menu suggesting /visualise, so the override is
  // discoverable. Purely additive — it never intercepts Enter or the send flow.
  // Anchor the hint to the centred composer row (not the full-width input-area), so it
  // sits directly above the input bar instead of floating off to the far left.
  const composerRow = document.querySelector('.input-row') || document.querySelector('.input-area');
  const slashHint = document.createElement('div');
  slashHint.className = 'slash-hint';
  slashHint.hidden = true;
  if (composerRow) composerRow.appendChild(slashHint);

  function hideSlashHint() {
    slashHint.hidden = true;
    slashHint.innerHTML = '';
  }

  // Bare "/visualise" sent with no request: keep the command in the box (caret at the
  // end) and prompt for detail rather than firing an empty command at the model. The
  // nudge clears itself as soon as they start typing (updateSlashHint runs on input).
  function showSlashNudge(raw) {
    const base = raw + ' ';
    input.value = base;
    input.focus();
    try { input.setSelectionRange(base.length, base.length); } catch (e) {}
    slashHint.innerHTML =
      '<div class="slash-hint-nudge">Add what you’d like laid out — e.g. ' +
      '<strong>/visualise a plan to teach Monkey to sit</strong></div>';
    slashHint.hidden = false;
  }

  // Show suggestions only while the whole input is a partial slash token ("/", "/v",
  // "/visu") — i.e. before any space, so it never covers a real question.
  function updateSlashHint() {
    const m = input.value.match(/^\/([a-z]*)$/i);
    if (!m) { hideSlashHint(); return; }
    const typed = m[1].toLowerCase();
    const matches = FORMAT_COMMANDS.filter(c => c.aliases.some(a => a.indexOf(typed) === 0));
    if (!matches.length) { hideSlashHint(); return; }
    slashHint.innerHTML = matches.map(c =>
      '<button type="button" class="slash-hint-item" data-insert="/' + c.name + ' ">' +
        '<span class="slash-hint-cmd">/' + escHtml(c.name) + '</span>' +
        '<span class="slash-hint-desc">' + escHtml(c.hint) + '</span>' +
      '</button>').join('');
    slashHint.hidden = false;
  }

  // mousedown (not click) so it fires before the input's blur tears the menu down.
  slashHint.addEventListener('mousedown', function (e) {
    const item = e.target.closest('.slash-hint-item');
    if (!item) return;
    e.preventDefault();
    input.value = item.getAttribute('data-insert');
    hideSlashHint();
    input.focus();
  });
  input.addEventListener('blur', function () { setTimeout(hideSlashHint, 120); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !slashHint.hidden) hideSlashHint();
    if (e.key === 'Escape' && replyState) hideReplyPreview();
  });

  // ── Reply to a specific earlier answer ────────────────────────────────────
  // Tapping "Reply" on any past AI answer (live or reloaded from history) anchors the
  // next message to that exact turn, so a follow-up stays grounded to it even if it's
  // outside the ~5-exchange window the model normally sees. `replyState` holds
  // { memoryId, snippet } while a reply is staged; cleared on send or cancel.
  let replyState = null;
  const inputArea = document.querySelector('.input-area');
  const replyPreview = document.createElement('div');
  replyPreview.className = 'reply-preview';
  replyPreview.hidden = true;
  if (inputArea && composerRow) inputArea.insertBefore(replyPreview, composerRow);
  else if (composerRow) composerRow.appendChild(replyPreview);

  function snippetOf(text, max) {
    max = max || 140;
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
  }

  function showReplyPreview(memoryId, snippet) {
    if (!memoryId) return;
    replyState = { memoryId: memoryId, snippet: snippet };
    replyPreview.innerHTML =
      '<span class="reply-preview-label">↩ Replying to</span>' +
      '<span class="reply-preview-text">' + escHtml(snippet) + '</span>' +
      '<button type="button" class="reply-preview-cancel" aria-label="Cancel reply">×</button>';
    replyPreview.hidden = false;
    input.focus();
  }

  function hideReplyPreview() {
    replyState = null;
    replyPreview.hidden = true;
    replyPreview.innerHTML = '';
  }

  replyPreview.addEventListener('click', function (e) {
    if (e.target.closest('.reply-preview-cancel')) hideReplyPreview();
  });

  // Delegated — covers both live-appended AI messages and ones rendered server-side
  // from history; both carry data-memory-id + data-answer-text on .ai-message.
  messagesArea.addEventListener('click', function (e) {
    const btn = e.target.closest('.msg-reply-btn');
    if (!btn) return;
    const host = btn.closest('.ai-message[data-memory-id]');
    if (!host) return;
    showReplyPreview(host.getAttribute('data-memory-id'), snippetOf(host.getAttribute('data-answer-text')));
  });

  // ── Shared Groq daily quota badge (rushiljohn10@gmail.com only) ───────────
  // Groq only exposes a per-MINUTE rate-limit bucket on live responses — the daily cap
  // that's actually caused outages before is tracked server-side (lib/tokenUsage.js) and
  // surfaced here only for the primary test account. The server is the sole gatekeeper
  // (routes/chat.js checks the owner's email); this just renders whatever it returns.
  const quotaBadge = document.createElement('div');
  quotaBadge.className = 'quota-badge';
  quotaBadge.hidden = true;
  if (composerRow) composerRow.appendChild(quotaBadge);

  function renderQuota(data) {
    if (!data || !data.visible || !data.main) { quotaBadge.hidden = true; return; }
    const pct = data.main.percentRemaining;
    quotaBadge.classList.toggle('quota-badge--low', pct <= 15);
    quotaBadge.innerHTML =
      '<span class="quota-badge-dot"></span>' +
      '<span class="quota-badge-text">' + pct + '% left today</span>';
    quotaBadge.title = (data.all || []).map(function (s) {
      return s.model + ': ' + s.remaining.toLocaleString() + ' / ' + s.limit.toLocaleString() + ' tokens left today';
    }).join('\n');
    quotaBadge.hidden = false;
  }

  function refreshQuota() {
    fetch('/api/chat/quota')
      .then(function (r) { return r.json(); })
      .then(renderQuota)
      .catch(function () { quotaBadge.hidden = true; });
  }
  refreshQuota();

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

  // Quick-action pills + feature cards in the empty/hero state: drop their
  // starter prompt into the input and send it like any other message.
  messagesArea.addEventListener('click', function (e) {
    const trigger = e.target.closest('[data-prompt]');
    if (!trigger) return;
    const text = trigger.getAttribute('data-prompt');
    if (!text) return;
    input.value = text;
    sendFromInput();
  });

  function sendFromInput() {
    const raw = input.value.trim();
    if (!raw) return;
    // A "/visualise <question>" command forces a structured card.
    const cmd = parseFormatCommand(raw);
    // Bare "/visualise" with no request after it: don't send an empty command to the
    // model — hold the text in the box and nudge for detail instead.
    if (cmd.modality && !cmd.cleaned) { showSlashNudge(raw); return; }
    input.value = '';
    input.style.height = 'auto';
    hideSlashHint();
    const forceStructured = cmd.modality === 'structured' && cmd.cleaned.length > 0;
    // Capture the staged reply (if any) before clearing it, so it carries through to
    // both the sent-message quote and the request body.
    const replyTo = replyState;
    hideReplyPreview();
    // First message of a brand-new chat clears the hero so messages take over.
    const hero = messagesArea.querySelector('.empty-hero');
    if (hero) hero.remove();
    // Keep the full "/visualise …" text visible in the chat so the owner can see the
    // command was applied; the server strips it before the model sees the question.
    appendUserMessage(raw, replyTo && replyTo.snippet);
    postMessage(raw, [], { forceStructured, replyTo });
  }

  // Core request. `clarifications` is [] on a first ask, or the owner's triage
  // answers on the follow-up round. `opts.forceStructured` carries a /visualise
  // override through both rounds so a clarified answer still renders as a card.
  // `opts.replyTo` ({memoryId, snippet}) likewise carries a staged reply through both
  // rounds so a clarified answer still anchors to the quoted turn.
  function postMessage(text, clarifications, opts) {
    opts = opts || {};
    sendBtn.disabled = true;
    const typingEl = appendTypingIndicator();
    scrollToBottom();

    fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text, clarifications, session_id: sessionId,
        force_structured: opts.forceStructured === true ? true : undefined,
        reply_to_memory_id: opts.replyTo ? opts.replyTo.memoryId : undefined,
      }),
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
          appendClarification(data.original_message || text, data.clarifying_questions || [], opts);
        } else if (data.place_prompt) {
          // The owner asked (in plain language) to find nearby vets/parks/cafés — route into
          // the SAME real Find pipeline instead of letting the model improvise a places list.
          if (data.category && PLACE_META[data.category]) renderLocationCard(data.category, data.place_intro);
          else showPlacePicker();
        } else {
          appendAIMessage(data);
          // Each answer call consumes from the shared daily quota — refresh the badge.
          refreshQuota();
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

  function appendUserMessage(text, replySnippet) {
    const el = document.createElement('div');
    el.className = 'message user-message';
    const quoteHtml = replySnippet
      ? `<div class="reply-quote">↩ ${escHtml(replySnippet)}</div>`
      : '';
    el.innerHTML = `
      <div class="bubble-wrap">
        ${quoteHtml}
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
  function appendClarification(originalMessage, questions, opts) {
    opts = opts || {};
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

      postMessage(originalMessage, answers, opts);
      scrollToBottom();
    });
  }

  function appendAIMessage(data) {
    const el = document.createElement('div');
    el.className = 'message ai-message' + (data.escalated ? ' emergency' : '');
    // So the delegated "Reply" click handler and future reloads can find this turn — same
    // attributes the server sets on history-rendered messages (views/chat.ejs).
    if (data.memory_id) el.dataset.memoryId = data.memory_id;
    el.dataset.answerText = data.answer || '';

    const emergencyBanner = data.escalated
      ? `<div class="emergency-banner">⚠️ URGENT — See a vet or emergency clinic now</div>`
      : '';

    const sourcesHtml = data.sources?.length
      ? `<details class="sources">
           <summary>Sources (${data.sources.length})</summary>
           <ul>${data.sources.map(s => {
             const loc = [s.source, s.section].filter(Boolean).map(escHtml).join(' › ');
             // Web sources carry a url → render as an external link.
             if (s.url) {
               return `<li><a href="${escHtml(s.url)}" target="_blank" rel="noopener"><strong>${loc}</strong></a> <span class="src-web">web</span></li>`;
             }
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
        <div class="ai-content"></div>
        ${sourcesHtml}
        <div class="meta">
          ${confBadge}
          ${fallbackBadge}
          ${fmtTime(new Date(data.created_at || Date.now()))}
        </div>
      </div>`;

    // Body: a structured card when the model returned one, otherwise a markdown bubble.
    const contentEl = el.querySelector('.ai-content');
    if (data.structured_answer) {
      contentEl.appendChild(renderStructuredAnswer(data.structured_answer));
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'bubble markdown-content';
      bubble.innerHTML = renderMarkdown(data.answer || '');
      contentEl.appendChild(bubble);
    }

    messagesArea.appendChild(el);

    // Decision offer popup card — shown instead of inline "just say yes" text.
    if (data.decision_offer && data.offer_title) {
      const card = buildDecisionCard(data.offer_title, data.offer_type, data.offer_summary);
      el.querySelector('.bubble-wrap').appendChild(card);
    }

    // Reply button + rating widget — only on persisted turns. A needs_clarification round
    // isn't saved to conversation_memory, so it carries no memory_id and gets neither.
    if (data.memory_id) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML =
        '<button type="button" class="msg-reply-btn" title="Reply to this answer">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M4 12h11a5 5 0 0 1 5 5v1"></path></svg>' +
          'Reply' +
        '</button>';
      el.querySelector('.bubble-wrap').appendChild(actions);
      el.querySelector('.bubble-wrap').appendChild(buildFeedbackWidget(data.memory_id, null));
    }
  }

  // ── Structured answer card ────────────────────────────────────────────────
  // One generic renderer for the StructuredAnswer schema (lib/structured.js). Driven
  // entirely by data — no per-kind components. Any block that's absent simply isn't
  // rendered, so a header-plus-one-stat answer works as well as a dense multi-section one.
  function renderStructuredAnswer(ans) {
    const card = document.createElement('div');
    card.className = 'structured-card';
    if (!ans || !ans.header) {
      card.textContent = (ans && ans.fallbackText) || '';
      return card;
    }

    // Header — avatar + title + optional subject meta
    const meta = ans.subject && ans.subject.meta ? ans.subject.meta : '';
    const headIcon = (ans.header && ans.header.icon) || (ans.subject && ans.subject.avatarIcon) || 'paw';
    card.appendChild(elFromHtml(
      '<div class="sc-header">' +
        '<span class="sc-avatar">' + iconSvg(headIcon) + '</span>' +
        '<div class="sc-headtext">' +
          '<div class="sc-title">' + escHtml(ans.header.title) + '</div>' +
          (meta ? '<div class="sc-sub">' + escHtml(meta) + '</div>' : '') +
        '</div>' +
      '</div>'));

    // Stats grid
    if (Array.isArray(ans.stats) && ans.stats.length) {
      const grid = document.createElement('div');
      grid.className = 'sc-stats';
      ans.stats.slice(0, 4).forEach(function (s) {
        grid.appendChild(elFromHtml(
          '<div class="sc-stat">' +
            '<div class="sc-stat-val">' + escHtml(s.value) + (s.unit ? ' <span class="sc-stat-unit">' + escHtml(s.unit) + '</span>' : '') + '</div>' +
            '<div class="sc-stat-label">' + escHtml(s.label) + '</div>' +
          '</div>'));
      });
      card.appendChild(grid);
    }

    // Sections
    (ans.sections || []).forEach(function (sec) { card.appendChild(renderSection(sec)); });

    // Callouts
    (ans.callouts || []).forEach(function (c) {
      card.appendChild(elFromHtml(
        '<div class="sc-callout sc-callout-' + (c.tone || 'info') + '">' +
          '<span class="sc-callout-icon">' + iconSvg(c.icon || c.tone || 'info') + '</span>' +
          '<div class="sc-callout-text">' +
            '<div class="sc-callout-title">' + escHtml(c.title) + '</div>' +
            '<div class="sc-callout-body">' + escHtml(c.body) + '</div>' +
          '</div>' +
        '</div>'));
    });

    // Tags
    if (Array.isArray(ans.tags) && ans.tags.length) {
      const row = document.createElement('div');
      row.className = 'sc-tags';
      ans.tags.forEach(function (t) {
        row.appendChild(elFromHtml('<span class="sc-tag">' + escHtml(t.label) + '</span>'));
      });
      card.appendChild(row);
    }

    // Actions
    if (Array.isArray(ans.actions) && ans.actions.length) {
      card.appendChild(renderActions(ans.actions));
    }

    return card;
  }

  function renderSection(sec) {
    const wrap = document.createElement('div');
    wrap.className = 'sc-section';
    wrap.appendChild(elFromHtml('<div class="sc-section-heading">' + escHtml(sec.heading) + '</div>'));

    if (sec.layout === 'timeline') {
      const list = document.createElement('div');
      list.className = 'sc-timeline';
      (sec.items || []).forEach(function (it) {
        const details = (it.details || []).map(function (d) {
          return '<li>' + escHtml(d) + '</li>';
        }).join('');
        list.appendChild(elFromHtml(
          '<div class="sc-tl-item">' +
            '<span class="sc-tl-dot">' + (it.icon ? iconSvg(it.icon) : '') + '</span>' +
            '<div class="sc-tl-body">' +
              '<div class="sc-tl-label">' + escHtml(it.label) + '</div>' +
              (details ? '<ul class="sc-tl-details">' + details + '</ul>' : '') +
            '</div>' +
          '</div>'));
      });
      wrap.appendChild(list);
    } else {
      // 'list' (default)
      const list = document.createElement('ul');
      list.className = 'sc-list';
      (sec.items || []).forEach(function (it) {
        list.appendChild(elFromHtml(
          '<li class="sc-list-item">' +
            '<span class="sc-list-label">' + escHtml(it.label) + '</span>' +
            (it.detail ? '<span class="sc-list-detail">' + escHtml(it.detail) + '</span>' : '') +
          '</li>'));
      });
      wrap.appendChild(list);
    }
    return wrap;
  }

  // ── Action registry ───────────────────────────────────────────────────────
  // type → handler. Two real, wired actions today (save_decision, open_screen); the
  // rest render disabled with a "coming soon" state instead of silently failing.
  const ACTION_HANDLERS = {
    save_decision: { wired: true, run: runSaveDecision },
    open_screen: { wired: true, run: runOpenScreen },
    set_reminder: { wired: false },
    log_event: { wired: false },
  };

  function renderActions(actions) {
    const row = document.createElement('div');
    row.className = 'sc-actions';
    actions.forEach(function (a) {
      const handler = ACTION_HANDLERS[a.type];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sc-action-btn';
      btn.innerHTML = (a.icon ? '<span class="sc-action-icon">' + iconSvg(a.icon) + '</span>' : '') + escHtml(a.label);
      if (!handler || !handler.wired) {
        btn.disabled = true;
        btn.classList.add('sc-action-soon');
        btn.title = 'Coming soon';
        btn.innerHTML += ' <span class="sc-soon">soon</span>';
      } else {
        btn.addEventListener('click', function () { handler.run(a.payload || {}, btn, row); });
      }
      row.appendChild(btn);
    });
    return row;
  }

  function runSaveDecision(payload, btn, row) {
    if (!sessionId) return;
    Array.prototype.forEach.call(row.querySelectorAll('button'), function (b) { b.disabled = true; });
    const original = btn.innerHTML;
    btn.textContent = 'Saving…';
    fetch('/api/chat/session/' + sessionId + '/decision/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: payload.title || 'Saved plan',
        decision_type: payload.decision_type || 'other',
        summary: payload.summary || '',
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result.ok) {
          const done = document.createElement('div');
          done.className = 'sc-action-saved';
          done.innerHTML = '<span class="doc-success-icon">&#10003;</span> Saved to ' + escHtml(petName) + '’s record';
          row.replaceWith(done);
        } else {
          btn.innerHTML = original;
          Array.prototype.forEach.call(row.querySelectorAll('button'), function (b) { b.disabled = false; });
        }
      })
      .catch(function () {
        btn.innerHTML = original;
        Array.prototype.forEach.call(row.querySelectorAll('button'), function (b) { b.disabled = false; });
      });
  }

  function runOpenScreen(payload) {
    const screen = (payload && payload.screen) || 'profile';
    window.location.href = screen === 'chat' ? '/chat' : '/onboarding';
  }

  // ── Tiny inline-icon set (keys come from the model; unknown → a neutral dot) ──
  const ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/>',
    'clipboard-check': '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/>',
    stethoscope: '<path d="M4 3v5a4 4 0 0 0 8 0V3"/><path d="M8 15a5 5 0 0 0 10 0v-2"/><circle cx="18" cy="11" r="2"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    bone: '<path d="M17 10c1.5 0 3-1 3-3s-1.5-3-3-3-2.5 1.5-3 2H9c-.5-.5-1.5-2-3-2S3 5.5 3 7s1.5 3 3 3"/><path d="M17 14c1.5 0 3 1 3 3s-1.5 3-3 3-2.5-1.5-3-2H9c-.5.5-1.5 2-3 2s-3-1.5-3-3 1.5-3 3-3"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 12.5L20 20M8.1 8.1L12 12"/>',
    paw: '<circle cx="6" cy="11" r="1.8"/><circle cx="10.5" cy="7.5" r="1.8"/><circle cx="13.5" cy="7.5" r="1.8"/><circle cx="18" cy="11" r="1.8"/><path d="M8 16.5c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5-1.8 3-4 3-4-1-4-3z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    success: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-5"/>',
  };
  function iconSvg(key) {
    const body = ICONS[key] || '<circle cx="12" cy="12" r="3"/>';
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }

  function elFromHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  // ── Decision offer popup card ─────────────────────────────────────────────
  const TYPE_LABELS = {
    diet_plan: 'Diet Plan',
    allergy: 'Allergy',
    diagnosis: 'Diagnosis',
    treatment_routine: 'Routine',
    other: 'Plan',
  };

  function buildDecisionCard(title, type, summary) {
    const typeLabel = TYPE_LABELS[type] || 'Plan';
    const card = document.createElement('div');
    card.className = 'decision-offer-card';
    card.innerHTML =
      '<div class="doc-card-inner">' +
        '<div class="doc-card-header">' +
          '<span class="doc-type-badge">' + escHtml(typeLabel) + '</span>' +
          '<span class="doc-card-title">' + escHtml(title) + '</span>' +
        '</div>' +
        (summary ? '<p class="doc-card-summary">' + escHtml(summary) + '</p>' : '') +
        '<div class="doc-card-actions">' +
          '<button type="button" class="btn btn-primary doc-save-btn">Save to ' + escHtml(petName) + '’s record</button>' +
          '<button type="button" class="btn btn-ghost doc-dismiss-btn">Not now</button>' +
        '</div>' +
      '</div>';

    const saveBtn = card.querySelector('.doc-save-btn');
    const dismissBtn = card.querySelector('.doc-dismiss-btn');

    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      dismissBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      fetch('/api/chat/session/' + sessionId + '/decision/confirm', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (result) {
          if (result.ok) {
            card.innerHTML =
              '<div class="doc-card-inner doc-card-success">' +
                '<span class="doc-success-icon">&#10003;</span>' +
                ' Saved to ' + escHtml(petName) + '’s record' +
              '</div>';
            if (result.answer) {
              appendAIMessage({ answer: result.answer, sources: [], escalated: false, created_at: result.created_at, memory_id: result.memory_id });
              scrollToBottom();
            }
          } else {
            saveBtn.textContent = 'Save to ' + escHtml(petName) + '’s record';
            saveBtn.disabled = false;
            dismissBtn.disabled = false;
          }
        })
        .catch(function () {
          saveBtn.textContent = 'Save to ' + escHtml(petName) + '’s record';
          saveBtn.disabled = false;
          dismissBtn.disabled = false;
        });
    });

    dismissBtn.addEventListener('click', function () {
      card.classList.add('doc-card-dismissed');
      fetch('/api/chat/session/' + sessionId + '/decision/dismiss', { method: 'POST' }).catch(function () {});
      setTimeout(function () { card.remove(); }, 280);
    });

    return card;
  }

  // ── Per-answer feedback widget (tester ratings) ───────────────────────────
  // A lightweight rating log for manual review. Collapsed = a 1–10 scale; tapping a
  // number fires an optimistic upsert immediately (useful even if they stop there),
  // then expands in place for optional tags + a comment. Matches the decision-card /
  // action-row pattern of attaching under the AI bubble. Fire-and-forget — never blocks.
  const FEEDBACK_TAGS = [
    { key: 'exactly_right',         label: 'Exactly right' },
    { key: 'wrong_info',            label: 'Wrong info' },
    { key: 'missed_pet_context',    label: 'Missed pet context' },
    { key: 'misunderstood_question', label: 'Misunderstood me' },
    { key: 'too_long',              label: 'Too long' },
    { key: 'too_vague',             label: 'Too vague' },
    { key: 'tone_off',              label: 'Tone off' },
  ];

  function buildFeedbackWidget(memoryId, existing) {
    const state = {
      rating: existing && existing.rating ? Number(existing.rating) : null,
      tags: existing && Array.isArray(existing.tags) ? existing.tags.slice() : [],
      comment: (existing && existing.comment) || '',
      open: false,
      done: !!(existing && existing.rating),
    };

    const widget = document.createElement('div');
    widget.className = 'feedback-widget';

    // Optimistic, fire-and-forget. A failure here must never disrupt the chat.
    function persist() {
      fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_id: memoryId,
          rating: state.rating,
          tags: state.tags,
          comment: state.comment ? state.comment : undefined,
        }),
      }).catch(function () {});
    }

    function scaleHtml() {
      let btns = '';
      for (let n = 1; n <= 10; n++) {
        btns += '<button type="button" class="fb-score' + (state.rating === n ? ' selected' : '') +
          '" data-score="' + n + '" aria-label="Rate ' + n + ' out of 10">' + n + '</button>';
      }
      return '<div class="fb-scale-row">' +
        '<span class="fb-scale-label">Rate this answer</span>' +
        '<div class="fb-scale">' + btns + '</div>' +
      '</div>';
    }

    function detailHtml() {
      const chips = FEEDBACK_TAGS.map(function (t) {
        return '<button type="button" class="fb-tag' + (state.tags.indexOf(t.key) !== -1 ? ' selected' : '') +
          '" data-tag="' + t.key + '">' + escHtml(t.label) + '</button>';
      }).join('');
      return '<div class="fb-detail">' +
        '<div class="fb-tags">' + chips + '</div>' +
        '<textarea class="fb-comment" rows="2" placeholder="Add a note (optional) — what was off, or what worked?"></textarea>' +
        '<div class="fb-detail-actions">' +
          '<button type="button" class="btn btn-primary btn-sm fb-submit">Send feedback</button>' +
          '<span class="fb-saved-hint">Rating saved ✓ — add detail if you like</span>' +
        '</div>' +
      '</div>';
    }

    function doneHtml() {
      return '<div class="fb-done">' +
        '<span class="fb-check">&#10003;</span> Thanks — got it.' +
        '<button type="button" class="fb-edit">Edit</button>' +
      '</div>';
    }

    function render() {
      let html = scaleHtml();
      if (state.open) html += detailHtml();
      else if (state.done) html += doneHtml();
      widget.innerHTML = html;

      // Re-set the comment value after innerHTML rebuild (preserves in-progress text).
      const ta = widget.querySelector('.fb-comment');
      if (ta) ta.value = state.comment;
      wire();
    }

    function wire() {
      Array.prototype.forEach.call(widget.querySelectorAll('.fb-score'), function (b) {
        b.addEventListener('click', function () {
          state.rating = Number(b.getAttribute('data-score'));
          state.open = true;        // expand for optional detail
          state.done = false;
          persist();                // log the rating immediately (optimistic)
          render();
        });
      });
      Array.prototype.forEach.call(widget.querySelectorAll('.fb-tag'), function (b) {
        b.addEventListener('click', function () {
          const key = b.getAttribute('data-tag');
          const i = state.tags.indexOf(key);
          if (i === -1) state.tags.push(key); else state.tags.splice(i, 1);
          b.classList.toggle('selected');
        });
      });
      const ta = widget.querySelector('.fb-comment');
      if (ta) ta.addEventListener('input', function () { state.comment = ta.value; });
      const submit = widget.querySelector('.fb-submit');
      if (submit) submit.addEventListener('click', function () {
        state.open = false;
        state.done = true;
        persist();                  // upsert with tags + comment
        render();
      });
      const edit = widget.querySelector('.fb-edit');
      if (edit) edit.addEventListener('click', function () {
        state.open = true;
        state.done = false;
        render();
      });
    }

    render();
    return widget;
  }

  // Attach the rating widget to every server-rendered AI turn that has a persisted id
  // (hydrating any prior rating the tester already left, so it survives reloads).
  function initHistoryFeedback() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.ai-message[data-memory-id]'),
      function (el) {
        const id = el.getAttribute('data-memory-id');
        const wrap = el.querySelector('.bubble-wrap');
        if (!id || !wrap || wrap.querySelector('.feedback-widget')) return;
        let existing = null;
        const raw = el.getAttribute('data-feedback');
        if (raw) { try { existing = JSON.parse(raw); } catch (e) { /* ignore */ } }
        wrap.appendChild(buildFeedbackWidget(id, existing));
      },
    );
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

  // Open every external link in a new tab (and harden it) so a tap on an answer's link —
  // e.g. a booking "Open WhatsApp →" wa.me link — doesn't navigate away from the chat.
  // Registered once; applies to all DOMPurify-sanitized markdown.
  if (window.DOMPurify && !window.__WHOOF_LINK_HOOK__) {
    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    window.__WHOOF_LINK_HOOK__ = true;
  }

  // marked turns the model's markdown into HTML but does NOT sanitize — it passes raw
  // HTML straight through. Run the result through DOMPurify before it touches innerHTML
  // so a stray <script>/<img onerror> in an answer can't execute. If DOMPurify failed to
  // load, fall back to marked-only (no worse than before — never blocks the chat).
  function renderMarkdown(text) {
    const html = marked.parse(text || '');
    return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  }
  window.renderMarkdown = renderMarkdown;

  function fmtTime(date) {
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  // Hydrate structured-answer turns rendered server-side (chat history on page load):
  // each carries its JSON in a data attribute; swap the plain-text fallback for a live
  // card. Two kinds share this slot: a /visualise StructuredAnswer, and a Find result
  // (kind:'places') — without this branch, a Find turn would silently downgrade from
  // live cards to plain markdown text on every reload. Defined here but INVOKED lower down
  // (after PLACE_META and buildVetResultsInner are initialized), since the places branch
  // depends on them and `const` bindings sit in the temporal dead zone until their line runs.
  function hydrateStructuredTurns() {
    document.querySelectorAll('.ai-content[data-structured]').forEach(function (host) {
      try {
        const ans = JSON.parse(host.getAttribute('data-structured'));
        host.removeAttribute('data-structured');
        if (ans && ans.kind === 'places') {
          const built = buildVetResultsInner(ans.data, ans.category);
          host.innerHTML = built.html;
          built.wire(host);
        } else {
          host.replaceChildren(renderStructuredAnswer(ans));
        }
      } catch (e) { /* leave the fallback text in place */ }
    });
  }

  // Attach rating widgets to the server-rendered history turns on page load.
  initHistoryFeedback();

  // ── Nearby places (vets / parks / pet-friendly cafés) ───────────────────────
  // Each category drives the picker card, the location-prompt copy, and the results.
  const PLACE_META = {
    vet: {
      label: 'Vets', tagline: 'Clinics near you',
      icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>',
      userMsg: 'Find a vet nearby', prompt: 'find vets near you',
      header: 'Here are vets near you:', empty: 'No vets found within range. Try asking your local pet store or a neighbour.',
      booking: true,
    },
    park: {
      label: 'Parks', tagline: 'Walks & dog parks',
      icon: '<path d="M12 22V12"></path><path d="M7 12a5 5 0 0 1 5-5 5 5 0 0 1 5 5"></path><path d="M5 22h14"></path><path d="M12 7V2"></path>',
      userMsg: 'Find parks nearby', prompt: 'find parks near you',
      header: 'Here are parks near you for a walk:', empty: 'No parks found within range. Try a wider area on Google Maps.',
      booking: false,
    },
    cafe: {
      label: 'Cafés', tagline: 'Pet-friendly spots',
      icon: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"></path><line x1="6" y1="2" x2="6" y2="4"></line><line x1="10" y1="2" x2="10" y2="4"></line><line x1="14" y1="2" x2="14" y2="4"></line>',
      userMsg: 'Find pet-friendly cafés', prompt: 'find cafés & restaurants near you',
      header: 'Here are cafés & restaurants near you — call ahead to confirm they’re pet-friendly:',
      empty: 'No cafés or restaurants found within range. Try a wider area on Google Maps.',
      booking: false,
    },
  };

  function buildVetCard(vet, allowBooking, opts) {
    opts = opts || {};
    const stars = vet.rating
      ? '★'.repeat(Math.round(vet.rating)) + '☆'.repeat(5 - Math.round(vet.rating))
      : null;
    const openBadge = vet.open === true
      ? '<span class="vet-open">Open now</span>'
      : vet.open === false
        ? '<span class="vet-closed">Closed</span>'
        : '';
    const bookBtn = allowBooking
      ? '<button type="button" class="vet-book-btn" data-clinic="' + escHtml(vet.name) +
          '" data-phone="' + escHtml(vet.phone || '') + '">Draft booking</button>'
      : '';
    const community = vet.community || {};
    // In community-only mode (parks/cafés) the header already says these are pet-owner
    // picks, so the per-card badge is redundant noise — suppress it.
    const communityBadge = (community.favourite && !opts.hideBadge)
      ? '<span class="vet-community-badge">🐾 Community pick</span>'
      : '';
    const whyLine = community.favourite && community.reason
      ? '<div class="vet-card-why">' + escHtml(community.reason) + '</div>'
      : '';
    const distHtml = vet.distanceLabel
      ? '<span class="vet-card-dist">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>' +
          escHtml(vet.distanceLabel) + ' away</span>'
      : '';
    const linkHtml = vet.mapsUrl
      ? '<a class="vet-card-link" href="' + escHtml(vet.mapsUrl) + '" target="_blank" rel="noopener">Directions ↗</a>'
      : '';

    return '<div class="vet-card' + (community.favourite ? ' vet-card--pick' : '') + '">' +
      '<div class="vet-card-name">' + escHtml(vet.name) + openBadge + communityBadge + '</div>' +
      (vet.address ? '<div class="vet-card-addr">' + escHtml(vet.address) + '</div>' : '') +
      (distHtml ? '<div class="vet-card-meta-row">' + distHtml + '</div>' : '') +
      (stars ? '<div class="vet-card-rating"><span class="vet-stars">' + stars + '</span>' +
        '<span class="vet-rating-num">' + escHtml(String(vet.rating)) +
        (vet.reviews ? ' (' + vet.reviews + ')' : '') + '</span></div>' : '') +
      whyLine +
      '<div class="vet-card-actions">' +
        linkHtml +
        bookBtn +
      '</div>' +
    '</div>';
  }

  // Side-by-side category cards shown when the owner taps the location button.
  function showPlacePicker() {
    const hero = messagesArea.querySelector('.empty-hero');
    if (hero) hero.remove();

    const cards = Object.keys(PLACE_META).map(function (key) {
      const m = PLACE_META[key];
      return '<button type="button" class="place-pick-card" data-category="' + key + '">' +
        '<span class="place-pick-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + m.icon + '</svg></span>' +
        '<span class="place-pick-label">' + m.label + '</span>' +
        '<span class="place-pick-tagline">' + m.tagline + '</span>' +
      '</button>';
    }).join('');

    const el = document.createElement('div');
    el.className = 'message ai-message';
    el.innerHTML =
      '<div class="ai-avatar">W</div>' +
      '<div class="bubble-wrap">' +
        '<div class="bubble">What would you like to find near you?</div>' +
        '<div class="place-pick-grid">' + cards + '</div>' +
        '<div class="meta">' + fmtTime(new Date()) + '</div>' +
      '</div>';
    messagesArea.appendChild(el);
    el.querySelectorAll('.place-pick-card').forEach(function (card) {
      card.addEventListener('click', function () {
        // Lock the choice visually, then ask for location for that category.
        el.querySelectorAll('.place-pick-card').forEach(function (c) {
          c.disabled = true;
          c.classList.toggle('selected', c === card);
        });
        showLocationPrompt(card.getAttribute('data-category'));
      });
    });
    scrollToBottom();
  }

  // Builds the inner HTML for a vet-results block plus a wiring function that attaches
  // its booking/show-more handlers once the HTML is in the DOM. Shared by two call sites:
  // showVetResults (a live search — appends a whole new message) and the history hydration
  // below (swaps a persisted turn's markdown fallback for the same live cards on load), so
  // a page reload never silently downgrades a Find result from cards to plain text.
  function buildVetResultsInner(data, category) {
    const m = PLACE_META[category] || PLACE_META.vet;
    const vets = (data && data.vets) || [];
    const morePlaces = (data && data.more_places) || [];
    const extras = (data && data.community_extras) || [];
    const communityOnly = !!(data && data.community_only);
    const header = (data && data.heading) || m.header;
    const emptyMsg = (data && data.empty) || m.empty;

    // "Show more places" — parks/cafés cap the default view; the rest are revealed only on
    // this explicit click (per the "don't cross 7 unless asked" rule).
    const moreBtnHtml = morePlaces.length
      ? '<button type="button" class="vet-more-btn">Show ' + morePlaces.length + ' more place' + (morePlaces.length === 1 ? '' : 's') + '</button>'
      : '';

    // Vets: a note that community picks are marked + shown first. Parks/cafés: the header
    // already says everything is a pet-owner pick, so no note (and no per-card badge).
    const anyPick = !communityOnly && vets.some(function (v) { return v.community && v.community.favourite; });
    const pickNote = anyPick
      ? '<div class="vet-pick-note">🐾 spots local pet owners recommend are marked and shown first</div>'
      : '';

    // "Also loved by locals" — community names not in the nearby list (vets only; for
    // parks/cafés these are already promoted into the main list).
    const extrasHtml = extras.length
      ? '<div class="vet-extras"><div class="vet-extras-label">🐾 Also loved by local pet owners</div>' +
          extras.map(function (e) {
            return '<a class="vet-extra" href="' + escHtml(e.searchUrl || '#') + '" target="_blank" rel="noopener">' +
              '<span class="vet-extra-name">' + escHtml(e.name) + '</span>' +
              (e.reason ? '<span class="vet-extra-why">' + escHtml(e.reason) + '</span>' : '') +
            '</a>';
          }).join('') +
        '</div>'
      : '';

    const html =
      '<div class="vet-results-header">' + escHtml(header) + '</div>' +
      pickNote +
      '<div class="vet-results">' +
        (vets.length
          ? vets.map(function (v) { return buildVetCard(v, m.booking, { hideBadge: communityOnly }); }).join('')
          : '<div class="vet-empty">' + escHtml(emptyMsg) + '</div>'
        ) +
      '</div>' +
      moreBtnHtml +
      extrasHtml;

    function wire(container) {
      // Wire each card's "Draft booking" button (vets only; closure access to the helpers).
      container.querySelectorAll('.vet-book-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          requestBookingDraft(btn.getAttribute('data-clinic'), btn.getAttribute('data-phone'), btn);
        });
      });
      // "Show more places" — reveal the held-back picks (already fetched) into the same list.
      const moreBtn = container.querySelector('.vet-more-btn');
      if (moreBtn && morePlaces.length) {
        moreBtn.addEventListener('click', function () {
          const list = container.querySelector('.vet-results');
          morePlaces.forEach(function (v) {
            list.insertAdjacentHTML('beforeend', buildVetCard(v, m.booking, { hideBadge: communityOnly }));
          });
          moreBtn.remove();
          scrollToBottom();
        });
      }
    }

    return { html, wire };
  }

  function showVetResults(data, category) {
    const built = buildVetResultsInner(data, category);
    const el = document.createElement('div');
    el.className = 'message ai-message';
    el.innerHTML =
      '<div class="ai-avatar">W</div>' +
      '<div class="bubble-wrap">' + built.html + '<div class="meta">' + fmtTime(new Date()) + '</div></div>';
    messagesArea.appendChild(el);
    built.wire(el);
    scrollToBottom();
  }

  // Now that PLACE_META + buildVetResultsInner exist, hydrate any server-rendered
  // structured turns (including Find `places` cards) from the page-load history.
  hydrateStructuredTurns();

  // Ask the server to draft a booking message for one clinic, then render it with
  // one-tap "Send via WhatsApp" / "Copy" actions. The reason is inferred server-side
  // from this chat's recent turns.
  function requestBookingDraft(clinicName, clinicPhone, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Drafting…'; }
    fetch('/api/vets/booking-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clinic_name: clinicName,
        clinic_phone: clinicPhone || '',
        session_id: sessionId || undefined,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) showBookingDraft(data);
        else showVetError(data.error || 'Could not draft a booking message.');
      })
      .catch(function () { showVetError('Network error — please try again.'); })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Draft booking'; }
      });
  }

  function showBookingDraft(data) {
    const el = document.createElement('div');
    el.className = 'message ai-message';
    const waBtn = data.whatsapp_url
      ? '<a class="btn btn-primary booking-send" href="' + escHtml(data.whatsapp_url) +
          '" target="_blank" rel="noopener">Send via WhatsApp ↗</a>'
      : '<span class="booking-nophone">No phone number on file — copy the message and send it yourself.</span>';
    el.innerHTML =
      '<div class="ai-avatar">W</div>' +
      '<div class="bubble-wrap">' +
        '<div class="booking-card">' +
          '<div class="booking-card-head">Booking draft for ' + escHtml(data.clinic_name) + '</div>' +
          '<div class="booking-msg"></div>' +
          '<div class="booking-actions">' +
            waBtn +
            '<button type="button" class="btn btn-ghost booking-copy">Copy message</button>' +
          '</div>' +
        '</div>' +
        '<div class="meta">' + fmtTime(new Date()) + '</div>' +
      '</div>';
    // Set the message via textContent (never innerHTML) so it can't inject markup.
    el.querySelector('.booking-msg').textContent = data.message;
    messagesArea.appendChild(el);

    const copyBtn = el.querySelector('.booking-copy');
    copyBtn.addEventListener('click', function () {
      const done = function () { copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy message'; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data.message).then(done).catch(function () {});
      } else {
        // Fallback for non-secure contexts without the Clipboard API.
        const ta = document.createElement('textarea');
        ta.value = data.message; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
      }
    });
    scrollToBottom();
  }

  function showVetError(msg) {
    const el = document.createElement('div');
    el.className = 'message ai-message';
    el.innerHTML =
      '<div class="ai-avatar">W</div>' +
      '<div class="bubble-wrap"><div class="bubble">' + escHtml(msg) + '</div></div>';
    messagesArea.appendChild(el);
    scrollToBottom();
  }

  // Adopt the session the server created/returned for this vet search, so the chat
  // shows up in the sidebar and survives a reload — same handshake as postMessage().
  function adoptVetSession(data) {
    if (data.session_id && data.session_id !== sessionId) {
      sessionId = data.session_id;
      try { history.replaceState(null, '', '/chat?session=' + sessionId); } catch (e) { /* noop */ }
      ensureSidebarEntry(sessionId, data.session_title || 'Nearby vets');
    }
  }

  // Renders the "share your location" card for a category and wires the geolocation →
  // /api/vets/nearby → results flow. Split out of showLocationPrompt so the chat path
  // (a typed "find me a cafe" question) can reuse the exact same Find pipeline without
  // appending a duplicate "Find pet-friendly cafés" user bubble on top of what they typed.
  function renderLocationCard(category, introText) {
    const m = PLACE_META[category] || PLACE_META.vet;
    // First action of a brand-new chat clears the hero so the conversation takes over.
    const hero = messagesArea.querySelector('.empty-hero');
    if (hero) hero.remove();

    const el = document.createElement('div');
    el.className = 'message ai-message';
    const inner =
      '<div class="ai-avatar">W</div>' +
      '<div class="bubble-wrap">' +
        '<div class="bubble">' + escHtml(introText || ('Sure! I need your location to ' + m.prompt + '.')) + '</div>' +
        '<div class="vet-location-card" id="vet-location-card">' +
          '<button type="button" class="btn btn-primary" id="vet-share-location-btn">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>' +
            ' Share my location' +
          '</button>' +
          '<p class="vet-location-note">Your location is only used for this search and is never stored.</p>' +
        '</div>' +
        '<div class="meta">' + fmtTime(new Date()) + '</div>' +
      '</div>';
    el.innerHTML = inner;
    messagesArea.appendChild(el);
    scrollToBottom();

    const shareBtn = el.querySelector('#vet-share-location-btn');
    shareBtn.addEventListener('click', function () {
      if (!navigator.geolocation) {
        showVetError('Your browser does not support location sharing. Please search Google Maps instead.');
        return;
      }
      shareBtn.disabled = true;
      shareBtn.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          shareBtn.closest('.vet-location-card').innerHTML = '<span style="color:var(--text-muted);font-size:.85rem">Location shared ✓</span>';
          const qs = 'lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude +
            '&category=' + encodeURIComponent(category || 'vet') +
            (sessionId ? '&session_id=' + encodeURIComponent(sessionId) : '');
          // The community pass can take a few seconds on the first lookup for an area, so
          // show a typing indicator rather than a blank wait.
          var typingEl = appendTypingIndicator();
          scrollToBottom();
          fetch('/api/vets/nearby?' + qs)
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (typingEl) typingEl.remove();
              if (data.ok) { adoptVetSession(data); showVetResults(data, data.category || category); }
              else { showVetError(data.error || 'Could not fetch nearby places.'); }
            })
            .catch(function () { if (typingEl) typingEl.remove(); showVetError('Network error — please try again.'); });
        },
        function (err) {
          shareBtn.disabled = false;
          shareBtn.textContent = 'Share my location';
          if (err.code === 1) {
            showVetError('Location access was denied. Enable location in your browser settings and try again.');
          } else {
            showVetError('Could not get your location. Please try again.');
          }
        },
        { timeout: 10000 }
      );
    });
  }

  // Find-button flow: append the canonical "Find …" user bubble, then the location card.
  function showLocationPrompt(category) {
    const m = PLACE_META[category] || PLACE_META.vet;
    appendUserMessage(m.userMsg);
    scrollToBottom();
    renderLocationCard(category);
  }

  // Wire the location button(s) → category picker (hero quick-pill + input icon button).
  ['vet-finder-btn', 'vet-finder-btn-toolbar'].forEach(function (id) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', showPlacePicker);
  });

  // ── Sidebar drag-to-resize ───────────────────────────────────────────────
  (function initSidebarResize() {
    const sidebar = document.querySelector('.chat-sidebar');
    const handle = document.getElementById('sidebar-resizer');
    if (!sidebar || !handle) return;
    const MIN = 200, MAX = 460;
    const stored = parseInt(localStorage.getItem('whoof-sidebar-w'), 10);
    if (stored >= MIN && stored <= MAX) sidebar.style.width = stored + 'px';

    let dragging = false;
    function onMove(e) {
      if (!dragging) return;
      const x = (e.touches ? e.touches[0].clientX : e.clientX);
      const w = Math.min(MAX, Math.max(MIN, x - sidebar.getBoundingClientRect().left));
      sidebar.style.width = w + 'px';
    }
    function stop() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing-sidebar');
      localStorage.setItem('whoof-sidebar-w', parseInt(sidebar.style.width, 10));
    }
    function start(e) { dragging = true; document.body.classList.add('resizing-sidebar'); e.preventDefault(); }
    handle.addEventListener('mousedown', start);
    handle.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
    // Double-click the handle to reset to default width.
    handle.addEventListener('dblclick', function () {
      sidebar.style.width = ''; localStorage.removeItem('whoof-sidebar-w');
    });
  })();

  // ── My Vet panel (collapsible; one or more saved vets; pre-visit summaries) ──
  (function initVetPanel() {
    const panel = document.getElementById('vet-panel');
    if (!panel) return;

    const toggle   = document.getElementById('vet-panel-toggle');
    const body     = document.getElementById('vet-panel-body');
    const listEl   = document.getElementById('vet-list');
    const countEl  = document.getElementById('vet-count');
    const addBtn   = document.getElementById('vet-add-btn');
    const form     = document.getElementById('vet-form');
    const cancelBtn= document.getElementById('vet-cancel-btn');
    const saveBtn  = document.getElementById('vet-save-btn');
    const nameIn   = document.getElementById('vet-name-input');
    const clinicIn = document.getElementById('vet-clinic-input');
    const phoneIn  = document.getElementById('vet-phone-input');
    const markBtn  = document.getElementById('vet-mark-visit-btn');
    const visitOut = document.getElementById('vet-visit-date');
    const visitPicker  = document.getElementById('vet-visit-picker');
    const visitInput   = document.getElementById('vet-visit-input');
    const visitConfirm = document.getElementById('vet-visit-confirm');
    const visitCancel  = document.getElementById('vet-visit-cancel');
    const scheduleBtn     = document.getElementById('vet-schedule-btn');
    const clearNextBtn    = document.getElementById('vet-clear-next-btn');
    const nextVisitOut     = document.getElementById('vet-next-visit-date');
    const schedulePicker   = document.getElementById('vet-schedule-picker');
    const scheduleInput    = document.getElementById('vet-schedule-input');
    const scheduleConfirm  = document.getElementById('vet-schedule-confirm');
    const scheduleCancel   = document.getElementById('vet-schedule-cancel');
    const prepBtn  = document.getElementById('vet-prep-btn');
    const rangeBox = document.getElementById('vet-range');

    function todayLocal() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    let vets = Array.isArray(window.__VETS__) ? window.__VETS__.slice() : [];
    let editingId = null; // null = adding, otherwise editing this vet's id

    // Collapsed by default; remember the owner's preference.
    function setOpen(open) {
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.classList.toggle('open', open);
      localStorage.setItem('whoof-vet-open', open ? '1' : '0');
    }
    setOpen(localStorage.getItem('whoof-vet-open') === '1');
    toggle.addEventListener('click', function () { setOpen(body.hidden); });

    function renderList() {
      countEl.textContent = vets.length;
      countEl.hidden = vets.length === 0;
      listEl.innerHTML = vets.map(function (v) {
        const tag = v.primary ? '<span class="vet-primary-tag">Primary</span>' : '';
        const phone = v.phone ? '<a class="vet-item-phone" href="tel:' + escHtml(v.phone) + '">' + escHtml(v.phone) + '</a>' : '';
        const makePrimary = v.primary ? '' : '<button type="button" class="vet-item-link" data-act="primary" data-id="' + escHtml(v.id) + '">Make primary</button>';
        return '<div class="vet-item' + (v.primary ? ' is-primary' : '') + '">' +
          '<div class="vet-item-main">' +
            '<div class="vet-item-name">' + (escHtml(v.name) || '<span class="vet-item-muted">Unnamed vet</span>') + tag + '</div>' +
            (v.clinic ? '<div class="vet-item-clinic">' + escHtml(v.clinic) + '</div>' : '') +
            phone +
          '</div>' +
          '<div class="vet-item-actions">' +
            makePrimary +
            '<button type="button" class="vet-item-link" data-act="edit" data-id="' + escHtml(v.id) + '">Edit</button>' +
            '<button type="button" class="vet-item-link danger" data-act="del" data-id="' + escHtml(v.id) + '">Remove</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    renderList();

    function persist() {
      return fetch('/api/vet/list', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vets: vets }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'save failed');
          vets = data.vets || [];
          window.__VETS__ = vets;
          renderList();
        })
        .catch(function () { alert('Could not save vet details. Please try again.'); });
    }

    function openForm(vet) {
      editingId = vet ? vet.id : null;
      nameIn.value   = vet ? (vet.name   || '') : '';
      clinicIn.value = vet ? (vet.clinic || '') : '';
      phoneIn.value  = vet ? (vet.phone  || '') : '';
      saveBtn.textContent = vet ? 'Save' : 'Add';
      addBtn.hidden = true; form.hidden = false; nameIn.focus();
    }
    function closeForm() { form.hidden = true; addBtn.hidden = false; editingId = null; }

    addBtn.addEventListener('click', function () { openForm(null); });
    cancelBtn.addEventListener('click', closeForm);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const entry = { name: nameIn.value.trim(), clinic: clinicIn.value.trim(), phone: phoneIn.value.trim() };
      if (!entry.name && !entry.clinic && !entry.phone) return;
      if (editingId) {
        vets = vets.map(function (v) { return v.id === editingId ? Object.assign({}, v, entry) : v; });
      } else {
        vets.push(Object.assign({ id: 'tmp-' + Date.now(), primary: vets.length === 0 }, entry));
      }
      saveBtn.disabled = true;
      persist().finally(function () { saveBtn.disabled = false; closeForm(); });
    });

    // Delegated actions on the vet list (edit / remove / make-primary).
    listEl.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      if (act === 'edit') { openForm(vets.find(function (v) { return v.id === id; })); return; }
      if (act === 'del') {
        const v = vets.find(function (x) { return x.id === id; });
        if (!confirm('Remove ' + ((v && v.name) || 'this vet') + '?')) return;
        vets = vets.filter(function (x) { return x.id !== id; });
        persist();
      }
      if (act === 'primary') {
        vets = vets.map(function (v) { return Object.assign({}, v, { primary: v.id === id }); });
        persist();
      }
    });

    // "Set date" reveals a calendar (defaulting to today, capped at today since a last
    // visit can't be in the future); Confirm records it and resets the summary boundary.
    markBtn.addEventListener('click', function () {
      const open = visitPicker.hidden;
      visitPicker.hidden = !open;
      if (open) { visitInput.max = todayLocal(); if (!visitInput.value) visitInput.value = todayLocal(); }
    });
    visitCancel.addEventListener('click', function () { visitPicker.hidden = true; });
    visitConfirm.addEventListener('click', function () {
      if (!visitInput.value) return;
      visitConfirm.disabled = true;
      fetch('/api/vet/mark-visit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: visitInput.value }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok && data.last_vet_visit_date) {
            const d = new Date(data.last_vet_visit_date + 'T00:00:00');
            visitOut.textContent = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            visitPicker.hidden = true;
            // A confirmed visit on/after the scheduled date fulfils it server-side.
            applyNextVisit(data.next_vet_visit_date || null);
          } else { alert(data.error || 'Could not record the visit.'); }
        })
        .catch(function () { alert('Network error — please try again.'); })
        .finally(function () { visitConfirm.disabled = false; });
    });

    // "Schedule"/"Change" reveals a calendar for a FUTURE appointment (min = today,
    // unlike the last-visit picker which is capped at today).
    scheduleBtn.addEventListener('click', function () {
      const open = schedulePicker.hidden;
      schedulePicker.hidden = !open;
      if (open) { scheduleInput.min = todayLocal(); if (!scheduleInput.value) scheduleInput.value = todayLocal(); }
    });
    scheduleCancel.addEventListener('click', function () { schedulePicker.hidden = true; });
    scheduleConfirm.addEventListener('click', function () {
      if (!scheduleInput.value) return;
      scheduleConfirm.disabled = true;
      fetch('/api/vet/schedule-visit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: scheduleInput.value }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            applyNextVisit(data.next_vet_visit_date);
            schedulePicker.hidden = true;
          } else { alert(data.error || 'Could not save the appointment date.'); }
        })
        .catch(function () { alert('Network error — please try again.'); })
        .finally(function () { scheduleConfirm.disabled = false; });
    });
    clearNextBtn.addEventListener('click', function () {
      if (!confirm('Clear the scheduled appointment?')) return;
      clearNextBtn.disabled = true;
      fetch('/api/vet/schedule-visit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: null }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) { if (data.ok) applyNextVisit(data.next_vet_visit_date); })
        .catch(function () {})
        .finally(function () { clearNextBtn.disabled = false; });
    });
    function applyNextVisit(dateStr) {
      if (dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        nextVisitOut.textContent = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        scheduleBtn.textContent = 'Change';
        clearNextBtn.hidden = false;
      } else {
        nextVisitOut.textContent = 'None scheduled';
        scheduleBtn.textContent = 'Schedule';
        clearNextBtn.hidden = true;
        scheduleInput.value = '';
      }
    }

    prepBtn.addEventListener('click', function () { rangeBox.hidden = !rangeBox.hidden; });
    rangeBox.querySelectorAll('.vet-range-opt').forEach(function (opt) {
      opt.addEventListener('click', function () {
        rangeBox.hidden = true;
        requestVetSummary(opt.getAttribute('data-range'));
      });
    });
  })();

  // Generate the pre-visit summaries and render them in the chat area.
  function requestVetSummary(range) {
    const messagesArea = document.getElementById('messages-area');
    const hero = messagesArea.querySelector('.empty-hero');
    if (hero) hero.remove();

    const loading = document.createElement('div');
    loading.className = 'message ai-message';
    loading.innerHTML = '<div class="ai-avatar">W</div><div class="bubble-wrap"><div class="bubble">Putting together a summary for your vet…</div></div>';
    messagesArea.appendChild(loading);
    scrollToBottom();

    fetch('/api/vet/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: range }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        loading.remove();
        if (data.ok) showVetSummary(data);
        else showVetError(data.error || 'Could not generate the summary.');
      })
      .catch(function () { loading.remove(); showVetError('Network error — please try again.'); });
  }

  function showVetSummary(data) {
    const messagesArea = document.getElementById('messages-area');
    const checklistHtml = (data.checklist || [])
      .map(function (c) { return '<li>' + escHtml(c) + '</li>'; }).join('');

    // If the owner asked for "since last visit" but none was logged, say so.
    const rangeNote = (data.requested_since_visit && data.range_used === 'history')
      ? '<div class="vet-sum-note">No past visit logged yet — showing your full recent history instead.</div>'
      : (data.range_used === 'since_visit'
          ? '<div class="vet-sum-note">Covering everything since your last visit' + (data.last_vet_visit_date ? ' (' + escHtml(data.last_vet_visit_date) + ')' : '') + '.</div>'
          : '<div class="vet-sum-note">Covering your recent chat history.</div>');

    const sendRow = data.whatsapp_url
      ? '<a class="btn btn-primary booking-send" href="' + escHtml(data.whatsapp_url) + '" target="_blank" rel="noopener">Send to vet via WhatsApp ↗</a>'
      : '<span class="booking-nophone">Add your vet’s phone number in “My Vet” to send this with one tap.</span>';

    const el = document.createElement('div');
    el.className = 'message ai-message';
    el.innerHTML =
      '<div class="ai-avatar">W</div>' +
      '<div class="bubble-wrap">' +
        '<div class="vet-sum-card">' +
          rangeNote +
          '<div class="vet-sum-section">' +
            '<div class="vet-sum-label">For your vet' + (data.vet_name ? ' — Dr ' + escHtml(data.vet_name) : '') + '</div>' +
            '<div class="vet-sum-briefing"></div>' +
            '<div class="booking-actions">' + sendRow +
              '<button type="button" class="btn btn-ghost vet-sum-copy">Copy briefing</button>' +
            '</div>' +
          '</div>' +
          '<div class="vet-sum-section">' +
            '<div class="vet-sum-label">Things to mention today</div>' +
            '<ul class="vet-sum-checklist">' + checklistHtml + '</ul>' +
          '</div>' +
        '</div>' +
        '<div class="meta">' + fmtTime(new Date()) + '</div>' +
      '</div>';
    el.querySelector('.vet-sum-briefing').textContent = data.briefing || '';
    messagesArea.appendChild(el);

    const copyBtn = el.querySelector('.vet-sum-copy');
    copyBtn.addEventListener('click', function () {
      const done = function () { copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy briefing'; }, 1800); };
      const text = data.briefing || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
      }
    });
    scrollToBottom();
  }
})();
