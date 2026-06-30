'use strict';

const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { query } = require('../db');
const { retrieveChunks, lookupBreed } = require('../lib/rag');
const { buildSystemPrompt, generateAnswer, toStructuredCard, generateSessionTitle } = require('../lib/llm');
const { triageQuestion } = require('../lib/triage');
const { getRollingSummary, rollUpInactiveChats } = require('../lib/memory');
const {
  detectDecision, loadActiveDecisions, saveDecision, isAffirmation, isDecline,
} = require('../lib/decisions');
const { findNearbyVets, findNearbyPlaces, searchPlaceByText, isValidCategory: isValidPlaceCategory } = require('../lib/vetFinder');
const { draftBookingMessage } = require('../lib/booking');
const { looksLikeBooking, detectBookingRequest } = require('../lib/bookingIntent');
const { generateVetSummaries } = require('../lib/vetSummary');
const webSearch = require('../lib/webSearch');
const { maybeUpdate: maybeUpdateExcel } = require('../lib/exportExcel');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Leading slash-commands that force a response format, independent of the model's own
// text-vs-structured choice. Case-insensitive; British/American spellings both accepted.
// Add more here (e.g. '/plan', '/breakdown') without touching the answer flow.
const FORMAT_COMMANDS = [
  { aliases: ['visualise', 'visualize'], modality: 'structured' },
];
// Returns { modality, cleaned }: the forced modality (or null) and the message with the
// command word stripped, so the stored/displayed question reads naturally.
function parseFormatCommand(text) {
  const m = (text || '').match(/^\/([a-z]+)\b[ \t]*/i);
  if (m) {
    const cmd = FORMAT_COMMANDS.find(c => c.aliases.includes(m[1].toLowerCase()));
    if (cmd) return { modality: cmd.modality, cleaned: text.slice(m[0].length).trim() };
  }
  return { modality: null, cleaned: (text || '').trim() };
}

// Is the owner asking what was previously decided/agreed/discussed (recall), rather
// than asking a fresh clinical question? Recall answers come from saved decisions and
// memory — they must NOT carry KB sources or a confidence tag.
const RECALL_RE = /\b(we (decided|agreed|chose|settled|discussed|talked about|came up with)|last (time|chat|session|conversation)|previous(ly)?( chat| session| conversation| time)?|earlier (chat|session|conversation|today|on)|you (said|told me|recommended|suggested|mentioned)|the (plan|diet|routine|advice) (we|you)|what (was|did|were|have) .*(decide|agree|recommend|settle|plan|discuss)|remember (when|that|the)|on record|saved (plan|diet|decision))\b/i;
const isRecallQuestion = (text) => RECALL_RE.test(text || '');

// "/visualise the previous answer", "this answer", "the earlier question" → the owner
// wants the LAST thing said laid out, not a fresh answer. Matched only when a structured
// command is active, so it can't hijack a normal message.
const REFERS_PREVIOUS_RE = /\b(previous|last|earlier|above|prior)\b[\s\S]{0,20}\b(answer|response|reply|message|recipe|plan|question|one|thing|info|steps?)\b|\b(this|that)\s+(answer|response|reply|one)\b|^\s*(this|that|it)\s*$/i;

// Fetch an existing session (with its pending offer) without creating one.
async function fetchSession(petId, id) {
  if (!isUuid(id)) return null;
  const r = await query(
    'SELECT id, pending_decision FROM conversation_session WHERE id = $1 AND pet_id = $2 LIMIT 1',
    [id, petId],
  );
  return r.rows[0] || null;
}

function setPending(sessionId, proposal) {
  return query('UPDATE conversation_session SET pending_decision = $2 WHERE id = $1',
    [sessionId, proposal ? JSON.stringify(proposal) : null]);
}
const clearPending = (sessionId) => setPending(sessionId, null);

// Persist one chat turn. Recall/confirmation/off-topic turns pass sources=[] and
// confidence=null so they read as plain statements, not KB-grounded clinical claims.
async function persistTurn({ petId, sessionId, message, answer, sources = [], confidence = null, escalated = false, escalationReason = null, symptomTags = [], structuredAnswer = null, responseModality = 'text', structuredTrigger = null }) {
  const r = await query(
    `INSERT INTO conversation_memory (
       pet_id, session_id, owner_question, answer_summary, sources_cited,
       symptom_tags, confidence_level, escalated, escalation_reason,
       structured_answer, response_modality, structured_trigger, structured_kind
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, created_at`,
    [petId, sessionId, message, answer, JSON.stringify(sources), symptomTags, confidence, escalated, escalationReason,
     structuredAnswer ? JSON.stringify(structuredAnswer) : null, responseModality, structuredTrigger,
     structuredAnswer ? (structuredAnswer.kind || null) : null],
  );
  await touchSession(sessionId);
  return r.rows[0];
}

