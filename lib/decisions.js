'use strict';

/**
 * decisions.js — durable, confirmed facts about a pet ("locked decisions").
 *
 * These are the opposite of retrieval: a decision is a settled record (a finalized
 * diet plan, a confirmed allergy/diagnosis, an agreed treatment routine) that gets
 * injected into every prompt as plain asserted fact — no vector search, no sources,
 * no confidence score, no hedging.
 *
 * Flow:
 *   1. After an answer, detectDecision() judges (fast model) whether this exchange
 *      finalized something worth saving, and drafts a proactive offer to the owner.
 *   2. The proposal parks on conversation_session.pending_decision.
 *   3. If the owner's next message affirms, saveDecision() writes it (superseding any
 *      previous active decision of the same type). A decline just clears the parm.
 */

const { query } = require('../db');
const provider = require('./llmProvider');

const DECISION_TYPES = ['diet_plan', 'allergy', 'diagnosis', 'treatment_routine', 'other'];

const DETECT_TOOL = {
  name: 'assess_saveable_decision',
  description:
    'After a vet-assistant answer, decide whether this exchange FINALIZED a durable, ' +
    'decision-worthy fact about THIS dog that should be saved as an official record — ' +
    'e.g. a diet plan that was just settled, a newly confirmed allergy or diagnosis, an ' +
    'agreed-on treatment/medication routine. Only fire when something is genuinely new ' +
    'and would change how FUTURE questions about this dog should be answered. A routine ' +
    'question-and-answer, general advice, or still-being-discussed idea is NOT saveable.',
  parameters: {
    type: 'object',
    properties: {
      decision_ready: {
        type: 'boolean',
        description:
          'TRUE only when the exchange clearly finalized a durable, specific decision ' +
          'worth recording. FALSE for ordinary advice, vague or hypothetical discussion, ' +
          'emergencies, or anything not yet settled. Be conservative — same judgment as ' +
          'deciding whether to ask a clarifying question.',
      },
      decision_type: {
        type: 'string',
        enum: DECISION_TYPES,
        description: 'The kind of decision. Use "other" only if none fit.',
      },
      title: {
        type: 'string',
        description: 'A short label, e.g. "Daily diet plan", "Chicken allergy", "Arthritis management".',
      },
      summary: {
        type: 'string',
        description: 'One concise sentence stating the decision.',
      },
      details: {
        type: 'string',
        description:
          'The concrete decided specifics only (portions, foods, schedule, dose, frequency, ' +
          'what to avoid) — NOT the conversation that led to them. Plain text or short bullet lines.',
      },
      offer_message: {
        type: 'string',
        description:
          'A warm, one-to-two sentence message offering to save this, addressed to the owner ' +
          'by referencing the dog by name, and briefly saying why it helps (more accurate answers ' +
          'next time + a record they can return to). End by inviting a yes. ' +
          'Example: "It sounds like we\'ve landed on a solid daily diet plan for Monkey — want me ' +
          'to save this as his official plan? It\'ll help me give you more accurate answers next ' +
          'time, and you\'ll have it on record. Just say yes."',
      },
    },
    required: ['decision_ready'],
  },
};

// Judge whether the latest exchange finalized something saveable. Never throws.
async function detectDecision({ petName, message, answer, recentHistory = [] }) {
  if (!provider.isConfigured()) return { decision_ready: false };
  try {
    const histText = recentHistory.length
      ? recentHistory.map(h => `Owner: ${h.owner_question}\nAssistant: ${h.answer_summary}`).join('\n')
      : '(none)';
    const out = await provider.generateStructured({
      system:
        `You assess conversations about a dog named ${petName || 'the dog'} for the veterinary ` +
        `assistant "Whoof AI". Use the assess_saveable_decision tool. Only mark decision_ready ` +
        `true when this exchange genuinely finalized a durable, specific decision worth saving.`,
      user:
        `Recent conversation:\n${histText}\n\n` +
        `Latest exchange:\nOwner: ${message}\nAssistant: ${answer}\n\n` +
        `Did this finalize a saveable decision? If so, draft the offer.`,
      tool: DETECT_TOOL,
      maxTokens: 500,
      fast: true,
    });
    if (!out || !out.decision_ready) return { decision_ready: false };
    return {
      decision_ready: true,
      decision_type: DECISION_TYPES.includes(out.decision_type) ? out.decision_type : 'other',
      title: (out.title || 'Saved note').toString().slice(0, 80),
      content: {
        summary: (out.summary || '').toString().slice(0, 400),
        details: (out.details || '').toString().slice(0, 1500),
      },
      offer_message: (out.offer_message || '').toString().slice(0, 500),
    };
  } catch (err) {
    console.warn('Decision detection skipped:', err.message);
    return { decision_ready: false };
  }
}

// Active decisions for a pet — loaded into every prompt as plain fact.
async function loadActiveDecisions(petId) {
  const r = await query(
    `SELECT decision_type, title, content, locked_at
     FROM pet_decisions
     WHERE pet_id = $1 AND status = 'active'
     ORDER BY locked_at DESC`,
    [petId],
  );
  return r.rows;
}

// Persist a confirmed decision. Any previous ACTIVE decision of the same type is
// marked superseded (kept for audit), so only the newest is asserted going forward.
async function saveDecision(petId, { decision_type, title, content }) {
  const type = DECISION_TYPES.includes(decision_type) ? decision_type : 'other';
  await query(
    `UPDATE pet_decisions SET status = 'superseded', superseded_at = now()
     WHERE pet_id = $1 AND decision_type = $2 AND status = 'active'`,
    [petId, type],
  );
  const r = await query(
    `INSERT INTO pet_decisions (pet_id, decision_type, title, content, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id, title`,
    [petId, type, title || 'Saved note', JSON.stringify(content || {})],
  );
  return r.rows[0];
}

// Lightweight intent checks for the owner's reply to a save offer. We only need to
// catch a plain yes/no in the message immediately after the offer.
const AFFIRM_RE = /^(yes|yep|yeah|yup|ya|sure|ok|okay|okey|k|please do|yes please|do it|sounds good|go ahead|save it|save that|save this|lock it in|lock it|absolutely|definitely|of course|👍|✅)\b/i;
const DECLINE_RE = /^(no|nope|nah|not now|don'?t|do not|skip|maybe later|later|no thanks|no thank you|that'?s ok|leave it)\b/i;

function isAffirmation(text) {
  return AFFIRM_RE.test((text || '').trim());
}
function isDecline(text) {
  return DECLINE_RE.test((text || '').trim());
}

module.exports = {
  detectDecision, loadActiveDecisions, saveDecision, isAffirmation, isDecline, DECISION_TYPES,
};
