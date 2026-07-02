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

// Compact one turn to JUST the owner's own words (+ an urgent flag). We deliberately do
// NOT feed the assistant's reply to the summariser: that reply is general veterinary
// information and lists of possibilities, and a small model will otherwise mine it and
// attribute those possibilities to THIS dog as if the owner had reported them — e.g.
// turning "what are the symptoms of ticks?" into "the dog is experiencing scratching,
// redness and inflammation". The owner's own message is the only trustworthy source of
// what is actually happening to the dog.
function turnLine(t) {
  const flag = t.escalated ? ' [flagged urgent]' : '';
  return `- ${(t.owner_question || '').replace(/\s+/g, ' ').slice(0, 220)}${flag}`;
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
        description: '50–70 words of plain, factual prose for the vet. State ONLY what the owner actually reported observing about the dog. If the owner reported no symptoms, say so plainly and note any topics they want to ask about (framed as questions). Never present a question, or the AI\'s general explanation, as a symptom or condition the dog has. No greeting, no sign-off, no markdown.',
      },
      checklist: {
        type: 'array',
        description: '3–7 short bullet phrases (max ~10 words each) the owner will raise with the vet, plain language, most important first. Frame purely informational/preventive topics as questions (e.g. "Questions about tick prevention"), never as symptoms. If nothing was actually reported, use routine items.',
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
  // "raised" (not "reported as symptoms") — these are the owner's own verbatim messages,
  // which may be questions as much as observations. Echoing their exact words is safe;
  // labelling them as confirmed symptoms would not be.
  return {
    briefing: `${descriptor} — the owner raised the following recently: ${top.join('; ')}.${tail}`.slice(0, 600),
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

    const profileFacts = medsLine(pet);
    const system =
      `You prepare a pre-visit briefing for a REAL VETERINARIAN from a list of messages a dog owner sent to an AI pet assistant. Call the vet_visit_summary tool.\n\n` +
      `Every line below is one message the OWNER sent, in their own words — this is the ONLY source of what is actually happening to this dog. "[flagged urgent]" marks an emergency message.\n\n` +
      `ACCURACY RULES — this goes to a real vet, so it must never state anything untrue:\n` +
      `- Report a symptom or condition ONLY if the owner explicitly said their dog is showing or experiencing it. Use the owner's own observations, nothing more.\n` +
      `- Asking ABOUT a topic is NOT having it. "What are the symptoms of ticks?", "how do I prevent X?", "is Y normal?", "can Z happen?" are QUESTIONS — they do NOT mean the dog has ticks / X / Y / Z. Never turn a question into a symptom, condition, or diagnosis.\n` +
      `- Never assume, infer, generalise, or diagnose. If the owner asked about a condition but never reported the dog actually showing it, the dog does NOT have it — write nothing that implies otherwise.\n\n` +
      `WHAT TO INCLUDE:\n` +
      `- Symptoms/observations the owner ACTUALLY reported seeing ("he's been scratching", "vomited twice", "limping"), plus changes in eating/drinking/toileting/energy/weight, injuries, lumps, pain or mobility, post-op recovery, meds or supplements the owner started/stopped, diet changes, and deworming/vaccination the owner mentioned.\n` +
      `- Topics the owner has QUESTIONS about but reported NO symptoms for → list them as the owner's questions to raise (e.g. "Owner has questions about tick prevention"), clearly as questions, NEVER as conditions the dog has.\n\n` +
      `IGNORE completely — never mention: searches for nearby vets/parks/cafés, questions about pet-friendly places, directions, bookings, training tricks, recipes, general chit-chat.\n\n` +
      `OUTPUT:\n` +
      `1) briefing — 50–70 words of plain, factual prose. State only what the owner actually reported. If the owner reported no symptoms, say so plainly (e.g. "in for a routine check-up; no symptoms reported by the owner") and note any topics they want to ask about, framed as questions. No greeting, sign-off, or markdown.\n` +
      `2) checklist — 3–7 short plain points the owner should raise. Frame informational/preventive topics as questions ("Questions about tick prevention"), never as symptoms. If nothing was reported, use routine items (weight, diet, general health).\n\n` +
      `Use ONLY what is in the owner's messages. Never invent, assume, or add anything the owner did not say.`;

    const user =
      `Dog: ${pet.name}${ageBits.length ? ` (${ageBits.join(', ')})` : ''}.\n` +
      (profileFacts ? `On record from the profile (established, you may state these): ${profileFacts}\n` : '') +
      (decisionLines ? `\nSaved decisions on record (established facts you may state):\n${decisionLines}\n` : '') +
      (rollingSummary ? `\nBackground from earlier chats (context only — not new symptoms): ${rollingSummary.slice(0, 600)}\n` : '') +
      `\nThe owner's own messages (oldest first — the ONLY source of what's actually happening to the dog):\n${clinicalTurns.map(turnLine).join('\n')}\n\n` +
      `Now produce the briefing and checklist, following the accuracy rules exactly.`;

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
