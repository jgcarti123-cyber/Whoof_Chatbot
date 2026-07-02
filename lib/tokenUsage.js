'use strict';

/**
 * tokenUsage.js — tracks cumulative daily Groq token usage per model, since Groq's API
 * does not expose a queryable "tokens remaining today" endpoint. A live completion
 * response only carries a per-MINUTE rate-limit bucket in its headers
 * (x-ratelimit-remaining-tokens, resets in ~seconds) — the DAILY figure that actually
 * causes real outages only ever appears in the free-text of a 429 error, not as
 * something we can query proactively.
 *
 * So instead we sum usage.total_tokens from every real response ourselves and compare
 * against Groq's published free-tier daily caps (console.groq.com/docs/rate-limits,
 * verified 2026-07-01). Persisted in Postgres (not in-memory) so the count survives
 * server restarts, which happen often in development.
 *
 * Reset boundary: Groq's docs don't state the exact timezone/reset schedule for daily
 * limits, so this uses the UTC calendar day as the most common default — the real reset
 * moment may be a few hours off from this.
 *
 * Scope: these caps are per-ORGANIZATION (shared across every owner using this app), not
 * per Whoof user — there is no such thing as "your personal tokens" here.
 */

const { query } = require('../db');

const DAILY_LIMITS = {
  'llama-3.3-70b-versatile': 100000,
  'llama-3.1-8b-instant': 500000,
};

const todayUTC = () => new Date().toISOString().slice(0, 10);

// Fire-and-forget from the Groq call site — never throws, never blocks a chat response.
async function recordUsage(model, totalTokens) {
  if (!model || !DAILY_LIMITS[model] || !totalTokens) return;
  try {
    await query(
      `INSERT INTO token_usage_daily (usage_date, model, tokens_used)
       VALUES ($1, $2, $3)
       ON CONFLICT (usage_date, model) DO UPDATE
         SET tokens_used = token_usage_daily.tokens_used + EXCLUDED.tokens_used`,
      [todayUTC(), model, totalTokens],
    );
  } catch (err) {
    console.warn('[token-usage] record failed:', err.message);
  }
}

// Today's usage across every tracked model: [{ model, used, limit, remaining, percentRemaining }].
async function getQuotaSnapshot() {
  const models = Object.keys(DAILY_LIMITS);
  const r = await query(
    `SELECT model, tokens_used FROM token_usage_daily WHERE usage_date = $1 AND model = ANY($2::text[])`,
    [todayUTC(), models],
  );
  const usedByModel = Object.fromEntries(r.rows.map(row => [row.model, parseInt(row.tokens_used, 10)]));
  return models.map(model => {
    const used = usedByModel[model] || 0;
    const limit = DAILY_LIMITS[model];
    const remaining = Math.max(0, limit - used);
    return { model, used, limit, remaining, percentRemaining: Math.round((remaining / limit) * 100) };
  });
}

module.exports = { recordUsage, getQuotaSnapshot, DAILY_LIMITS };
