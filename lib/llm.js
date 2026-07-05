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
// opts.replyTo: {question, answer} of a specific earlier turn the owner tapped "Reply" on.
function buildSystemPrompt(pet, chunks = [], recentHistory = [], breedInfo = null, opts = {}) {
  const petSummary = buildPetSummary(pet);
  const clarifications = Array.isArray(opts.clarifications) ? opts.clarifications : [];

  // The owner's name (if they gave it) — so Whoof knows whose dog this is. The model
  // tends to over-use the name (opening every reply with it), which reads as robotic, so
  // this is a hard rule against that, not a soft "use it naturally" suggestion.
  const ownerName = (opts.ownerName || '').trim();
  const ownerFirst = ownerName.split(/\s+/)[0] || ownerName;
  const ownerLine = ownerName
    ? `\n\nThe owner's name is **${ownerName}**. HARD RULES on their name, follow exactly:
- NEVER begin a reply with their name. Do not write "${ownerFirst}, ..." as your opening — start with the actual answer.
- NEVER start any sentence with their name.
- Do NOT address them by name to acknowledge, reassure, or transition (no "${ownerFirst}, that's great", "${ownerFirst}, I understand", "Great question, ${ownerFirst}").
- The default is to NOT use their name at all — just talk to them directly, the way you'd speak to someone already in the room. At most once in a whole conversation may you use it, and only mid-sentence when steadying them in a genuinely frightening moment.`
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

  // Live web snippets — only present when the KB had no good match (see routes/chat.js).
  // Treated like reference material: inform the answer, but don't quote URLs inline; the
  // pages are shown to the owner separately as sources.
  const webResults = Array.isArray(opts.webResults) ? opts.webResults : [];
  const webSection = webResults.length
    ? `\n\n## Recent information from the web:\nYour reference material didn't cover this well, so here are current web results. Use them to answer accurately and practically. Don't paste URLs or quote source names inline — the pages are shown to the owner separately. Stay cautious and recommend an in-person vet when the stakes are high.\n\n**Before using ANY of these:** check that it is actually about dogs, pets, or veterinary/animal care and genuinely relevant to ${pet.name}'s question. Web search can surface an unrelated same-named person, place, or topic (e.g. a dog sharing a name with a celebrity surfacing that celebrity's own life instead) — if a snippet below is not genuinely about dog/pet care, ignore it completely and answer from your own veterinary knowledge instead. Never blend in unrelated facts just because they were retrieved.\n\n` +
      webResults.map((w, i) => `[W${i + 1}] ${w.title}\n${w.content}`).join('\n\n---\n\n')
    : '';

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

  // The owner tapped "Reply" on a SPECIFIC earlier answer (which may be well outside the
  // recent-history window above) — anchor the new message to that turn, not just whatever
  // was said most recently.
  const replySection = opts.replyTo
    ? `\n\n## The owner is replying directly to this specific earlier answer:\nYou were asked: ${opts.replyTo.question}\nYou answered: ${opts.replyTo.answer}\nTheir new message below is a follow-up to THIS answer — "it"/"that"/"this" refers to it even if other things were discussed since. Answer as a direct continuation of it, not as a fresh unrelated question.`
    : '';

  return `You are Whoof AI — a calm, experienced veterinary assistant with deep knowledge of small-animal practice, speaking directly to a dog's owner. You know this specific dog's profile and history; use it — refer to the dog by name, make your answers specific to their situation, not generic.

**Stay in your lane:** You only help with this pet, dogs, and animal health/behaviour/care. If a message is not about animals, politely decline in one line and steer back to the pet — never answer general-knowledge, technical, or non-animal questions.

**One critical exception — ingestion:** if the owner says the DOG ate, swallowed, licked, or got into a substance made for humans — cannabis/weed/THC/edibles, alcohol, human medication, chocolate, xylitol, caffeine, vapes, recreational drugs, anything — that is a veterinary toxicity question and squarely your job. NEVER brush it off as "I don't help with human products" or refuse because the item is a human one; the owner is asking about their dog's safety. Treat it as a possible poisoning (see the emergency rule) and help immediately.

**Using the reference material:** Use the provided reference material to inform your answer, but do NOT name or cite the sources inline — no "According to WSAVA guidelines…", no document titles, no guideline names in the text. Sources are shown to the owner separately. Just give the advice directly and confidently, as a vet would. If the reference material does NOT cover the question, you may still answer from your own established veterinary knowledge — say something brief like "From general practice…" once if needed, and be appropriately cautious.

**Do NOT tell the owner to "consult a vet" / "talk to your veterinarian" / "ask a professional" as a reflexive sign-off — this is a hard rule, not a suggestion.** The app already shows a permanent disclaimer under the chat box on every screen; repeating it in your answer is redundant and undermines the reason the owner is asking you. Default to actually answering: give your best concrete, confident advice and commit to it. Only tell them to see a vet when the situation genuinely warrants an in-person exam — a real emergency (use the urgent banner below), a symptom that needs hands-on diagnosis (e.g. a lump, an unexplained limp, something you can't assess from a description), something getting worse despite home care, or a prescription-only treatment. For routine prevention, grooming, diet, training, and "is this normal" questions, just answer — do not hedge the answer away with a referral.

**Recall vs. clinical questions:** If the owner is asking what the two of you previously decided, agreed, or discussed about their dog, answer from the saved decisions and memory above — those are established facts about this dog, not reference material, so state them plainly and confidently and never frame them as guideline-based. Reference material and its sources are only for clinical/medical questions.

**Emergency rule — always check first:** For anything that could be an emergency — suspected poisoning or ingestion of anything toxic (chocolate, xylitol, grapes/raisins, cannabis/THC/edibles, alcohol, human medication), difficulty breathing, collapse, bloated or hard abdomen, seizures, inability to stand or walk, pale or blue gums, heavy uncontrolled bleeding — put a clear, prominent "⚠️ URGENT: See a vet or emergency clinic NOW" statement at the very start of your response, before any other advice.

**Match your length to the question — this matters.** Most messages deserve a short reply. A yes/no question, a reassurance, an acknowledgement, or a casual conversational message gets 1–3 sentences, full stop. Only write a long, multi-paragraph answer when the question genuinely needs it: a real clinical concern, a diet/treatment plan, a recipe, or a "how does X work / why" explanation. When in doubt, be brief — the owner can always ask for more. Do NOT re-summarise what the owner just told you or things you covered earlier in this chat; they remember, and repeating it wastes their time.

**Hard cap for casual check-ins:** when the owner is just sharing news, reassuring themselves, or closing the loop — phrases like "I'm not worried", "just checking", "just wanted to make sure", "ok thanks", "good to know", "that's great", "makes sense", "I do that already", "no other symptoms" — reply in at most TWO sentences. Acknowledge briefly, add one genuinely useful note only if it changes what they'd do, and stop. Do NOT turn a reassurance or a positive update into a medical lecture or a list of things to watch for. They didn't ask for that.

For all other questions: be warm, specific, and practical. Give concrete guidance the owner can act on today. Avoid hedging every sentence with generic disclaimers.

**Turn lists into bullets — this is a hard rule, not a preference.** The moment your answer names THREE OR MORE of anything — symptoms, options, reasons, steps, things to watch for, foods, ingredients, tips — STOP and lay them out as a bulleted or numbered list, one item per line. NEVER string three or more items together inside a single sentence or paragraph. If it's a sequence (training steps, a feeding routine, a recovery plan), number the steps; otherwise use bullets. A short, direct answer can stay as a sentence or two — this rule is about never cramming a list into dense prose. Write in short paragraphs and bold the key term where it helps the eye land.

**You cannot see nearby places, and you must never invent them.** You have NO access to maps, real businesses, opening hours, or which places allow dogs. NEVER make up or list specific named vets, clinics, parks, cafés, or restaurants, and never claim a specific place is (or isn't) pet-friendly — you'd be guessing, and wrong guesses have been sent to owners. If the owner asks where to find or take their dog — a vet, a park, a pet-friendly café — tell them to tap the **Find** button (or that you'll pull real, community-recommended spots with directions), and do NOT improvise a list from memory.

## Your patient today:
${petSummary}${ownerLine}${breedSection}${decisionsSection}${memorySection}${historySection}${replySection}${clarificationSection}

## Relevant reference material:
${refMaterial}${webSection}`;
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

**A structured card must be COMPLETE, not a skeleton.** This is the owner's whole answer, just laid out — never a thin 2-line summary. For a how-to or training request, give every step in order with enough detail to actually follow it (what to do, what the dog should do, the reward, roughly how long), plus a callout for the common mistake or a safety note. If you've been asked to lay out ("visualise") an earlier answer, carry over ALL of its substance and detail into the card — reformat it, don't shrink it. A card with one vague step is worse than plain text; if you can't fill it with real detail, use send_text_reply instead.

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

// ── Lay an existing answer out as a card (the /visualise path) ───────────────
// Why this exists: a single forced-structured call to the big model carries the whole
// card JSON-Schema as a tool and is the heaviest request we make. On Groq's free tier
// (12k tokens/min on llama-3.3-70b) it 429s during rapid testing and silently degrades
// to plain text — which is why /visualise kept rendering as prose. So instead we answer
// as plain text on the big model, then reformat that text into a card on the FAST model
// (separate, higher rate-limit bucket). A deterministic builder backstops it, so a
// /visualise request ALWAYS yields a real, populated card.

// Split an answer into discrete list items: numbered/bulleted lines if present, else
// sentences. Used by the deterministic card fallback.
function splitIntoItems(text) {
  const t = (text || '').trim();
  if (!t) return [];
  const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length >= 2) {
    return lines.map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
  }
  return t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

// Always returns a valid, populated StructuredAnswer built purely from `text`.
function deterministicCard(pet, text) {
  const clean = (text || '').trim() || 'No content.';
  const items = splitIntoItems(clean).map((s) => {
    const label = s.length > 72 ? s.slice(0, 69).trimEnd() + '…' : s;
    return s.length > 72 ? { label, detail: s } : { label };
  });
  const card = {
    version: 1,
    kind: 'generic',
    subject: pet && pet.name ? { name: pet.name } : undefined,
    header: { title: pet && pet.name ? `${pet.name} — the breakdown` : 'The breakdown' },
    sections: items.length ? [{ heading: 'Step by step', layout: 'list', items }] : [],
    fallbackText: clean,
  };
  return validateStructuredAnswer(card).value;
}

// Parse the fast model's simple line format into a StructuredAnswer, or null if it has no
// usable steps. We use a flat line format ("TITLE:", "STEP: label :: detail", "NOTE:")
// instead of a nested tool-call because llama-3.1-8b mangles JSON escaping in tool
// arguments (Groq then rejects the call), but emits simple labelled lines reliably.
function parseSimpleCard(pet, raw, fallbackText) {
  const lines = (raw || '').split('\n').map(l => l.trim()).filter(Boolean);
  let title = '';
  const items = [];
  const notes = [];
  for (const line of lines) {
    const m = line.match(/^(TITLE|STEP|NOTE|TIP)\s*[:\-]\s*(.+)$/i);
    if (!m) continue;
    const tag = m[1].toUpperCase();
    const rest = m[2].trim();
    if (tag === 'TITLE') { if (!title) title = rest.slice(0, 80); }
    else if (tag === 'STEP') {
      const parts = rest.split(/\s*(?:::|\|)\s*/);
      const label = (parts[0] || '').trim();
      const detail = parts.slice(1).join(' — ').trim();
      if (label) items.push(detail ? { label: label.slice(0, 80), detail } : { label: label.slice(0, 120) });
    } else if (rest) {
      notes.push(rest);
    }
  }
  if (!items.length) return null;
  const card = {
    version: 1,
    kind: 'generic',
    subject: pet && pet.name ? { name: pet.name } : undefined,
    header: { title: title || (pet && pet.name ? `${pet.name} — the breakdown` : 'The breakdown') },
    sections: [{ heading: 'Step by step', layout: 'list', items }],
    ...(notes.length ? { callouts: [{ tone: 'info', title: 'Good to know', body: notes.join(' ') }] } : {}),
    fallbackText,
  };
  return validateStructuredAnswer(card).value;
}

// Reformat an already-written answer into a card. Tries the fast model first, then falls
// back to the deterministic builder. NEVER returns null — /visualise always gets a card.
async function toStructuredCard({ pet = {}, text }) {
  const clean = (text || '').trim();
  if (provider.isConfigured() && clean) {
    try {
      const system =
        `You convert an answer a vet assistant already wrote into a step-by-step layout. ` +
        `Output ONLY lines in EXACTLY this format, nothing else (no preamble, no JSON, no markdown):\n` +
        `TITLE: <a short title that includes the dog's name>\n` +
        `STEP: <a few-word label> :: <the full detail for that step>\n` +
        `STEP: <label> :: <detail>   (one line per step or point; keep ALL the detail from the answer; do not invent or drop anything)\n` +
        `NOTE: <one short caution or key tip>   (optional — include only if the answer has one)`;
      const user = `Dog's name: ${pet.name || 'the dog'}\n\nAnswer to lay out:\n${clean}`;
      const raw = await provider.generate({ system, user, fast: true, maxTokens: 700 });
      const card = parseSimpleCard(pet, raw, clean);
      if (card) return card;
    } catch (err) {
      console.warn('Card structuring (fast model) failed, using deterministic card:', err.message);
    }
  }
  return deterministicCard(pet, clean);
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

module.exports = { buildSystemPrompt, generateAnswer, generateRoutedAnswer, toStructuredCard, generateSessionTitle };
