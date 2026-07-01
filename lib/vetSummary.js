'use strict';

/**
 * vetSummary.js — turns a stretch of chat history into two pre-visit artifacts:
 *
 *   briefing  — 50–70 words of plain clinical prose for the vet to read before/at the
 *               appointment (key concerns, escalations, current meds/decisions).
 *   checklist — short bullet phrases the OWNER scans and raises with the vet in person.
 *
 * Both are produced from the same source in one structured LLM call. Falls back to a
 * deterministic, no-LLM version so "prep for visit" always returns something usable.
 */

const provider = require('./llmProvider');

// ── Drop the obviously non-clinical turns before we summarise ────────────────
// A vet doesn't care that the owner searched for a café or ran a system action. These
// carry zero medical signal and only pollute the briefing, so filter them out up front.
// Subtler place/social chatter ("what about zero forty", "name some more") is left in —
// its answer gives the model the context to recognise and ignore it — but the LLM is told
// firmly to keep only medically-useful content.
const FIND_QUERY_RE   = /^\s*find\s+(a\s+)?(vet|vets|parks?|caf[eé]s?|restaurants?|pet[- ]friendly|places?)\b/i;
const SYSTEM_TURN_RE  = /^\s*\[.*\]\s*$/;               // "[decision confirmed via popup]" etc.

function isNoiseTurn(t) {
  const q = (t.owner_question || '').trim();
  if (!q) return true;
  if (t.escalation_reason === 'off_topic') return true; // triage already judged it off-topic
  if (SYSTEM_TURN_RE.test(q)) return true;
  if (FIND_QUERY_RE.test(q)) return true;               // nearby-place searches
  return false;
}

// Turns that carry a hard clinical signal on their own (used by the no-LLM fallback, which
// can't reason about context): an emergency escalation or an extracted symptom tag.
function hasClinicalSignal(t) {
  return !!t.escalated || (Array.isArray(t.symptom_tags) && t.symptom_tags.length > 0);
}

// Compact a turn for the model: question + whether it was escalated. Answers are
// summarised heavily (first ~240 chars) to keep the prompt bounded.
function turnLine(t) {
  const flag = t.escalated ? ' [URGENT flagged]' : '';
  const ans = (t.answer_summary || '').replace(/\s+/g, ' ').slice(0, 240);
  return `- Owner: ${(t.owner_question || '').replace(/\s+/g, ' ').slice(0, 200)}${flag}\n  Whoof: ${ans}`;
}

function medsLine(pet) {
  const m = pet.known_medications;
  const meds = m?.notes || m?.description || '';
  const allergies = Array.isArray(pet.food_allergies) && pet.food_allergies.length
    ? `Food allergies: ${pet.food_allergies.join(', ')}.` : '';
  const reactions = pet.known_drug_reactions ? `Drug reactions: ${pet.known_drug_reactions}.` : '';
  return [meds && `Current meds: ${meds}.`, allergies, reactions].filter(Boolean).join(' ');
}

const SUMMARY_TOOL = {
  name: 'vet_visit_summary',
  description: 'Return a short clinical briefing for the vet and a plain checklist for the owner.',
  parameters: {
    type: 'object',
    properties: {
      briefing: {
        type: 'string',
        description: '50–70 words of plain clinical prose for the vet: the dog, the active concern(s), anything urgent, current meds/decisions. No greeting, no sign-off, no markdown.',
      },
      checklist: {
        type: 'array',
        description: '3–7 short bullet phrases (max ~10 words each) the owner will raise with the vet, in plain language, no medical jargon. Most important first.',
        items: { type: 'string' },
      },
    },
    required: ['briefing', 'checklist'],
  },
};