// A short, clean title for a new chat, derived from its first message.
function titleFromMessage(msg) {
  const clean = (msg || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 48 ? clean.slice(0, 47).trimEnd() + '…' : clean;
}

// Returns { id, created } for the session this turn belongs to: the requested one
// if it's valid and belongs to this pet, otherwise a brand-new session titled from
// a truncated first message (a nicer summary title is generated by the caller).
async function resolveSession(petId, requestedId, firstMessage) {
  if (isUuid(requestedId)) {
    const r = await query(
      'SELECT id FROM conversation_session WHERE id = $1 AND pet_id = $2 LIMIT 1',
      [requestedId, petId],
    );
    if (r.rows.length) return { id: r.rows[0].id, created: false };
  }
  const created = await query(
    'INSERT INTO conversation_session (pet_id, title) VALUES ($1, $2) RETURNING id',
    [petId, titleFromMessage(firstMessage)],
  );
  return { id: created.rows[0].id, created: true };
}

// Bump a session to the top of the sidebar after a new turn.
function touchSession(sessionId) {
  return query('UPDATE conversation_session SET updated_at = now() WHERE id = $1', [sessionId]);
}

// The owner's pet (one per owner), or null. Used to scope session ownership.
async function petForOwner(ownerId) {
  const r = await query('SELECT id FROM pet_profile WHERE owner_id = $1 LIMIT 1', [ownerId]);
  return r.rows[0] || null;
}

// Summarise a brand-new chat's first message into a title and save it. Returns the
// title, or null on failure (the truncated fallback set at creation stays in place).
async function applySessionTitle(sessionId, firstMessage) {
  const title = await generateSessionTitle(firstMessage);
  if (title) {
    await query('UPDATE conversation_session SET title = $2 WHERE id = $1', [sessionId, title]);
  }
  return title;
}

// Simple keyword safety net — not NLP, intentionally over-triggers for a test.
const EMERGENCY_KEYWORDS = [
  "can't breathe", "cannot breathe", "not breathing", "difficulty breathing",
  "breathing difficulty", "struggling to breathe", "laboured breathing", "labored breathing",
  "gasping", "choking",
  "collapse", "collapsed", "unconscious", "unresponsive", "fainted", "passed out",
  "seizure", "fitting", "convulsion", "shaking violently", "trembling violently",
  "pale gums", "blue gums", "white gums", "grey gums",
  "bloated", "hard stomach", "hard abdomen", "distended abdomen", "twisted stomach", "bloat",
  "can't walk", "cannot walk", "unable to walk", "paralyzed", "paralysed",
  "can't stand", "cannot stand", "unable to stand",
  "heavy bleeding", "bleeding badly", "won't stop bleeding", "blood pouring",
  "swallowed poison", "ate poison", "rat poison", "suspected poison",
  "chocolate", "xylitol", "grapes", "raisins",
  "snake bite", "snake bit", "hit by car", "been hit by",
  "vomiting blood", "blood in vomit", "bloody vomit",
  "blood in stool", "bloody diarrhea", "bloody diarrhoea",
];

function checkEmergency(text) {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORDS.find(kw => lower.includes(kw)) || null;
}

const SYMPTOM_WORDS = [
  'vomit', 'diarrhea', 'diarrhoea', 'limp', 'scratch', 'itch', 'sneeze', 'cough',
  'fever', 'lethargy', 'lethargic', 'tired', 'not eating', 'appetite', 'weight loss',
  'bloat', 'pain', 'swollen', 'discharge', 'blood', 'seizure', 'collapse',
  'breathing', 'drinking', 'urinating', 'skin', 'ear', 'eye', 'paw', 'joint',
  'limping', 'shaking', 'trembling', 'scratching',
];

function extractSymptomTags(text) {
  const lower = text.toLowerCase();
  return SYMPTOM_WORDS.filter(w => lower.includes(w)).slice(0, 6);
}

// GET /chat
router.get('/chat', requireAuth, async (req, res) => {
  try {
    const petResult = await query(
      `SELECT p.*, o.owner_name FROM pet_profile p
       JOIN owners o ON o.id = p.owner_id
       WHERE p.owner_id = $1 LIMIT 1`,
      [req.session.ownerId],
    );
    if (!petResult.rows.length) return res.redirect('/onboarding');

    const pet = petResult.rows[0];
    const ownerName = pet.owner_name || '';

    // All chats for the sidebar: pinned first, then most recently used.
    const sessionsRes = await query(
      `SELECT id, title, pinned, updated_at FROM conversation_session
       WHERE pet_id = $1 ORDER BY pinned DESC, updated_at DESC`,
      [pet.id],
    );
    const sessions = sessionsRes.rows;

    // Pick the active chat: ?new=1 → fresh (not persisted until first message);
    // ?session=<id> → that chat if it's the pet's; otherwise the most recent.
    let activeSessionId = null;
    if (req.query.new === '1') {
      activeSessionId = null;
    } else if (isUuid(req.query.session) && sessions.some(s => s.id === req.query.session)) {
      activeSessionId = req.query.session;
    } else if (sessions.length) {
      activeSessionId = sessions[0].id;
    }

    let history = [];
    if (activeSessionId) {
      const histResult = await query(
        `SELECT cm.id, cm.created_at, cm.owner_question, cm.answer_summary, cm.sources_cited,
                cm.escalated, cm.confidence_level, cm.structured_answer,
                rf.rating AS fb_rating, rf.tags AS fb_tags, rf.comment AS fb_comment
         FROM conversation_memory cm
         LEFT JOIN response_feedback rf ON rf.memory_id = cm.id
         WHERE cm.session_id = $1
         ORDER BY cm.created_at ASC LIMIT 200`,
        [activeSessionId],
      );
      history = histResult.rows;
    }

    res.render('chat', { pet, history, sessions, activeSessionId, ownerName });
  } catch (err) {
    console.error('Chat GET error:', err);
    res.status(500).send('Error loading chat.');
  }
});

// Turns the owner's clarifying answers into one text block, appended to the
// original question — used both for retrieval and for the answer's context.
function enrichMessage(message, clarifications) {
  if (!clarifications.length) return message;
  const lines = clarifications.map(c => `- ${c.question} → ${c.answer}`).join('\n');
  return `${message}\n\nOwner's answers to triage questions:\n${lines}`;
}

// POST /api/chat/message
// Body: { message: string, clarifications?: [{ question, answer }] }
router.post('/api/chat/message', requireAuth, async (req, res) => {
  const rawMessage = (req.body.message || '').trim();
  if (!rawMessage) return res.status(400).json({ error: 'Message is required.' });

  // Slash-command override (e.g. "/visualise <question>") forces a structured card.
  // Strip the command so the stored/displayed question reads naturally; keep the raw
  // text if nothing follows the command (so we never answer an empty message). The
  // client also sends force_structured for the triage-clarification follow-up round.
  const parsedCmd = parseFormatCommand(rawMessage);
  const message = parsedCmd.cleaned || rawMessage;
  const forceStructured = (req.body.force_structured === true)
    || (parsedCmd.modality === 'structured' && parsedCmd.cleaned.length > 0);

  // Clarifying answers from a prior triage round (if the UI is on the 2nd submit)
  const clarifications = Array.isArray(req.body.clarifications)
    ? req.body.clarifications
        .filter(c => c && typeof c.question === 'string' && typeof c.answer === 'string' && c.answer.trim())
        .map(c => ({ question: c.question, answer: c.answer.trim() }))
    : [];

  try {
    const petResult = await query(
      `SELECT p.*, o.owner_name FROM pet_profile p
       JOIN owners o ON o.id = p.owner_id
       WHERE p.owner_id = $1 LIMIT 1`,
      [req.session.ownerId],
    );
    if (!petResult.rows.length) {
      return res.status(400).json({ error: 'No pet profile found. Please complete onboarding.' });
    }
    const pet = petResult.rows[0];

    // ── Pending save-offer? ────────────────────────────────────────────────────
    // If the bot just offered to save a decision in this chat, the owner's next
    // message confirms ("yes" → save it) or declines ("no" → drop it). Anything
    // else lets the offer expire and falls through to a normal answer.
    if (clarifications.length === 0) {
      const existing = await fetchSession(pet.id, req.body.session_id);
      if (existing && existing.pending_decision) {
        const pd = existing.pending_decision;
        if (isAffirmation(message)) {
          const saved = await saveDecision(pet.id, pd);
          await clearPending(existing.id);
          const confirmMsg = `Done — I've saved **${saved.title}** to ${pet.name}'s record. I'll use it to keep future answers consistent, and you can find it on record anytime.`;
          const mem = await persistTurn({ petId: pet.id, sessionId: existing.id, message, answer: confirmMsg });
          res.json({
            answer: confirmMsg, sources: [], escalated: false, confidence_level: null,
            decision_saved: true, session_id: existing.id,
            memory_id: mem.id, created_at: mem.created_at,
          });
          rollUpInactiveChats(pet.id, existing.id).catch(() => {});
          return;
        }
        if (isDecline(message)) {
          await clearPending(existing.id);
          const declineMsg = `No problem — I won't save that. Anything else about ${pet.name}?`;
          const mem = await persistTurn({ petId: pet.id, sessionId: existing.id, message, answer: declineMsg });
          res.json({
            answer: declineMsg, sources: [], escalated: false, confidence_level: null,
            decision_declined: true, session_id: existing.id,
            memory_id: mem.id, created_at: mem.created_at,
          });
          return;
        }
        // Neither yes nor no → the offer lapses; answer their new message normally.
        await clearPending(existing.id);
      }
    }

    // ── Vet booking request? ───────────────────────────────────────────────────
    // "Book a vet appointment", "help booking Maxpetz", etc. → draft a WhatsApp
    // message instead of letting the model refuse it as "not my job". The cheap regex
    // gate keeps this off the normal path; the handler re-confirms with the model and
    // returns false (falls through to a normal answer) if it's not really a booking.
    if (clarifications.length === 0 && looksLikeBooking(message)) {
      const handled = await handleBookingRequest({ req, res, pet, message, rawMessage });
      if (handled) return;
    }

    // Enriched text includes clarifying answers (used for emergency check + retrieval)
    const enriched = enrichMessage(message, clarifications);

    // Emergency check first — emergencies short-circuit triage and are answered now.
    const emergencyMatch = checkEmergency(enriched);
    const escalated = !!emergencyMatch;
    const escalationReason = emergencyMatch ? `Keyword match: "${emergencyMatch}"` : null;

    // ── Triage step ──────────────────────────────────────────────────────────
    // Runs on the FIRST submit only (no clarifications yet) and not for emergencies.
    if (!escalated && clarifications.length === 0) {
      const triage = await triageQuestion(message, pet);

      // 1. Off-topic → polite decline, no expensive answer call.
      if (!triage.pet_related) {
        const decline = triage.decline_message
          || `I'm Whoof AI — I can only help with ${pet.name} and other pet-health questions. Ask me anything about ${pet.name} and I'm happy to help!`;
        const session = await resolveSession(pet.id, req.body.session_id, message);
        const sessionTitle = session.created ? await applySessionTitle(session.id, message) : null;
        const mem = await persistTurn({
          petId: pet.id, sessionId: session.id, message, answer: decline,
          escalationReason: 'off_topic',
        });
        res.json({
          off_topic: true,
          answer: decline,
          sources: [],
          escalated: false,
          confidence_level: null,
          session_id: session.id,
          session_title: sessionTitle || undefined,
          memory_id: mem.id,
          created_at: mem.created_at,
        });
        rollUpInactiveChats(pet.id, session.id).catch(() => {});
        return;
      }

      // 2. Needs clarification → return questions, don't answer or persist yet.
      if (triage.needs_clarification) {
        return res.json({
          needs_clarification: true,
          original_message: message,
          clarifying_questions: triage.clarifying_questions,
        });
      }
      // 3. Otherwise fall through and answer directly.
    }

    // ── Answer path ──────────────────────────────────────────────────────────

    // Breed lookup — direct table query, not vector search
    let breedInfo = null;
    try {
      breedInfo = await lookupBreed(pet.breed);
    } catch (breedErr) {
      console.warn('Breed lookup failed (run migration 009):', breedErr.message);
    }

    // The chat this turn belongs to (creates one on the first message).
    const session = await resolveSession(pet.id, req.body.session_id, message);
    const sessionId = session.id;

    // Recent history for context — THIS chat only (last 5 exchanges, oldest first)
    const histResult = await query(
      `SELECT owner_question, answer_summary FROM conversation_memory
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [sessionId],
    );
    const recentHistory = histResult.rows.reverse();

    // "/visualise the previous answer" / "this answer" → don't run retrieval on the words
    // "the previous answer" (that fetches unrelated KB chunks). Instead recast the most
    // recent assistant turn into a card. Only meaningful with a forced structured command.
    const refersToPrevious = forceStructured && REFERS_PREVIOUS_RE.test(message);
    const recastText = (refersToPrevious && recentHistory.length)
      ? (recentHistory[recentHistory.length - 1].answer_summary || null)
      : null;

    // Cross-session memory, injected as plain fact: locked decisions + one rolling
    // summary. No vector search over conversations — these are stated, not retrieved.
    const [decisions, rollingSummary] = await Promise.all([
      loadActiveDecisions(pet.id),
      getRollingSummary(pet.id),
    ]);

    // RAG retrieval — KB chunks ONLY (the PDFs), never conversation transcripts.
    let chunks = [];
    let topSimilarity = 0;
    let topCosine = 0;
    let rewrittenQuery = enriched;

    // Skip retrieval entirely for a recast — we're reformatting an answer we already gave,
    // not answering a new question, so there's nothing to look up (and no web fallback).
    if (!recastText) {
      try {
        const retrieved = await retrieveChunks(enriched, 5);
        chunks = retrieved.chunks;
        rewrittenQuery = retrieved.rewritten_query || enriched;
        topSimilarity = parseFloat(chunks[0]?.rrf_score ?? chunks[0]?.similarity ?? 0);
        // Cosine similarity of the best chunk is the real relevance signal — RRF scores
        // only reflect rank position (always ~0.016 at rank 1), so they can't tell a good
        // KB match from a bad one. Cosine can: solid vet topics land ~0.70+, off-KB ~0.5.
        topCosine = parseFloat(chunks[0]?.cosine_sim ?? 0);
      } catch (ragErr) {
        console.warn('RAG retrieval failed (proceeding without KB):', ragErr.message);
      }
    }

    // Web search FALLBACK: only when the KB had no good match, and never for emergencies
    // or recall ("what did we decide?") questions. The pet-vs-not gate already happened in
    // triage, so this can't turn into a general search engine. Fail-soft → [] on any error.
    const recall = isRecallQuestion(message);
    // Cosine alone is phrasing-sensitive, so pair it with intent: questions that clearly
    // want external/fresh facts (a phone/address, "latest/newest", prices, a year) the
    // static KB can't hold get a higher bar before we trust the KB and skip the web.
    const wantsExternal = /\b(phone|mobile|number|contact|email|address|website|nearby|latest|newest|recent|price|cost|how much|buy|purchase|in stock|available|recall|20(2[4-9]|3\d))\b/i.test(message);
    const kbWeak = chunks.length === 0 || topCosine < (wantsExternal ? 0.72 : 0.6);
    let webResults = [];
    if (kbWeak && !escalated && !recall && !recastText && webSearch.isConfigured()) {
      webResults = await webSearch.searchWeb(rewrittenQuery !== enriched ? rewrittenQuery : message);
    }

    const systemPrompt = buildSystemPrompt(pet, chunks, recentHistory, breedInfo, {
      clarifications, decisions, rollingSummary, ownerName: pet.owner_name || '', webResults,
    });

    // Generate the answer and (for a brand-new chat) a summary title.
    // Cards are OPT-IN: only an explicit /visualise slash command (forceStructured)
    // produces a structured card. Every other message — and every emergency — is plain
    // text. `answer` is always the canonical text (a structured reply's fallbackText)
    // so every downstream path works unchanged.
    //
    // /visualise = answer as TEXT on the big model, then lay it out as a card on the FAST
    // model (toStructuredCard). This avoids the heavy forced-structured call that 429s on
    // Groq's per-minute token limit and silently degrades to plain text. A recast reuses
    // the previous answer's text directly, so it needs no big-model call at all.
    let answer, structuredAnswer = null, responseModality = 'text', sessionTitle = null;
    if (forceStructured && !escalated) {
      const baseText = recastText || await generateAnswer(systemPrompt, message);
      const [card, title] = await Promise.all([
        toStructuredCard({ pet, text: baseText }),
        session.created ? applySessionTitle(sessionId, message) : Promise.resolve(null),
      ]);
      structuredAnswer = card;
      answer = card.fallbackText || baseText;
      responseModality = 'structured';
      sessionTitle = title;
    } else {
      const [text, title] = await Promise.all([
        generateAnswer(systemPrompt, message),
        session.created ? applySessionTitle(sessionId, message) : Promise.resolve(null),
      ]);
      answer = text;
      sessionTitle = title;
    }
    // A structured card now only ever comes from the /visualise command.
    const structuredTrigger = structuredAnswer ? 'command' : null;

    // Sources + confidence attach ONLY to grounded clinical answers — never to a
    // recall ("what did we decide?") answer.
    const usedFallback = kbWeak;
    const kbGrounded = !usedFallback && !recall;
    const webGrounded = usedFallback && !recall && webResults.length > 0;

    let confidenceLevel = null;
    let sourcesCited = [];
    if (kbGrounded) {
      confidenceLevel = chunks.length >= 3 && topSimilarity > 0.02 ? 'high' : 'medium';
      sourcesCited = chunks.map(c => ({
        source: c.source_title || c.source,
        topic: c.topic,
        section: c.section || null,
        chunk_type: c.chunk_type || 'body',
        page_number: c.page_number || null,
        rrf_score: parseFloat(parseFloat(c.rrf_score ?? c.similarity ?? 0).toFixed(4)),
      }));
    } else if (webGrounded) {
      // Cite the web pages, with a `url` so the UI can render them as links.
      confidenceLevel = 'medium';
      sourcesCited = webResults.map(w => ({ source: w.title, url: w.url, topic: 'web' }));
    }

    // Proactively offer to save a finalized decision. Skipped for emergencies and
    // recall. Runs when the owner explicitly asks to save/lock something, or when the
    // answer is substantive enough to plausibly contain a finalized plan.
    const explicitSave = /\b(lock (this|that|it) in|lock it in|save (this|that|it)( as)?|make (this|that|it) (his|her|the) official|set (this|that) as|official (plan|diet|routine)|update (his|her|the) (plan|diet|routine))\b/i.test(message);
    let finalAnswer = answer;
    let decisionOffer = false;
    let offerTitle = null, offerType = null, offerSummary = null;
    // A structured reply owns its own actions (incl. save_decision), so skip the legacy
    // pending-decision popup for those — it would double up the save UI.
    if (!escalated && !recall && !structuredAnswer && answer && (explicitSave || answer.length > 160)) {
      const proposal = await detectDecision({ petName: pet.name, message, answer, recentHistory });
      if (proposal.decision_ready && proposal.offer_message) {
        await setPending(sessionId, {
          decision_type: proposal.decision_type,
          title: proposal.title,
          content: proposal.content,
        });
        // Keep the answer clean — the offer is shown as a popup card in the UI.
        decisionOffer = true;
        offerTitle = proposal.title;
        offerType = proposal.decision_type;
        offerSummary = proposal.content?.summary || '';
        // An offer turn is about a decision, not a guideline claim — drop the
        // sources/confidence UI so it reads as a plain acknowledgement.
        sourcesCited = [];
        confidenceLevel = null;
      }
    }

    const symptomTags = extractSymptomTags(enriched);
    const mem = await persistTurn({
      // Store the raw text (incl. any "/visualise" prefix) so the chat shows the
      // command on reload; the model/retrieval already used the stripped `message`.
      petId: pet.id, sessionId, message: rawMessage, answer: finalAnswer,
      sources: sourcesCited, confidence: confidenceLevel,
      escalated, escalationReason, symptomTags,
      structuredAnswer, responseModality, structuredTrigger,
    });

    res.json({
      answer: finalAnswer,
      structured_answer: structuredAnswer || undefined,
      response_modality: responseModality,
      sources: sourcesCited,
      escalated,
      escalation_reason: escalationReason,
      confidence_level: confidenceLevel,
      used_fallback: usedFallback && !recall && !decisionOffer && !structuredAnswer && !webGrounded,
      web_grounded: webGrounded || undefined,
      decision_offer: decisionOffer,
      offer_title: offerTitle || undefined,
      offer_type: offerType || undefined,
      offer_summary: offerSummary || undefined,
      rewritten_query: rewrittenQuery !== enriched ? rewrittenQuery : undefined,
      session_id: sessionId,
      session_title: sessionTitle || undefined,
      memory_id: mem.id,
      created_at: mem.created_at,
    });

    // Roll completed (non-active) chats into the single rolling summary, after
    // responding so the owner never waits on it.
    rollUpInactiveChats(pet.id, sessionId).catch(() => {});
    // Keep the Excel export up to date for the tracked tester account (fire-and-forget).
    maybeUpdateExcel(req.session.ownerId).catch(() => {});
  } catch (err) {
    console.error('Chat message error:', err);
    res.status(500).json({ error: 'Failed to get a response. Please try again.' });
  }
});

// POST /api/chat/session/:id/pin — toggle a chat's pinned state
router.post('/api/chat/session/:id/pin', requireAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });
    const r = await query(
      `UPDATE conversation_session SET pinned = NOT pinned
       WHERE id = $1 AND pet_id = $2 RETURNING pinned`,
      [req.params.id, pet.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Chat not found.' });
    res.json({ pinned: r.rows[0].pinned });
  } catch (err) {
    console.error('Pin toggle error:', err);
    res.status(500).json({ error: 'Could not update chat.' });
  }
});

// DELETE /api/chat/session/:id — delete a chat (its turns cascade away)
router.delete('/api/chat/session/:id', requireAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });
    const r = await query(
      'DELETE FROM conversation_session WHERE id = $1 AND pet_id = $2 RETURNING id',
      [req.params.id, pet.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Chat not found.' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete session error:', err);
    res.status(500).json({ error: 'Could not delete chat.' });
  }
});

// POST /api/chat/session/:id/decision/confirm — save the pending offer without typing "yes"
router.post('/api/chat/session/:id/decision/confirm', requireAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });
    const petRow = await query('SELECT name FROM pet_profile WHERE id = $1', [pet.id]);
    const petName = petRow.rows[0]?.name || 'your dog';
    const session = await fetchSession(pet.id, req.params.id);
    if (!session || !session.pending_decision) {
      return res.status(404).json({ error: 'No pending offer for this chat.' });
    }
    const saved = await saveDecision(pet.id, session.pending_decision);
    await clearPending(session.id);
    const confirmMsg = `Done — I've saved **${saved.title}** to ${petName}'s record. I'll use it to keep future answers consistent.`;
    const mem = await persistTurn({ petId: pet.id, sessionId: session.id, message: '[decision confirmed via popup]', answer: confirmMsg });
    res.json({ ok: true, title: saved.title, answer: confirmMsg, created_at: mem.created_at, memory_id: mem.id });
  } catch (err) {
    console.error('Decision confirm error:', err);
    res.status(500).json({ error: 'Could not save decision.' });
  }
});

// POST /api/chat/session/:id/decision/save — save a decision from an explicit payload.
// Used by the `save_decision` action button on a structured-answer card (which carries
// its own { title, decision_type, summary }), separate from the legacy pending-offer flow.
const DECISION_TYPES = ['diet_plan', 'allergy', 'diagnosis', 'treatment_routine', 'other'];
router.post('/api/chat/session/:id/decision/save', requireAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });
    const session = await fetchSession(pet.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'Chat not found.' });

    const petRow = await query('SELECT name FROM pet_profile WHERE id = $1', [pet.id]);
    const petName = petRow.rows[0]?.name || 'your dog';

    const title = (req.body.title || '').toString().trim().slice(0, 120);
    if (!title) return res.status(400).json({ error: 'A title is required.' });
    const decisionType = DECISION_TYPES.includes(req.body.decision_type) ? req.body.decision_type : 'other';
    const summary = (req.body.summary || '').toString().trim().slice(0, 600);

    const saved = await saveDecision(pet.id, {
      decision_type: decisionType,
      title,
      content: summary ? { summary } : {},
    });
    const confirmMsg = `Done — I've saved **${saved.title}** to ${petName}'s record. I'll use it to keep future answers consistent.`;
    const mem = await persistTurn({ petId: pet.id, sessionId: session.id, message: '[plan saved via card]', answer: confirmMsg });
    res.json({ ok: true, title: saved.title, answer: confirmMsg, created_at: mem.created_at, memory_id: mem.id });
  } catch (err) {
    console.error('Decision save error:', err);
    res.status(500).json({ error: 'Could not save decision.' });
  }
});

