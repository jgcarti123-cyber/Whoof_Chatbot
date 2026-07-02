'use strict';

/**
 * placeIntent.js — decides whether a chat message is the owner asking to FIND nearby
 * places (vets, parks, or pet-friendly cafés), and which category.
 *
 * Why this exists: the normal answer model has no access to the Places / community-picks
 * data, so when an owner TYPES "what about cafés which are pet friendly" it used to
 * improvise a list of place names from general knowledge — unverified and sometimes wrong
 * (see the 1/10-rated turns in testing). This detector short-circuits those questions into
 * the exact same real Find pipeline the "Find" button uses.
 *
 * Two stages, cheap-first (same shape as lib/bookingIntent.js):
 *   looksLikePlaceQuery() — a fast regex gate, runs on every message.
 *   detectPlaceRequest()  — only when the gate fires: a fast-model confirm that rejects
 *                           false hits ("my vet recommended…") and picks the category.
 */

const provider = require('./llmProvider');

// A place noun, paired with a find/nearby signal (or an explicit "pet-friendly ..."). Loose
// on purpose — the LLM stage rejects false positives; we'd rather over-trigger the cheap check.
const PLACE_NOUN_RE = /\b(vet|vets|veterinary|veterinarian|clinic|clinics|park|parks|caf[eé]|caf[eé]s|coffee shop|restaurant|restaurants)\b/i;
const NEAR_RE = /\b(near ?by|near me|near by|around here|around me|close by|in my area|in the area)\b/i;
const FIND_RE = /\b(find|show|suggest|recommend|any good|some good|good|best|places? to (go|take|visit|walk)|where (can|should|could))\b/i;
const PET_FRIENDLY_RE = /\bpet[- ]friendly\b/i;
// "where can I walk him / take him for a walk" is a park search with no explicit place noun.
const WALK_RE = /\b(walk|walking|outing)\b/i;

function looksLikePlaceQuery(text) {
  const t = (text || '');
  const findish = NEAR_RE.test(t) || FIND_RE.test(t);
  if (PET_FRIENDLY_RE.test(t)) return true;             // "pet-friendly X" is always a place ask
  if (PLACE_NOUN_RE.test(t) && findish) return true;    // a place noun + a find/near signal
  if (WALK_RE.test(t) && findish) return true;          // "where can I take him for a walk"
  return false;
}

const PLACE_TOOL = {
  name: 'classify_place_search',
  description: 'Decide whether the owner is asking to FIND nearby places (a vet clinic, a park/walk spot, or a pet-friendly café/restaurant), and which one.',
  parameters: {
    type: 'object',
    properties: {
      wants_places: {
        type: 'boolean',
        description: 'True ONLY if the owner wants to find/discover nearby places to go. False for medical/behaviour/general questions, even if they mention a vet or a park in passing (e.g. "should I take him to the vet for his limp?", "we walk in the park daily" → false).',
      },
      category: {
        type: 'string',
        enum: ['vet', 'park', 'cafe', ''],
        description: 'Which kind of place: "vet" (veterinary clinics), "park" (parks / places to walk the dog), "cafe" (pet-friendly cafés/restaurants). Empty string if it is a place search but the kind is unclear.',
      },
    },
    required: ['wants_places', 'category'],
  },
};

const VALID_CATEGORIES = new Set(['vet', 'park', 'cafe']);

// Confirm intent + pick the category. `recentHistory` (oldest-first) lets the model resolve
// a bare follow-up. Returns { wants_places: bool, category: 'vet'|'park'|'cafe'|'' }.
async function detectPlaceRequest({ message, recentHistory = [] }) {
  // No-LLM fallback: trust the gate, guess the category from keywords.
  const fallback = () => {
    let category = '';
    if (/\b(vet|veterinar|clinic)/i.test(message)) category = 'vet';
    else if (/\bpark|walk\b/i.test(message)) category = 'park';
    else if (/caf[eé]|restaurant|coffee|pet[- ]friendly/i.test(message)) category = 'cafe';
    return { wants_places: true, category };
  };
  if (!provider.isConfigured()) return fallback();

  try {
    const convo = recentHistory
      .map(h => `Owner: ${h.owner_question}`)
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500);
    const system =
      'You classify one message from a dog owner in a vet-assistant chat. Decide if they are asking to FIND nearby places to go — a vet clinic, a park/walk spot, or a pet-friendly café/restaurant — and which kind. ' +
      'Only set wants_places true for an actual request to find/discover places nearby. A medical, behaviour, feeding, or general question is NOT a place search even if it mentions a vet or a park.';
    const user =
      (convo ? `Recent conversation (oldest first):\n${convo}\n\n` : '') +
      `New message: "${message}"`;

    const out = await provider.generateStructured({ system, user, tool: PLACE_TOOL, fast: true, maxTokens: 120 });
    if (!out || typeof out.wants_places !== 'boolean') return fallback();
    return {
      wants_places: out.wants_places,
      category: VALID_CATEGORIES.has(out.category) ? out.category : '',
    };
  } catch {
    return fallback();
  }
}

module.exports = { looksLikePlaceQuery, detectPlaceRequest };
