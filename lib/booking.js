'use strict';

/**
 * booking.js — drafts a short appointment-booking message the owner sends to a clinic
 * over WhatsApp. Whoof never contacts the clinic itself; it only writes the message and
 * the owner taps "send", so this works for every clinic regardless of their tech setup.
 *
 * The reason for the visit is pulled from the recent conversation when there's a clear
 * one; otherwise the message simply requests a general check-up. Falls back to a plain
 * template if the LLM is unavailable — drafting must never block the action.
 */

const provider = require('./llmProvider');

// "Monkey (Golden Retriever, 3 years old)" — the bits a clinic actually wants up front.
function petDescriptor(pet) {
  const name = pet.name || 'my dog';
  const bits = [];
  if (pet.breed) bits.push(pet.breed);

  let age = null;
  if (pet.date_of_birth) {
    const years = (Date.now() - new Date(pet.date_of_birth)) / (365.25 * 24 * 60 * 60 * 1000);
    if (years >= 0 && years < 40) age = Math.round(years);
  } else if (pet.age_estimated_years != null) {
    age = Math.round(parseFloat(pet.age_estimated_years));
  }
  if (age != null) bits.push(age === 0 ? 'under 1 year old' : `${age} year${age === 1 ? '' : 's'} old`);

  return bits.length ? `${name} (${bits.join(', ')})` : name;
}

// Returns a plain-text booking message (no markdown, no [placeholders]). `recentHistory`
// is [{ owner_question, answer_summary }] oldest-first, used only to infer a visit reason.
async function draftBookingMessage({ pet, ownerName = '', clinicName, recentHistory = [] }) {
  const descriptor = petDescriptor(pet);
  const fallback =
    `Hi, I'd like to book an appointment for my dog ${descriptor}. ` +
    `Could you please let me know your available slots? Thank you!`;

  if (!provider.isConfigured()) return fallback;

  try {
    const convo = recentHistory
      .map(h => `Owner: ${h.owner_question}`)
      .filter(Boolean)
      .join('\n');

    const system =
      `You write a short, polite WhatsApp message that a dog owner will send to a veterinary clinic to request an appointment. Rules:\n` +
      `- 2 to 3 sentences, warm and natural, plain text only (no markdown, no emojis).\n` +
      `- Open with a greeting and state they'd like to book an appointment for their dog, naming the dog with its breed and age exactly as given.\n` +
      `- If the recent conversation shows a clear health reason or symptom, mention it briefly and factually in one clause. If there is no clear reason, just request a general check-up — never invent a symptom.\n` +
      `- Ask the clinic to share their available slots. Do NOT commit to a specific date or time, and do NOT leave bracketed placeholders like [date].\n` +
      `- End with a brief thanks. Do not add a signature or the clinic's name as a salutation. Output only the message text.`;

    const user =
      `Clinic: ${clinicName || 'the clinic'}\n` +
      `Dog: ${descriptor}\n` +
      `Owner's first name: ${ownerName || '(not given)'}\n\n` +
      `Recent conversation (for the visit reason, if any):\n${convo || '(no prior conversation)'}\n\n` +
      `Write the booking message now.`;

    const msg = (await provider.generate({ system, user, maxTokens: 220, fast: true }) || '').trim();
    // Guard against a too-short reply or one that slipped in a placeholder.
    if (msg.length < 25 || /\[[^\]]+\]/.test(msg)) return fallback;
    return msg;
  } catch {
    return fallback;
  }
}

module.exports = { draftBookingMessage, petDescriptor };