// ── Response feedback (tester ratings) ─────────────────────────────────────
// A lightweight feedback LOG for manual review — NOT a training pipeline. One
// upsertable row per turn. Lives here alongside the other session-scoped owner actions
// (pin/delete/decision) so it shares requireAuth, the owner→pet scoping, and isUuid,
// rather than duplicating all of that in a one-route file. Purely additive: this never
// touches the chat/triage/RAG flow, and a failure here can't block a conversation.
const FEEDBACK_TAGS = [
  'wrong_info', 'missed_pet_context', 'too_long', 'too_vague',
  'misunderstood_question', 'tone_off', 'exactly_right',
];

// POST /api/chat/feedback  Body: { memory_id, rating, tags?, comment? }
router.post('/api/chat/feedback', requireAuth, async (req, res) => {
  try {
    const memoryId = req.body.memory_id;
    if (!isUuid(memoryId)) return res.status(400).json({ error: 'Invalid memory_id.' });

    // rating must be an integer 1–10 — reject anything else.
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
      return res.status(400).json({ error: 'rating must be an integer from 1 to 10.' });
    }

    // tags: keep only known values; silently drop unknown ones (don't fail the request
    // over one bad tag), and de-dupe. Never trust whatever the client sent.
    const tags = Array.isArray(req.body.tags)
      ? Array.from(new Set(req.body.tags.filter(t => FEEDBACK_TAGS.includes(t))))
      : [];

    // comment: optional free text, capped.
    const comment = req.body.comment != null
      ? (String(req.body.comment).trim().slice(0, 2000) || null)
      : null;

    // Ownership gate: the turn must belong to THIS owner's pet. This both authorizes the
    // write and is the source of owner_id we store — one tester can never rate, or even
    // probe the existence of, another tester's turn (missing vs. not-yours look identical).
    const owned = await query(
      `SELECT cm.id
         FROM conversation_memory cm
         JOIN pet_profile p ON p.id = cm.pet_id
        WHERE cm.id = $1 AND p.owner_id = $2
        LIMIT 1`,
      [memoryId, req.session.ownerId],
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Turn not found.' });

    const upsert = await query(
      `INSERT INTO response_feedback (memory_id, owner_id, rating, tags, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (memory_id) DO UPDATE
         SET rating  = EXCLUDED.rating,
             tags    = EXCLUDED.tags,
             comment = EXCLUDED.comment
       RETURNING memory_id, rating, tags, comment, created_at, updated_at`,
      [memoryId, req.session.ownerId, rating, tags, comment],
    );
    res.json({ ok: true, feedback: upsert.rows[0] });
  } catch (err) {
    console.error('Feedback submit error:', err);
    res.status(500).json({ error: 'Could not save feedback.' });
  }
});

