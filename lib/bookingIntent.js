'use strict';

/**
 * bookingIntent.js — decides whether a chat message is the owner asking to BOOK a vet
 * appointment, and (if so) which clinic they mean.
 *
 * Two stages, cheap-first:
 *   looksLikeBooking()    — a fast regex gate. Catches "book a vet visit", "appointment",
 *                           "help booking maxpetz". No LLM, so it runs on every message.
 *   detectBookingRequest()— only called when the gate fires. A small fast-model call that
 *                           confirms the intent and pulls the clinic name, resolving
 *                           references like "this place" / "the first one" against the
 *                           recent chat. Falls back to a regex clinic-grab if no LLM.
 *
 * Keeping the LLM behind the regex gate means the extra call only happens on the handful
 * of turns that are plausibly bookings, not on normal chat.
 */

const provider = require('./llmProvider');

// Fast gate: a booking verb/noun. Loose on purpose — the LLM stage rejects false hits
// (e.g. "recommend a book on training"). We'd rather over-trigger the cheap check.
const BOOKING_GATE_RE = /\b(book|booking|booked|appointment|appt|reserve|schedule (a|an|my)?\s*(visit|appointment|appt|slot))\b/i;

function looksLikeBooking(text) {
  return BOOKING_GATE_RE.test(text || '');
}

// Last-ditch clinic grab when no LLM is configured: pull the words after "at"/"with"/
// "book(ing)". Returns a trimmed clinic name or '' if nothing usable.
function regexClinic(text) {
  const t = (text || '').trim();
  let m = t.match(/\b(?:at|with)\s+([A-Za-z0-9'&.\- ]{2,60}?)(?:\s*[.,!?]|$)/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/\bbook(?:ing)?\s+(?:an?\s+|the\s+)?(?:appointment\s+(?:at|with)\s+)?([A-Za-z0-9'&.\- ]{2,60}?)(?:\s*[.,!?]|$)/i);
  if (m && m[1] && !/^(a|an|the|appointment|appt|vet|visit|slot|this|that|it|place|me|help)\b/i.test(m[1].trim())) {
    return m[1].trim();
  }
  return '';
}

const BOOKING_TOOL = {
  name: 'classify_booking',
  description: 'Decide whether the owner is asking to book/schedule a veterinary appointment, and which clinic they mean.',
  parameters: {
    type: 'object',
    properties: {
      wants_booking: {
        type: 'boolean',
        description: 'True only if the owner is asking to book, schedule, or get help arranging a vet/clinic appointment for their pet. False for general questions, even if the word "book" appears.',
      },
      clinic_name: {
        type: 'string',
        description: 'The clinic the owner wants to book with, copied as written (e.g. "Maxpetz Jubilee Hills"). Resolve references like "this place", "there", or "the first one" using the recent conversation. Empty string if no specific clinic is identifiable.',
      },
    },
    required: ['wants_booking', 'clinic_name'],
  },
};

// Confirm intent + extract the clinic. `recentHistory` is [{owner_question, answer_summary}]
// oldest-first; `savedVets` is the owner's saved vet list (names help resolve references).
// Returns { wants_booking: bool, clinic_name: string }.
async function detectBookingRequest({ message, recentHistory = [], savedVets = [] }) {
  const fallback = { wants_booking: true, clinic_name: regexClinic(message) };
  if (!provider.isConfigured()) return fallback;

  try {
    const convo = recentHistory
      .map(h => `Owner: ${h.owner_question}\nWhoof: ${h.answer_summary}`)
      .join('\n\n')
      .slice(0, 3000);
    const vetList = savedVets
      .map(v => [v.clinic, v.name].filter(Boolean).join(' — '))
      .filter(Boolean)
      .join('; ');

    const system =
      'You classify one message from a dog owner in a vet-assistant chat. Decide if they are asking to book/schedule a vet appointment, and which clinic. ' +
      'Only set wants_booking true for an actual request to arrange an appointment. Resolve vague references ("this place", "there", "the first one") using the recent conversation and the saved-vet list. Copy the clinic name as written; use an empty string if none is clear.';
    const user =
      `Owner's saved vets: ${vetList || '(none)'}\n\n` +
      `Recent conversation (oldest first):\n${convo || '(none)'}\n\n` +
      `New message: "${message}"`;

    const out = await provider.generateStructured({ system, user, tool: BOOKING_TOOL, fast: true, maxTokens: 200 });
    if (!out || typeof out.wants_booking !== 'boolean') return fallback;
    return {
      wants_booking: out.wants_booking,
      clinic_name: (typeof out.clinic_name === 'string' ? out.clinic_name : '').trim().slice(0, 120),
    };
  } catch {
    return fallback;
  }
}

module.exports = { looksLikeBooking, detectBookingRequest };
