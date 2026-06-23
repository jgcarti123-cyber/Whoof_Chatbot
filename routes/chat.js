'use strict';

const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { query } = require('../db');
const { retrieveChunks, lookupBreed } = require('../lib/rag');
const { buildSystemPrompt, generateAnswer } = require('../lib/llm');
const { triageQuestion } = require('../lib/triage');

const router = express.Router();

// Simple keyword safety net — not NLP, intentionally over-triggers for a test.
const EMERGENCY_KEYWORDS = [
  "can't breathe", "cannot breathe", "not breathing", "difficulty breathing",
  "breathing difficulty", "struggling to breathe", "laboured breathing", "labored breathing",
  "gasping", "choking",
  "collapse", "collapsed", "unconscious", "unresponsive", "fainted", "passed out",
  "seizure", "fitting", "convulsion", "shaking violently", "trembling violently",
  "pale gums", "blue gums", "white gums", "grey gums",
  "bloated", "hard stomach", "hard abdomen", "distended abdomen", "twisted stomach", "bloat",
  "can't walk", "cannot walk", "unable to walk", "paralyzed", "paralysed",
  "can't stand", "cannot stand", "unable to stand",
  "heavy bleeding", "bleeding badly", "won't stop bleeding", "blood pouring",
  "swallowed poison", "ate poison", "rat poison", "suspected poison",
  "chocolate", "xylitol", "grapes", "raisins",
  "snake bite", "snake bit", "hit by car", "been hit by",
  "vomiting blood", "blood in vomit", "bloody vomit",
  "blood in stool", "bloody diarrhea", "bloody diarrhoea",
];

function checkEmergency(text) {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORDS.find(kw => lower.includes(kw)) || null;
}

const SYMPTOM_WORDS = [
  'vomit', 'diarrhea', 'diarrhoea', 'limp', 'scratch', 'itch', 'sneeze', 'cough',
  'fever', 'lethargy', 'lethargic', 'tired', 'not eating', 'appetite', 'weight loss',
  'bloat', 'pain', 'swollen', 'discharge', 'blood', 'seizure', 'collapse',
  'breathing', 'drinking', 'urinating', 'skin', 'ear', 'eye', 'paw', 'joint',
  'limping', 'shaking', 'trembling', 'scratching',
];

function extractSymptomTags(text) {
  const lower = text.toLowerCase();
  return SYMPTOM_WORDS.filter(w => lower.includes(w)).slice(0, 6);
}

