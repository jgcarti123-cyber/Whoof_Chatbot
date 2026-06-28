'use strict';

const provider = require('./llmProvider');
const { STRUCTURED_ANSWER_SCHEMA, validateStructuredAnswer } = require('./structured');

// Builds a plain-English summary of the pet profile to inject into the system prompt.
function buildPetSummary(pet) {
  const parts = [];

  let intro = `${pet.name} is a`;
  if (pet.date_of_birth) {
    const ageYears = ((Date.now() - new Date(pet.date_of_birth)) / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1);
    intro += ` ${ageYears}-year-old`;
  } else if (pet.age_estimated_years) {
    intro += ` approximately ${pet.age_estimated_years}-year-old`;
  }
  if (pet.sex) intro += ` ${pet.sex}`;
  if (pet.neutered !== null && pet.neutered !== undefined) intro += pet.neutered ? ' neutered' : ' intact';
  intro += ` ${pet.breed || 'dog'}.`;
  parts.push(intro);

  if (pet.weight_kg) {
    // numeric(5,2) comes back as e.g. "28.40" — trim trailing zeros for a consistent "28.4 kg".
    const w = parseFloat(pet.weight_kg);
    parts.push(`Weight: ${w} kg. Body condition: ${pet.body_condition || 'not assessed'}.`);
  }
  if (pet.diet_type) {
    parts.push(`Diet: ${pet.diet_type}${pet.meals_per_day ? `, ${pet.meals_per_day} meals/day` : ''}.`);
  }
  if (pet.food_allergies?.length) {
    parts.push(`Known food allergies: ${pet.food_allergies.join(', ')}.`);
  }
  if (pet.treat_frequency) parts.push(`Treats: ${pet.treat_frequency}.`);
  if (pet.living_situation) {
    parts.push(`Lives: ${pet.living_situation} in ${pet.region || 'India'}.`);
  }
  if (pet.baseline_activity_level) parts.push(`Activity level: ${pet.baseline_activity_level}.`);

  const vaxHistory = Array.isArray(pet.vaccination_history) ? pet.vaccination_history : [];
  if (vaxHistory.length) {
    const vax = vaxHistory.map(v => `${v.vaccine} (${v.date})`).join(', ');
    parts.push(`Vaccinations on record: ${vax}.`);
  }

  const meds = pet.known_medications;
  if (meds?.notes || meds?.description) {
    parts.push(`Current medications: ${meds.notes || meds.description}.`);
  }
  if (pet.known_drug_reactions) parts.push(`Drug reactions: ${pet.known_drug_reactions}.`);

  if (pet.last_vet_visit_date) {
    parts.push(`Last vet visit: ${pet.last_vet_visit_date}${pet.last_vet_visit_reason ? ` — ${pet.last_vet_visit_reason}` : ''}.`);
  }
  const surgeries = Array.isArray(pet.past_surgeries) ? pet.past_surgeries : [];
  if (surgeries.length) {
    const list = surgeries.map(s => `${s.description}${s.date ? ` (${s.date})` : ''}`).join('; ');
    parts.push(`Past surgeries / procedures: ${list}.`);
  }
  if (pet.temperament_flags?.length) {
    parts.push(`Temperament: ${pet.temperament_flags.join(', ')}.`);
  }
  if (pet.known_phobias) parts.push(`Known fears: ${pet.known_phobias}.`);
  if (pet.other_animals_in_household) parts.push('Other pets in household: yes.');
  if (pet.household_has_children) parts.push('Children in household: yes.');

  return parts.join(' ');
}

