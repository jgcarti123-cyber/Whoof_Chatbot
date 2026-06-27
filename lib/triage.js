'use strict';

/**
 * triage.js — Pre-answer classification for the vet chat.
 *
 * One fast forced-tool call to claude-haiku-4-5 decides, before we spend a
 * sonnet call on a full answer:
 *   1. Is this question pet/animal-health related at all?  (gate off "capital of India")
 *   2. Is it a vague symptom/behaviour concern that we should triage with a few
 *      clarifying questions before answering? (e.g. "why is Monkey barking a lot?")
 *
 * Clarifying questions are returned with concrete multiple-choice options AND
 * an allow_text flag, so the UI can render selectable chips plus a "type your own"
 * field — mirroring the AskUserQuestion pattern.
 *
 * Fail-open: if the active LLM provider has no key or the call errors, we treat
 * the message as pet-related and needing no clarification, so the normal answer
 * path still runs. Works with whichever provider LLM_PROVIDER selects.
 */

const provider = require('./llmProvider');

const TRIAGE_TOOL = {
  name: 'triage_pet_question',
  description:
    'Classify a dog owner\'s chat message before the vet assistant answers it. ' +
    'Decide whether it is pet/animal-health related, and whether it is a vague ' +
    'symptom or behaviour concern that should be clarified with a few quick ' +
    'multiple-choice questions before giving advice.',
  parameters: {
    type: 'object',
    properties: {
      pet_related: {
        type: 'boolean',
        description:
          'TRUE only if the message is about this pet (or dogs/animals generally) — ' +
          'their health, symptoms, behaviour, diet, care, training, grooming, ' +
          'vaccinations, parasites, medication, breed traits, etc. ' +
          'FALSE for anything not about animals (general knowledge, geography, math, ' +
          'coding, news, the weather, the owner\'s own health, etc.).',
      },
      decline_message: {
        type: 'string',
        description:
          'Only when pet_related is FALSE: a short, warm one-to-two sentence reply, ' +
          'in the voice of Whoof AI, that gently says this is outside what ' +
          'it can help with and steers back to the pet. Reference the pet by name. ' +
          'Empty string when pet_related is TRUE.',
      },
      needs_clarification: {
        type: 'boolean',
        description:
          'TRUE ONLY when the owner is reporting an active, currently-observed ' +
          'PHYSICAL health symptom in their dog that is too vague to answer safely ' +
          'without more detail — and where "see a vet now vs. monitor at home" ' +
          'genuinely depends on that missing detail (e.g. "Monkey has been vomiting ' +
          'since this morning", "he is limping on his back leg", "she suddenly ' +
          'stopped eating", "there is a new lump on his side"). ' +
          'FALSE for everything else, including: ' +
          '(a) informational / educational questions, even about a symptom or ' +
          'condition — anything framed as "how do I know if...", "what are the signs ' +
          'of...", "how can I tell if...", "what causes...", "is it normal that...", ' +
          '"how do I help with..." (these just get answered); ' +
          '(b) behaviour, training, anxiety, barking, chewing, or temperament ' +
          'questions; ' +
          '(c) diet, nutrition, grooming, vaccination, parasite, breed, or general ' +
          'care questions; ' +
          '(d) any clear factual/advice question; ' +
          '(e) messages with obvious emergency red-flags (answered immediately). ' +
          'When in doubt, set FALSE and let Whoof AI answer.',
      },
      clarifying_questions: {
        type: 'array',
        description:
          'When needs_clarification is TRUE: 2 to 4 targeted triage questions whose ' +
          'answers would help distinguish "serious / see-a-vet" from "mild / monitor". ' +
          'Cover things like onset & duration, severity/frequency, and associated ' +
          'signs (appetite, energy, toileting, pain, triggers). Empty array otherwise.',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The clarifying question, addressed to the owner, referencing the pet by name where natural.',
            },
            options: {
              type: 'array',
              description:
                '3 to 5 short, mutually-exclusive answer choices the owner can tap. ' +
                'Concrete and plain-language, not clinical jargon.',
              items: { type: 'string' },
            },
            allow_text: {
              type: 'boolean',
              description: 'Whether the owner may also type a free-text answer instead of picking an option. Almost always true.',
            },
          },
          required: ['question', 'options', 'allow_text'],
        },
      },
    },
    required: ['pet_related', 'needs_clarification', 'clarifying_questions'],
  },
};

function buildTriageSystem(pet) {
  const name = pet?.name || 'the dog';
  const breed = pet?.breed ? `, a ${pet.breed}` : '';
  return `You are the triage step for "Whoof AI", a veterinary assistant that helps dog owners. The pet in this conversation is ${name}${breed}.

Your only job is to classify the owner's message using the triage_pet_question tool. Do not answer the question yourself.

Be generous about what counts as pet-related: any question about ${name}, dogs, or animal health/behaviour/care qualifies. Only mark pet_related = false for messages clearly unrelated to animals.

Ask for clarification ONLY when the owner is describing an active, currently-happening PHYSICAL health symptom in ${name} (e.g. vomiting, diarrhoea, limping, not eating, a new lump, a wound, laboured breathing) that is too vague to answer safely — and where knowing more would change whether you'd say "see a vet now" or "monitor at home". In that narrow case set needs_clarification = true.

For EVERYTHING ELSE, set needs_clarification = false so Whoof AI just answers. In particular, NEVER ask clarifying questions for:
• Informational questions — even about a symptom or condition. "How do I know if ${name} has separation anxiety?", "What are the signs of an ear infection?", "How can I tell if he's in pain?" are requests to EXPLAIN the signs, not reports of a current symptom. Answer them directly.
• Behaviour, training, anxiety, barking, chewing, or temperament questions.
• Diet, nutrition, grooming, vaccination, parasite, breed, or general-care questions.

If it is not clearly an active physical-health symptom the owner is reporting right now, do not ask — just let Whoof AI answer. When in doubt, needs_clarification = false. Never ask more than 4 questions; 2–3 is best. Keep options short and tappable.`;
}

// Returns a normalized triage result. Never throws — fail-open to the normal answer path.
async function triageQuestion(message, pet) {
  const failOpen = { pet_related: true, decline_message: '', needs_clarification: false, clarifying_questions: [] };
  if (!provider.isConfigured()) return failOpen;

  try {
    const out = await provider.generateStructured({
      system: buildTriageSystem(pet),
      user: message,
      tool: TRIAGE_TOOL,
      maxTokens: 900,
      fast: true,
    });

    if (!out) return failOpen;

    // Normalize / harden the shape
    const questions = Array.isArray(out.clarifying_questions) ? out.clarifying_questions : [];
    return {
      pet_related: out.pet_related !== false, // default true
      decline_message: typeof out.decline_message === 'string' ? out.decline_message : '',
      needs_clarification: !!out.needs_clarification && questions.length > 0,
      clarifying_questions: questions
        .filter(q => q && typeof q.question === 'string')
        .slice(0, 4)
        .map(q => ({
          question: q.question,
          options: Array.isArray(q.options) ? q.options.filter(o => typeof o === 'string').slice(0, 5) : [],
          // Product requirement: the owner can ALWAYS type their own answer,
          // regardless of what the triage model decides. Force it on.
          allow_text: true,
        }))
        .filter(q => q.options.length > 0),
    };
  } catch (err) {
    console.warn('Triage failed (proceeding to answer directly):', err.message);
    return failOpen;
  }
}

module.exports = { triageQuestion };