// POST /api/chat/session/:id/decision/dismiss — dismiss the pending offer without typing "no"
router.post('/api/chat/session/:id/decision/dismiss', requireAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });
    await clearPending(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Decision dismiss error:', err);
    res.status(500).json({ error: 'Could not dismiss offer.' });
  }
});

// Per-category copy for the nearby-places search (used for the chat title + stored turn).
const PLACE_COPY = {
  vet:  { userMsg: 'Find a vet nearby',          title: 'Nearby vets',  heading: 'Here are veterinary clinics near you:', empty: 'I couldn’t find any vets within range. Try asking your local pet store or a neighbour for a recommendation.' },
  park: { userMsg: 'Find parks nearby',          title: 'Nearby parks', heading: 'Here are parks near you for a walk:',     empty: 'I couldn’t find any parks within range. Try a wider area on Google Maps.' },
  cafe: { userMsg: 'Find pet-friendly cafés',    title: 'Pet-friendly spots', heading: 'Here are cafés & restaurants near you (call ahead to confirm they’re pet-friendly):', empty: 'I couldn’t find any cafés or restaurants within range. Try a wider area on Google Maps.' },
};

// GET /api/vets/nearby?lat=&lng=&radius=&category=vet|park|cafe
// Returns up to 6 nearby places of the chosen category from Google Places.
router.get('/api/vets/nearby', requireAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid coordinates.' });
  }
  const category = isValidPlaceCategory(req.query.category) ? req.query.category : 'vet';
  const copy = PLACE_COPY[category];
  const radius = Math.min(Math.max(parseInt(req.query.radius) || 5000, 500), 20000);
  try {
    const places = await findNearbyPlaces(lat, lng, category, radius);

    // Persist as a chat turn so the search shows up in the sidebar and survives a
    // reload — same session handshake as a normal message. The live UI renders rich
    // cards; the stored markdown is what re-renders on reload.
    let sessionId = null;
    let sessionTitle;
    const pet = await petForOwner(req.session.ownerId);
    if (pet) {
      const session = await resolveSession(pet.id, req.query.session_id, copy.userMsg);
      sessionId = session.id;
      if (session.created) {
        sessionTitle = copy.title;
        await query('UPDATE conversation_session SET title = $2 WHERE id = $1', [sessionId, sessionTitle]);
      }
      const answer = places.length
        ? copy.heading + '\n\n' + places.map((v, i) =>
            `${i + 1}. **${v.name}**` +
            (v.rating ? ` — ⭐ ${v.rating}${v.reviews ? ` (${v.reviews})` : ''}` : '') +
            (v.open === true ? ' · Open now' : v.open === false ? ' · Closed' : '') +
            (v.address ? `\n${v.address}` : '') +
            `\n[Directions](${v.mapsUrl})`,
          ).join('\n\n')
        : copy.empty;
      await persistTurn({ petId: pet.id, sessionId, message: copy.userMsg, answer });
    }

    res.json({ ok: true, category, vets: places, session_id: sessionId || undefined, session_title: sessionTitle });
  } catch (err) {
    console.error('Place finder error:', err.message);
    const configErr = err.message.includes('GOOGLE_PLACES_API_KEY');
    res.status(configErr ? 503 : 500).json({ error: configErr
      ? 'Nearby search is not configured yet — ask the Whoof team.'
      : 'Could not fetch nearby places. Please try again.' });
  }
});

