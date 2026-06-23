'use strict';

/**
 * memory.js — one rolling summary per pet, spanning all PAST chats.
 *
 * This is NOT retrieval. There is a single fixed-size summary slot per pet
 * (pet_memory.digest). When chats other than the active one have turns that haven't
 * been folded in yet, we run ONE pass: prior summary + those turns → a new summary
 * that REPLACES the old one, capped at ~300 tokens. The folded turns are marked
 * summarized so they're never reprocessed.
 *
 * Result: memory-loading cost stays flat no matter how many past conversations a pet
 * has — a pet with 50 chats costs the same as one with 2, because we always compress
 * into the same slot instead of accumulating more to search.
 *
 * Trigger: a turn is rolled up once its chat is no longer the active one (i.e. the
 * owner has moved on to another chat). The active chat's recent turns stay verbatim
 * in the prompt via the route's within-chat history — they are not summarized yet.
 *
 * Raw transcripts remain in conversation_memory for audit; they are never embedded,
 * retrieved, or replayed across sessions — only this summary crosses sessions.
 */

const { query } = require('../db');
const provider = require('./llmProvider');

const MAX_SUMMARY_CHARS = 1400; // ~300 tokens

// Current rolling summary for a pet (empty string if none yet).
async function getRollingSummary(petId) {
  const r = await query('SELECT digest FROM pet_memory WHERE pet_id = $1', [petId]);
  return r.rows[0]?.digest || '';
}

// Fold every not-yet-summarized turn that belongs to a NON-active chat into the
// single rolling summary, replacing it. Fire-and-forget; never throws.
async function rollUpInactiveChats(petId, activeSessionId) {
  try {
    const pendingRes = await query(
      `SELECT id, owner_question, answer_summary, escalated
       FROM conversation_memory
       WHERE pet_id = $1
         AND summarized = false
         AND ($2::uuid IS NULL OR session_id IS DISTINCT FROM $2)
       ORDER BY created_at ASC`,
      [petId, activeSessionId || null],
    );
    const pending = pendingRes.rows;
    if (!pending.length) return;          // nothing has moved out of the active chat yet
    if (!provider.isConfigured()) return; // no model to summarise with

    const prior = await getRollingSummary(petId);

    const transcript = pending
      .map(t => `Owner: ${t.owner_question}\nWhoof AI: ${t.answer_summary}${t.escalated ? ' [flagged urgent]' : ''}`)
      .join('\n\n');

    const system =
      `You maintain ONE short rolling memory summary of a dog's past conversations, for a ` +
      `veterinary assistant to reload at the start of future chats. Merge the prior summary ` +
      `with the new conversations below into a SINGLE updated summary that REPLACES the old one.\n\n` +
      `Keep durable, useful facts: health issues and how they resolved, ongoing concerns, plans ` +
      `or routines discussed, food reactions, behaviour patterns, and outcomes. Drop greetings, ` +
      `small talk, and the dog's basic profile (breed/age/weight/sex — supplied separately).\n\n` +
      `Hard limit: keep the whole summary under ${MAX_SUMMARY_CHARS} characters (~300 tokens). It ` +
      `must NOT grow over time — compress older points to stay within budget. Terse notes, no ` +
      `preamble. Output only the updated summary.`;

    const user = `PRIOR SUMMARY:\n${prior || '(none yet)'}\n\nNEW CONVERSATIONS TO MERGE IN:\n${transcript}`;

    let summary = await provider.generate({ system, user, maxTokens: 500, fast: true });
    if (!summary) return;
    if (summary.length > MAX_SUMMARY_CHARS * 1.25) {
      summary = summary.slice(0, Math.floor(MAX_SUMMARY_CHARS * 1.25)).trimEnd() + '…';
    }

    await query(
      `INSERT INTO pet_memory (pet_id, digest, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (pet_id) DO UPDATE SET digest = EXCLUDED.digest, updated_at = now()`,
      [petId, summary],
    );

    // Mark these turns folded so they're never summarised again.
    const ids = pending.map(t => t.id);
    await query('UPDATE conversation_memory SET summarized = true WHERE id = ANY($1::uuid[])', [ids]);
  } catch (err) {
    console.warn('Rolling-summary update skipped:', err.message);
  }
}

module.exports = { getRollingSummary, rollUpInactiveChats, MAX_SUMMARY_CHARS };
