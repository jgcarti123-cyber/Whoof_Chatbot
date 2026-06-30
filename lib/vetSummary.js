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

// Deterministic fallback when the LLM is unavailable or returns nothing usable.
function fallbackSummaries(pet, turns) {
  const flagged = turns.filter(t => t.escalated).map(t => t.owner_question).filter(Boolean);
  const recent = turns.slice(-5).map(t => t.owner_question).filter(Boolean);
  const concerns = (flagged.length ? flagged : recent).slice(0, 6);
  const descriptor = [pet.name, pet.breed].filter(Boolean).join(', ');
  const briefing =
    `${descriptor || 'This dog'} — recent owner concerns: ` +
    (concerns.length ? concerns.map(c => c.replace(/\s+/g, ' ').slice(0, 80)).join('; ') : 'general check-up') +
    `. ${medsLine(pet)}`.trim();
  return {
    briefing: briefing.slice(0, 600),
    checklist: concerns.length ? concerns.map(c => c.replace(/\s+/g, ' ').slice(0, 80)) : ['General check-up and any questions'],
  };
}

// turns: [{ owner_question, answer_summary, escalated, created_at }] oldest-first.
// decisions: active saved decisions. rollingSummary: prior-chats memory string.
async function generateVetSummaries({ pet, ownerName = '', turns = [], decisions = [], rollingSummary = '' }) {
  if (!provider.isConfigured() || turns.length === 0) {
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
      `You are preparing a dog for a veterinary appointment. From the owner's chat history with an AI pet assistant, produce two things by calling the vet_visit_summary tool:\n` +
      `1) briefing: 50–70 words, plain clinical prose a vet reads in under a minute — the dog, the main concern(s), anything urgent, relevant meds/known issues. Factual, no greeting or sign-off.\n` +
      `2) checklist: 3–7 short plain-language points the owner should raise with the vet, most important first, no jargon.\n` +
      `Only include things actually present in the history. Do NOT invent symptoms or diagnoses. If little was discussed, keep both short.`;

    const user =
      `Dog: ${pet.name}${ageBits.length ? ` (${ageBits.join(', ')})` : ''}.\n` +
      `${medsLine(pet)}\n` +
      (decisionLines ? `\nSaved decisions on record:\n${decisionLines}\n` : '') +
      (rollingSummary ? `\nBackground from earlier chats: ${rollingSummary.slice(0, 600)}\n` : '') +
      `\nChat history (oldest first):\n${turns.map(turnLine).join('\n')}\n\n` +
      `Now produce the briefing and checklist.`;

    const out = await provider.generateStructured({ system, user, tool: SUMMARY_TOOL, maxTokens: 600, fast: false });

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