// Builds the system prompt.
// breedInfo is a breed_reference row (or null) — injected directly, not retrieved via RAG.
// opts.clarifications: [{question, answer}] the owner answered before this turn.
function buildSystemPrompt(pet, chunks = [], recentHistory = [], breedInfo = null, opts = {}) {
  const petSummary = buildPetSummary(pet);
  const clarifications = Array.isArray(opts.clarifications) ? opts.clarifications : [];

  // The owner's name (if they gave it) — so Whoof can address them personally and
  // knows whose dog this is. Used naturally, not in every message.
  const ownerName = (opts.ownerName || '').trim();
  const ownerLine = ownerName
    ? `\n\nYou're speaking with **${ownerName}**, ${pet.name}'s owner. Address them by their first name now and then to keep it personal — naturally, not in every message.`
    : '';

  // Breed-specific context block — only added when we have a match
  let breedSection = '';
  if (breedInfo) {
    const conditions = breedInfo.common_conditions?.length
      ? breedInfo.common_conditions.join(', ')
      : 'no specific predispositions noted';
    breedSection = `\n\n## Breed context — ${breedInfo.breed_name}:
Weight range: ${breedInfo.weight_range_kg || 'not recorded'} kg.
Life expectancy: ${breedInfo.life_expectancy_years || 'not recorded'} years.
Common breed predispositions: ${conditions}.
Temperament: ${breedInfo.temperament_notes || 'not recorded'}.
(Source: ${breedInfo.source || 'breed reference data'})`;
  }

  const refMaterial = chunks.length
    ? chunks
        .map((c, i) => {
          const loc = [c.source_title || c.source, c.section, c.subsection]
            .filter(Boolean).join(' › ');
          const pageNote = c.page_number ? ` (p.${c.page_number})` : '';
          const typeNote = c.chunk_type && c.chunk_type !== 'body' ? ` [${c.chunk_type}]` : '';
          const header = `[${i + 1}] ${loc}${pageNote}${typeNote}`;
          return `${header}\n${c.content}`;
        })
        .join('\n\n---\n\n')
    : 'No matching reference material was found for this question.';

  // Locked decisions: confirmed, settled facts (diet plan, allergy, diagnosis,
  // routine). These are asserted fact — never retrieval — so they get NO sources
  // and NO confidence tag, and must be stated directly without hedging.
  const decisions = Array.isArray(opts.decisions) ? opts.decisions : [];
  const decisionsSection = decisions.length
    ? `\n\n## ${pet.name}'s saved decisions — these are SETTLED FACTS, not guideline retrievals:\n` +
      decisions.map(d => {
        const c = d.content || {};
        const body = [c.summary, c.details].filter(Boolean).join(' — ');
        return `- ${d.title}${d.decision_type ? ` (${d.decision_type})` : ''}: ${body || c.summary || ''}`;
      }).join('\n') +
      `\nIf the owner asks what was decided/agreed/locked in, restate the relevant one directly and confidently. Do NOT hedge, do NOT ask "does that sound right?", do NOT cite sources or attach a confidence rating — these are established records. These saved decisions are AUTHORITATIVE: if anything in your past-conversation memory below conflicts with them, the saved decision wins and the memory is out of date.`
    : '';

  // Rolling summary of PAST chats (one fixed-size slot, see lib/memory.js).
  const memorySection = opts.rollingSummary
    ? `\n\n## What you remember about ${pet.name} from past conversations:\n${opts.rollingSummary}\n(Your saved memory across past chats. Use it naturally to stay consistent; it is memory, not a guideline source — don't cite it.)`
    : '';

  const historySection = recentHistory.length
    ? '\n\n## Earlier in this chat:\n' +
      recentHistory
        .map(h => `Owner asked: ${h.owner_question}\nYou answered: ${h.answer_summary}`)
        .join('\n\n')
    : '';

  const clarificationSection = clarifications.length
    ? '\n\n## The owner answered these triage questions just now:\n' +
      clarifications
        .map(c => `- ${c.question}\n  → ${c.answer}`)
        .join('\n') +
      '\nUse these answers directly; do not ask them again. Weigh them to judge whether this is serious (advise seeing a vet) or mild (advise monitoring at home).'
    : '';

  return `You are Whoof AI — a calm, experienced veterinary assistant with deep knowledge of small-animal practice, speaking directly to a dog's owner. You know this specific dog's profile and history; use it — refer to the dog by name, make your answers specific to their situation, not generic.

**Stay in your lane:** You only help with this pet, dogs, and animal health/behaviour/care. If a message is not about animals, politely decline in one line and steer back to the pet — never answer general-knowledge, technical, or non-animal questions.

**Using the reference material:** Use the provided reference material to inform your answer, but do NOT name or cite the sources inline — no "According to WSAVA guidelines…", no document titles, no guideline names in the text. Sources are shown to the owner separately. Just give the advice directly and confidently, as a vet would. If the reference material does NOT cover the question, you may still answer from your own established veterinary knowledge — say something brief like "From general practice…" once if needed, and be appropriately cautious. When unsure or when the stakes are high, recommend an in-person vet visit.

**Recall vs. clinical questions:** If the owner is asking what the two of you previously decided, agreed, or discussed about their dog, answer from the saved decisions and memory above — those are established facts about this dog, not reference material, so state them plainly and confidently and never frame them as guideline-based. Reference material and its sources are only for clinical/medical questions.

**Emergency rule — always check first:** For anything that could be an emergency — suspected poisoning (including chocolate, xylitol, grapes), difficulty breathing, collapse, bloated or hard abdomen, seizures, inability to stand or walk, pale or blue gums, heavy uncontrolled bleeding — put a clear, prominent "⚠️ URGENT: See a vet or emergency clinic NOW" statement at the very start of your response, before any other advice.

For all other questions: be warm, specific, and practical. Give concrete guidance the owner can act on today. Avoid hedging every sentence with generic disclaimers.

## Your patient today:
${petSummary}${ownerLine}${breedSection}${decisionsSection}${memorySection}${historySection}${clarificationSection}

## Relevant reference material:
${refMaterial}`;
}

