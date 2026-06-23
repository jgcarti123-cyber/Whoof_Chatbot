'use strict';

const provider = require('./llmProvider');

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

  const historySection = recentHistory.length
    ? '\n\n## Recent conversation history:\n' +
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

**Emergency rule — always check first:** For anything that could be an emergency — suspected poisoning (including chocolate, xylitol, grapes), difficulty breathing, collapse, bloated or hard abdomen, seizures, inability to stand or walk, pale or blue gums, heavy uncontrolled bleeding — put a clear, prominent "⚠️ URGENT: See a vet or emergency clinic NOW" statement at the very start of your response, before any other advice.

For all other questions: be warm, specific, and practical. Give concrete guidance the owner can act on today. Avoid hedging every sentence with generic disclaimers.

## Your patient today:
${petSummary}${breedSection}${historySection}${clarificationSection}

## Relevant reference material:
${refMaterial}`;
}

// Generates the vet answer via the configured provider (Groq or Anthropic).
async function generateAnswer(systemPrompt, userMessage) {
  return provider.generate({ system: systemPrompt, user: userMessage, maxTokens: 1024 });
}

module.exports = { buildPetSummary, buildSystemPrompt, generateAnswer };