// POST /api/vets/booking-draft
// Body: { clinic_name, clinic_phone?, session_id? }
// Drafts a short WhatsApp booking message for a clinic, using the pet profile and (when
// a session is passed) the recent conversation to infer a visit reason. Returns the
// message plus a wa.me deep link when the clinic's phone number is known. Whoof only
// drafts — the owner taps send, so this works for any clinic with no integration.
router.post('/api/vets/booking-draft', requireAuth, async (req, res) => {
  try {
    const clinicName = (req.body.clinic_name || '').toString().trim().slice(0, 160);
    if (!clinicName) return res.status(400).json({ error: 'Clinic name is required.' });
    const clinicPhone = (req.body.clinic_phone || '').toString().trim().slice(0, 40);

    const petResult = await query(
      `SELECT p.*, o.owner_name FROM pet_profile p
       JOIN owners o ON o.id = p.owner_id
       WHERE p.owner_id = $1 LIMIT 1`,
      [req.session.ownerId],
    );
    if (!petResult.rows.length) return res.status(400).json({ error: 'No pet profile found.' });
    const pet = petResult.rows[0];

    // Pull a few recent turns of THIS chat (only if it belongs to this pet) to infer a
    // visit reason — never another owner's session.
    let recentHistory = [];
    if (isUuid(req.body.session_id)) {
      const owned = await query(
        'SELECT id FROM conversation_session WHERE id = $1 AND pet_id = $2 LIMIT 1',
        [req.body.session_id, pet.id],
      );
      if (owned.rows.length) {
        const h = await query(
          `SELECT owner_question, answer_summary FROM conversation_memory
           WHERE session_id = $1 ORDER BY created_at DESC LIMIT 5`,
          [req.body.session_id],
        );
        recentHistory = h.rows.reverse();
      }
    }

    const message = await draftBookingMessage({
      pet, ownerName: pet.owner_name || '', clinicName, recentHistory,
    });

    // wa.me wants digits with country code and no separators; strip everything else.
    const digits = clinicPhone.replace(/[^\d]/g, '');
    const whatsappUrl = digits.length >= 8
      ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
      : null;

    res.json({ ok: true, clinic_name: clinicName, message, whatsapp_url: whatsappUrl || undefined });
  } catch (err) {
    console.error('Booking draft error:', err);
    res.status(500).json({ error: 'Could not draft a booking message. Please try again.' });
  }
});