// Generates the vet answer via the configured provider (Groq or Anthropic).
async function generateAnswer(systemPrompt, userMessage) {
  return provider.generate({ system: systemPrompt, user: userMessage, maxTokens: 1024 });
}

// ── Structured-vs-text routing ───────────────────────────────────────────────
// The model picks, per answer, between two response tools. send_structured_reply
// returns a StructuredAnswer the UI renders as a card; send_text_reply returns prose.
// Both carry the SAME answer content — a structured reply's fallbackText is the plain
// text the rest of the app uses (memory, search, decision detection).
const RESPONSE_FORMAT_GUIDANCE = `

## How to format this reply — choose a response tool
You must answer by calling exactly one of two tools:

- **send_structured_reply** — use when your answer naturally contains 3 or more discrete facts, a schedule or sequence of steps (a feeding routine, a training plan, a vaccination timeline), a comparison, measurements/numbers the owner will want to glance back at, or concrete next actions. Pull the numbers into \`stats\`, lay steps out in a \`sections\` timeline or list, put a key warning or recovery note in a \`callouts\` entry, and add short qualitative \`tags\`. Set \`subject.name\` to the dog's name. ALWAYS include \`fallbackText\`: a complete, warm, plain-text version of the very same answer (this is what's used if the card can't render).
- **send_text_reply** — use for short answers, a single explanation or opinion, reassurance, an emergency response, or anything that is one idea in a sentence or two. Don't force a sparse card onto a simple answer.

When in doubt and the answer has any list-like structure, prefer send_structured_reply.

**Actions** (optional, only when genuinely useful): you may add buttons via \`actions\`. Only two action types do anything today — use only these:
- \`save_decision\` — offer to save a finalised plan/diet/routine to the dog's record. payload: { "title": "<short title>", "decision_type": "diet_plan|treatment_routine|allergy|diagnosis|other", "summary": "<one line>" }.
- \`open_screen\` — send the owner to an in-app screen. payload: { "screen": "profile" } (the dog's profile) or { "screen": "chat" }.
Do not invent other action types. Keep the same calm, specific, non-hedging voice in both tools; never cite sources or document names in the text.`;