// Deterministic fallback when the LLM is unavailable or returns nothing usable. Without a
// model to reason about relevance, use ONLY turns with a hard clinical signal (escalated or
// symptom-tagged) — never the raw recent questions, which are mostly café/place chatter. If
// nothing clinical was logged, say so plainly rather than padding with irrelevant items.
function fallbackSummaries(pet, turns) {
  const seen = new Set();
  const concerns = [];
  for (const t of turns.filter(hasClinicalSignal)) {
    const q = (t.owner_question || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const key = q.toLowerCase();
    if (q && !seen.has(key)) { seen.add(key); concerns.push(q); }
  }
  const top = concerns.slice(0, 6);
  const descriptor = [pet.name, pet.breed].filter(Boolean).join(', ') || 'This dog';
  const meds = medsLine(pet);
  const tail = meds ? ` ${meds}` : '';

  if (!top.length) {
    return {
      briefing: `${descriptor} — no specific health concerns logged since the last visit; here for a routine check-up.${tail}`.slice(0, 600),
      checklist: ['Routine check-up and overall health', 'Weight and body condition', 'Diet, appetite and any supplements'],
    };
  }
  return {
    briefing: `${descriptor} — health concerns raised recently: ${top.join('; ')}.${tail}`.slice(0, 600),
    checklist: top,
  };
}

// turns: [{ owner_question, answer_summary, escalated, created_at }] oldest-first.
// decisions: active saved decisions. rollingSummary: prior-chats memory string.
async function generateVetSummaries({ pet, ownerName = '', turns = [], decisions = [], rollingSummary = '' }) {
  // Drop nearby-place searches, off-topic, and system turns before the model ever sees them.
  const clinicalTurns = turns.filter(t => !isNoiseTurn(t));

  if (!provider.isConfigured() || clinicalTurns.length === 0) {
    return fallbackSummaries(pet, turns);
  }

  try {
    const decisionLines = (decisions || [])
      .map(d => `- ${d.title}${d.decision_type ? ` (${d.decision_type})` : ''}: ${(d.content?.summary || '').slice(0, 160)}`)
      .join('\n');

    const ageBits = [];
    if (pet.breed) ageBits.push(pet.breed);
    if (pet.sex) ageBits.push(pet.sex);
    if (pet.weight_kg) ageBits.push(`${parseFloat(pet.weight_kg)} kg`);

    const system =
      `You prepare a briefing for a VETERINARIAN from a dog owner's chat history with an AI pet assistant. Call the vet_visit_summary tool.\n\n` +
      `Extract ONLY what is medically useful for a vet: symptoms; injuries; changes in eating, drinking, toileting, energy or weight; skin/coat issues; lumps; pain or mobility problems; post-op recovery; medications or supplements started/stopped; diet changes; vaccination or deworming status; and anything flagged urgent.\n\n` +
      `IGNORE completely — never mention — anything not medical: searches for nearby vets/parks/cafés/restaurants, questions about pet-friendly places or which café to visit, directions, bookings, training tricks, recipes, and general chit-chat. These are NOT relevant to a vet even if the owner spent many messages on them.\n\n` +
      `1) briefing: 50–70 words of plain clinical prose the vet reads in under a minute — the dog, the genuine health concern(s), anything urgent, relevant meds/known issues. Factual, no greeting or sign-off.\n` +
      `2) checklist: 3–7 short plain-language points the owner should raise with the vet, most important first, no jargon.\n\n` +
      `Use only things actually in the history; never invent symptoms or diagnoses. If, after ignoring all the non-medical chatter, nothing medically significant was discussed, say exactly that — briefing: here for a routine check-up with no specific concerns raised; checklist: a couple of routine items (weight, diet, general health). Do NOT pad the summary with non-medical items.`;

    const user =
      `Dog: ${pet.name}${ageBits.length ? ` (${ageBits.join(', ')})` : ''}.\n` +
      `${medsLine(pet)}\n` +
      (decisionLines ? `\nSaved decisions on record:\n${decisionLines}\n` : '') +
      (rollingSummary ? `\nBackground from earlier chats: ${rollingSummary.slice(0, 600)}\n` : '') +
      `\nChat history (oldest first — most of this may be non-medical; keep only what a vet needs):\n${clinicalTurns.map(turnLine).join('\n')}\n\n` +
      `Now produce the briefing and checklist.`;

    // Fast model (llama-3.1-8b): a separate rate-limit bucket from the answer model, so this
    // actually runs during heavy testing instead of 429-ing and dropping to the fallback.
    const out = await provider.generateStructured({ system, user, tool: SUMMARY_TOOL, maxTokens: 600, fast: true });

    const briefing = out && typeof out.briefing === 'string' ? out.briefing.trim() : '';
    const checklist = out && Array.isArray(out.checklist)
      ? out.checklist.map(s => String(s).trim()).filter(Boolean).slice(0, 7)
      : [];

    if (!briefing || checklist.length === 0) return fallbackSummaries(pet, turns);
    return { briefing, checklist };
  } catch {
    return fallbackSummaries(pet, turns);
  }
}

module.exports = { generateVetSummaries };