// wa.me wants digits with country code and no separators.
function whatsappLink(phone, text) {
  const digits = (phone || '').replace(/[^\d]/g, '');
  return digits.length >= 8 ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}

// Loose clinic-name match: case/punctuation-insensitive. Matches when one name contains
// the other ("Maxpetz" ⊂ "Maxpetz Pet Clinic"), or when both share the same distinctive
// brand word after dropping generic vet words ("Maxpetz Pet Clinic" ↔ "Maxpetz Jubilee
// Hills"). The generic-word filter stops a shared area/word like "Jubilee" or "Clinic"
// from matching two different clinics.
const CLINIC_STOPWORDS = new Set([
  'pet', 'pets', 'clinic', 'vet', 'vets', 'veterinary', 'hospital', 'care', 'centre',
  'center', 'animal', 'animals', 'dr', 'the', 'in', 'at', 'and', 'for', 'of', 'dog', 'dogs',
]);
function clinicMatches(a, b) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const sig = (s) => s.split(' ').filter(t => t.length >= 3 && !CLINIC_STOPWORDS.has(t));
  const sa = sig(x), sb = sig(y);
  return sa.length > 0 && sb.length > 0 && sa[0] === sb[0];
}

// Handle an in-chat vet-booking request end to end: confirm the intent, resolve the
// clinic's phone (saved vet first, else a Google Places lookup), draft a WhatsApp
// message, and reply with a one-tap wa.me link. Returns true if it owned the response,
// or false to let the normal answer path handle the message (not actually a booking).
async function handleBookingRequest({ req, res, pet, message, rawMessage }) {
  // Recent turns of THIS session (only if it's a real, owned session) — lets the model
  // resolve "this place" / "the first one" and gives the draft a visit reason.
  let recentHistory = [];
  if (isUuid(req.body.session_id)) {
    const owned = await query(
      'SELECT id FROM conversation_session WHERE id = $1 AND pet_id = $2 LIMIT 1',
      [req.body.session_id, pet.id],
    );
    if (owned.rows.length) {
      const h = await query(
        `SELECT owner_question, answer_summary FROM conversation_memory
         WHERE session_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [req.body.session_id],
      );
      recentHistory = h.rows.reverse();
    }
  }

  const savedVets = Array.isArray(pet.vets) ? pet.vets : [];
  const detect = await detectBookingRequest({ message, recentHistory, savedVets });
  if (!detect.wants_booking) return false; // not a booking → fall through to normal answer

  // Commit to a session only now that we know it's a booking (avoids creating an empty
  // chat for a message that turns out to be something else).
  const session = await resolveSession(pet.id, req.body.session_id, message);
  const sessionId = session.id;
  const sessionTitle = session.created ? await applySessionTitle(sessionId, message) : null;

  const clinicName = detect.clinic_name;
  let answer;

  if (!clinicName) {
    // No clinic identified yet → ask which one, surfacing saved vets as quick options.
    const saved = savedVets.filter(v => v.clinic || v.name);
    answer = saved.length
      ? `Happy to help you book an appointment for ${pet.name}. Which clinic — ` +
        saved.map(v => `**${v.clinic || v.name}**`).join(', ') +
        `, or somewhere else? Tell me the name and I'll draft a WhatsApp message you can send.`
      : `Happy to help you book an appointment for ${pet.name}. Just tell me the clinic ` +
        `(e.g. "book at Maxpetz, Jubilee Hills") and I'll draft a WhatsApp message you can send.`;
  } else {
    // Resolve a phone: a saved vet first (no API call), else a Google Places text lookup.
    let phone = null;
    let mapsUrl = null;
    const matchSaved = savedVets.find(v =>
      clinicMatches(v.clinic, clinicName) || clinicMatches(v.name, clinicName));
    if (matchSaved && matchSaved.phone) {
      phone = matchSaved.phone;
    } else {
      try {
        const place = await searchPlaceByText(`${clinicName} veterinary clinic`);
        if (place) { phone = place.phone; mapsUrl = place.mapsUrl; }
      } catch (e) {
        console.warn('Booking place lookup failed:', e.message);
      }
    }

    const draft = await draftBookingMessage({
      pet, ownerName: pet.owner_name || '', clinicName, recentHistory,
    });
    const oneLineDraft = draft.replace(/\s*\n+\s*/g, ' ').trim();
    const waUrl = whatsappLink(phone, draft);

    if (waUrl) {
      answer =
        `Here's a ready-to-send booking request for **${clinicName}** — tap to open WhatsApp ` +
        `with the message filled in:\n\n` +
        `> ${oneLineDraft}\n\n` +
        `[Open WhatsApp →](${waUrl})\n\n` +
        `_I only draft it — give it a quick read and tap send when you're happy._`;
    } else {
      const mapLine = mapsUrl ? `\n\n[Find ${clinicName} on Google Maps →](${mapsUrl})` : '';
      answer =
        `I've drafted a booking message for **${clinicName}**, but I couldn't find a phone ` +
        `number to build the WhatsApp link. Add the clinic's number under MY VET (or paste it ` +
        `here) and I'll turn this into a one-tap link:\n\n` +
        `> ${oneLineDraft}` + mapLine;
    }
  }

  const mem = await persistTurn({ petId: pet.id, sessionId, message: rawMessage, answer });
  res.json({
    answer,
    sources: [], escalated: false, confidence_level: null,
    session_id: sessionId,
    session_title: sessionTitle || undefined,
    memory_id: mem.id, created_at: mem.created_at,
  });
  rollUpInactiveChats(pet.id, sessionId).catch(() => {});
  maybeUpdateExcel(req.session.ownerId).catch(() => {});
  return true;
}

// Normalise a client-supplied vets array: cap the count, sanitise each entry, drop
// fully-empty rows, and guarantee exactly one primary (the first, if none flagged).
const { randomUUID } = require('crypto');
function normalizeVets(input) {
  const arr = Array.isArray(input) ? input : [];
  const cleaned = arr
    .map(v => ({
      id:      (v && typeof v.id === 'string' && v.id) ? v.id.slice(0, 64) : randomUUID(),
      name:    (v && v.name   ? String(v.name)   : '').trim().slice(0, 120),
      clinic:  (v && v.clinic ? String(v.clinic) : '').trim().slice(0, 160),
      phone:   (v && v.phone  ? String(v.phone)  : '').trim().slice(0, 40),
      primary: !!(v && v.primary),
    }))
    .filter(v => v.name || v.clinic || v.phone)
    .slice(0, 10);
  if (cleaned.length) {
    const firstPrimary = cleaned.findIndex(v => v.primary);
    cleaned.forEach((v, i) => { v.primary = i === (firstPrimary === -1 ? 0 : firstPrimary); });
  }
  return cleaned;
}
const primaryVet = (vets) => (Array.isArray(vets) ? (vets.find(v => v.primary) || vets[0] || null) : null);

// PUT /api/vet/list — save the full set of the owner's saved vets (one flagged primary).
router.put('/api/vet/list', requireAuth, async (req, res) => {
  try {
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });
    const vets = normalizeVets(req.body.vets);
    await query(
      'UPDATE pet_profile SET vets = $2::jsonb, updated_at = now() WHERE id = $1',
      [pet.id, JSON.stringify(vets)],
    );
    res.json({ ok: true, vets });
  } catch (err) {
    console.error('Vet list save error:', err);
    res.status(500).json({ error: 'Could not save vet details.' });
  }
});