const TEXT_TOOL = {
  name: 'send_text_reply',
  description: 'Reply to the owner with a normal prose answer. Use for short, single-idea, or emergency answers.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: "The full answer in the assistant's voice (markdown allowed)." } },
    required: ['text'],
  },
};

const STRUCTURED_TOOL = {
  name: 'send_structured_reply',
  description: 'Reply with a structured card (stats, a schedule, callouts, tags, actions). Use when the answer has 3+ facts, a schedule/sequence, a comparison, glanceable numbers, or concrete next actions.',
  parameters: STRUCTURED_ANSWER_SCHEMA,
};

// Generate an answer and let the model (or a forced override) decide the modality.
// Returns { modality: 'text'|'structured', text, structured? }. `text` is always the
// plain-text answer (a structured reply's fallbackText), so callers can treat it as the
// canonical answer for persistence/memory and additionally render `structured` if set.
// opts.force === 'structured' compels the structured tool (trigger phrase / manual recast).
async function generateRoutedAnswer(systemPrompt, userMessage, opts = {}) {
  const system = systemPrompt + RESPONSE_FORMAT_GUIDANCE;
  const force = opts.force === 'structured' ? STRUCTURED_TOOL.name : null;

  let routed = null;
  try {
    routed = await provider.generateRouted({
      system,
      user: userMessage,
      tools: [TEXT_TOOL, STRUCTURED_TOOL],
      force,
      maxTokens: 1800,
    });
  } catch (err) {
    console.warn('Routed generation failed, falling back to text:', err.message);
  }

  // No tool call (or transport error) → fall back to a plain text answer.
  if (!routed) {
    const text = await generateAnswer(systemPrompt, userMessage);
    return { modality: 'text', text };
  }

  if (routed.toolName === STRUCTURED_TOOL.name) {
    const { valid, value } = validateStructuredAnswer(routed.input);
    if (valid) {
      return { modality: 'structured', text: value.fallbackText, structured: value };
    }
    // Invalid structured payload → degrade to its fallbackText, or a plain retry.
    const fallback = value && value.fallbackText;
    if (fallback) return { modality: 'text', text: fallback };
    const text = await generateAnswer(systemPrompt, userMessage);
    return { modality: 'text', text };
  }

  // send_text_reply
  const text = (routed.input && typeof routed.input.text === 'string' && routed.input.text.trim())
    ? routed.input.text.trim()
    : await generateAnswer(systemPrompt, userMessage);
  return { modality: 'text', text };
}

// A short, human-readable chat title summarising the owner's first question,
// for the sidebar (e.g. "Limping after surgery"). Uses the fast model. Returns
// null on any failure so the caller can fall back to a truncated message.
async function generateSessionTitle(message) {
  if (!provider.isConfigured()) return null;
  try {
    const raw = await provider.generate({
      system: "You write a very short chat title (max 5 words) summarising a dog owner's question, like a label in a chat sidebar — e.g. \"Limping after surgery\", \"Chocolate safety\", \"Switching to raw food\". Use ONLY what's in the message; never invent a topic or detail that isn't there. If the message is empty, gibberish, or not a real question, reply with exactly: New chat. Output only the title — no quotes, no trailing punctuation, no preamble.",
      user: message,
      maxTokens: 20,
      fast: true,
    });
    const title = (raw || '')
      .split('\n')[0]
      .replace(/^["'`]+|["'`.]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (!title || /^new chat$/i.test(title)) return null;
    return title;
  } catch (err) {
    console.warn('Session title generation failed:', err.message);
    return null;
  }
}

module.exports = { buildSystemPrompt, generateAnswer, generateRoutedAnswer, generateSessionTitle };