// GET /chat
router.get('/chat', requireAuth, async (req, res) => {
  try {
    const petResult = await query(
      'SELECT * FROM pet_profile WHERE owner_id = $1 LIMIT 1',
      [req.session.ownerId],
    );
    if (!petResult.rows.length) return res.redirect('/onboarding');

    const pet = petResult.rows[0];

    const histResult = await query(
      `SELECT id, created_at, owner_question, answer_summary, sources_cited,
              escalated, confidence_level
       FROM conversation_memory
       WHERE pet_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [pet.id],
    );
    const history = histResult.rows.reverse();

    res.render('chat', { pet, history });
  } catch (err) {
    console.error('Chat GET error:', err);
    res.status(500).send('Error loading chat.');
  }
});

// Turns the owner's clarifying answers into one text block, appended to the
// original question — used both for retrieval and for the answer's context.
function enrichMessage(message, clarifications) {
  if (!clarifications.length) return message;
  const lines = clarifications.map(c => `- ${c.question} → ${c.answer}`).join('\n');
  return `${message}\n\nOwner's answers to triage questions:\n${lines}`;
}

// POST /api/chat/message
// Body: { message: string, clarifications?: [{ question, answer }] }
router.post('/api/chat/message', requireAuth, async (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  // Clarifying answers from a prior triage round (if the UI is on the 2nd submit)
  const clarifications = Array.isArray(req.body.clarifications)
    ? req.body.clarifications
        .filter(c => c && typeof c.question === 'string' && typeof c.answer === 'string' && c.answer.trim())
        .map(c => ({ question: c.question, answer: c.answer.trim() }))
    : [];

  try {
    const petResult = await query(
      'SELECT * FROM pet_profile WHERE owner_id = $1 LIMIT 1',
      [req.session.ownerId],
    );
    if (!petResult.rows.length) {
      return res.status(400).json({ error: 'No pet profile found. Please complete onboarding.' });
    }
    const pet = petResult.rows[0];

    // Enriched text includes clarifying answers (used for emergency check + retrieval)
    const enriched = enrichMessage(message, clarifications);

    // Emergency check first — emergencies short-circuit triage and are answered now.
    const emergencyMatch = checkEmergency(enriched);
    const escalated = !!emergencyMatch;
    const escalationReason = emergencyMatch ? `Keyword match: "${emergencyMatch}"` : null;

    // ── Triage step ──────────────────────────────────────────────────────────
    // Runs on the FIRST submit only (no clarifications yet) and not for emergencies.
    if (!escalated && clarifications.length === 0) {
      const triage = await triageQuestion(message, pet);

      // 1. Off-topic → polite decline, no expensive answer call.
      if (!triage.pet_related) {
        const decline = triage.decline_message
          || `I'm Whoof AI — I can only help with ${pet.name} and other pet-health questions. Ask me anything about ${pet.name} and I'm happy to help!`;
        const memResult = await query(
          `INSERT INTO conversation_memory (
             pet_id, owner_question, answer_summary, sources_cited,
             symptom_tags, confidence_level, escalated, escalation_reason
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
          [pet.id, message, decline, JSON.stringify([]), [], 'low', false, 'off_topic'],
        );
        return res.json({
          off_topic: true,
          answer: decline,
          sources: [],
          escalated: false,
          confidence_level: 'low',
          memory_id: memResult.rows[0].id,
          created_at: memResult.rows[0].created_at,
        });
      }

      // 2. Needs clarification → return questions, don't answer or persist yet.
      if (triage.needs_clarification) {
        return res.json({
          needs_clarification: true,
          original_message: message,
          clarifying_questions: triage.clarifying_questions,
        });
      }
      // 3. Otherwise fall through and answer directly.
    }

    // ── Answer path ──────────────────────────────────────────────────────────

    // Breed lookup — direct table query, not vector search
    let breedInfo = null;
    try {
      breedInfo = await lookupBreed(pet.breed);
    } catch (breedErr) {
      console.warn('Breed lookup failed (run migration 009):', breedErr.message);
    }

    // Recent history for context (last 5 exchanges, oldest first)
    const histResult = await query(
      `SELECT owner_question, answer_summary FROM conversation_memory
       WHERE pet_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [pet.id],
    );
    const recentHistory = histResult.rows.reverse();

    // RAG retrieval (hybrid + optional rewrite/rerank). Uses enriched text so
    // clarifying answers sharpen the retrieval query.
    let chunks = [];
    let topSimilarity = 0;
    let rewrittenQuery = enriched;

    try {
      const retrieved = await retrieveChunks(enriched, 5);
      chunks = retrieved.chunks;
      rewrittenQuery = retrieved.rewritten_query || enriched;
      topSimilarity = parseFloat(chunks[0]?.rrf_score ?? chunks[0]?.similarity ?? 0);
    } catch (ragErr) {
      console.warn('RAG retrieval failed (proceeding without KB):', ragErr.message);
    }

    // Build prompt + call Claude. Original message is the user turn; clarifying
    // answers are injected via system context so the chat bubble stays clean.
    const systemPrompt = buildSystemPrompt(pet, chunks, recentHistory, breedInfo, { clarifications });
    const answer = await generateAnswer(systemPrompt, message);

    // Did we fall back to general knowledge (no/weak retrieval)?
    const usedFallback = chunks.length === 0 || topSimilarity < 0.01;

    // Confidence based on top RRF score (RRF max ~0.033 for a perfect top hit)
    let confidenceLevel = 'low';
    if (chunks.length >= 3 && topSimilarity > 0.02) confidenceLevel = 'high';
    else if (topSimilarity > 0.01) confidenceLevel = 'medium';

    const symptomTags = extractSymptomTags(enriched);
    const sourcesCited = chunks.map(c => ({
      source: c.source_title || c.source,
      topic: c.topic,
      section: c.section || null,
      chunk_type: c.chunk_type || 'body',
      page_number: c.page_number || null,
      rrf_score: parseFloat(parseFloat(c.rrf_score ?? c.similarity ?? 0).toFixed(4)),
    }));

    const memResult = await query(
      `INSERT INTO conversation_memory (
         pet_id, owner_question, answer_summary, sources_cited,
         symptom_tags, confidence_level, escalated, escalation_reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        pet.id, message, answer,
        JSON.stringify(sourcesCited),
        symptomTags,
        confidenceLevel,
        escalated,
        escalationReason,
      ],
    );

    res.json({
      answer,
      sources: sourcesCited,
      escalated,
      escalation_reason: escalationReason,
      confidence_level: confidenceLevel,
      used_fallback: usedFallback,
      rewritten_query: rewrittenQuery !== enriched ? rewrittenQuery : undefined,
      memory_id: memResult.rows[0].id,
      created_at: memResult.rows[0].created_at,
    });
  } catch (err) {
    console.error('Chat message error:', err);
    res.status(500).json({ error: 'Failed to get a response. Please try again.' });
  }
});

module.exports = router;