// POST /api/vet/mark-visit — record that a vet visit happened (defaults to today).
// Sets the boundary for "summary since last visit" so the next visit starts fresh.
router.post('/api/vet/mark-visit', requireAuth, async (req, res) => {
  try {
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });
    // Optional explicit date (YYYY-MM-DD); otherwise today. Reject anything malformed.
    let visitDate = null;
    if (req.body.date) {
      const d = String(req.body.date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) {
        return res.status(400).json({ error: 'Invalid date.' });
      }
      visitDate = d;
    }
    // A confirmed visit on/after the scheduled date fulfils it — clear next_vet_visit_date
    // so a stale "upcoming appointment" doesn't linger once it's actually happened.
    const r = await query(
      `UPDATE pet_profile
         SET last_vet_visit_date = COALESCE($2::date, CURRENT_DATE),
             next_vet_visit_date = CASE
               WHEN next_vet_visit_date IS NOT NULL
                AND next_vet_visit_date <= COALESCE($2::date, CURRENT_DATE)
               THEN NULL ELSE next_vet_visit_date END,
             updated_at = now()
       WHERE id = $1
       RETURNING to_char(last_vet_visit_date, 'YYYY-MM-DD') AS last_vet_visit_date,
                 to_char(next_vet_visit_date, 'YYYY-MM-DD') AS next_vet_visit_date`,
      [pet.id, visitDate],
    );
    res.json({
      ok: true,
      last_vet_visit_date: r.rows[0].last_vet_visit_date,
      next_vet_visit_date: r.rows[0].next_vet_visit_date,
    });
  } catch (err) {
    console.error('Mark visit error:', err);
    res.status(500).json({ error: 'Could not record the visit.' });
  }
});

// POST /api/vet/schedule-visit — set (or clear) a future appointment date.
// Body: { date: 'YYYY-MM-DD' | null }
router.post('/api/vet/schedule-visit', requireAuth, async (req, res) => {
  try {
    const pet = await petForOwner(req.session.ownerId);
    if (!pet) return res.status(400).json({ error: 'No pet profile found.' });

    let nextDate = null;
    if (req.body.date) {
      const d = String(req.body.date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) {
        return res.status(400).json({ error: 'Invalid date.' });
      }
      if (d < new Date().toISOString().slice(0, 10)) {
        return res.status(400).json({ error: 'The next visit date must be today or later.' });
      }
      nextDate = d;
    }
    const r = await query(
      `UPDATE pet_profile SET next_vet_visit_date = $2::date, updated_at = now()
       WHERE id = $1
       RETURNING to_char(next_vet_visit_date, 'YYYY-MM-DD') AS next_vet_visit_date`,
      [pet.id, nextDate],
    );
    res.json({ ok: true, next_vet_visit_date: r.rows[0].next_vet_visit_date });
  } catch (err) {
    console.error('Schedule visit error:', err);
    res.status(500).json({ error: 'Could not save the appointment date.' });
  }
});

// POST /api/vet/summary — build the two pre-visit summaries.
// Body: { range: 'since_visit' | 'history' }
//   since_visit → turns strictly AFTER last_vet_visit_date (falls back to history if
//                 no visit has ever been logged).
//   history     → last 6 months, capped at 100 turns.
router.post('/api/vet/summary', requireAuth, async (req, res) => {
  try {
    const petResult = await query(
      `SELECT p.*, o.owner_name FROM pet_profile p
       JOIN owners o ON o.id = p.owner_id
       WHERE p.owner_id = $1 LIMIT 1`,
      [req.session.ownerId],
    );
    if (!petResult.rows.length) return res.status(400).json({ error: 'No pet profile found.' });
    const pet = petResult.rows[0];

    const wantsSinceVisit = req.body.range === 'since_visit';
    const hasVisit = wantsSinceVisit && !!pet.last_vet_visit_date;
    const rangeUsed = hasVisit ? 'since_visit' : 'history';

    // Pull the relevant turns (oldest first). since_visit: strictly after the visit day.
    // history: last 6 months, newest 100 then re-ordered oldest-first.
    let turns;
    if (hasVisit) {
      const r = await query(
        `SELECT owner_question, answer_summary, escalated, created_at
           FROM conversation_memory
          WHERE pet_id = $1 AND created_at::date > $2::date
          ORDER BY created_at ASC LIMIT 100`,
        [pet.id, pet.last_vet_visit_date],
      );
      turns = r.rows;
    } else {
      const r = await query(
        `SELECT owner_question, answer_summary, escalated, created_at FROM (
           SELECT owner_question, answer_summary, escalated, created_at
             FROM conversation_memory
            WHERE pet_id = $1 AND created_at > now() - interval '6 months'
            ORDER BY created_at DESC LIMIT 100
         ) t ORDER BY created_at ASC`,
        [pet.id],
      );
      turns = r.rows;
    }

    const [decisions, rollingSummary] = await Promise.all([
      loadActiveDecisions(pet.id),
      getRollingSummary(pet.id),
    ]);

    const { briefing, checklist } = await generateVetSummaries({
      pet, ownerName: pet.owner_name || '', turns, decisions, rollingSummary,
    });

    // Send the briefing to the primary saved vet's WhatsApp, prefixed as a note.
    const vet = primaryVet(pet.vets);
    const waText = `Pre-visit summary for ${pet.name}${vet && vet.name ? ` (Dr ${vet.name})` : ''}:\n\n${briefing}`;
    const whatsappUrl = whatsappLink(vet && vet.phone, waText);

    res.json({
      ok: true,
      range_used: rangeUsed,
      requested_since_visit: wantsSinceVisit,
      turn_count: turns.length,
      last_vet_visit_date: pet.last_vet_visit_date
        ? new Date(pet.last_vet_visit_date).toISOString().slice(0, 10) : null,
      briefing,
      checklist,
      vet_name: vet && vet.name ? vet.name : null,
      whatsapp_url: whatsappUrl || undefined,
    });
  } catch (err) {
    console.error('Vet summary error:', err);
    res.status(500).json({ error: 'Could not generate the summary. Please try again.' });
  }
});

module.exports = router;
