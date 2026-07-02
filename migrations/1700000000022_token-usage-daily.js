/* eslint-disable camelcase */

exports.shorthands = undefined;

// Tracks cumulative Groq token usage per model per day, since Groq's API doesn't expose
// a queryable "remaining today" endpoint — only a per-MINUTE bucket on success responses.
// We sum usage.total_tokens ourselves (lib/tokenUsage.js) and persist it here so the count
// survives server restarts, which happen often in development.
exports.up = (pgm) => {
  pgm.createTable('token_usage_daily', {
    usage_date: { type: 'date', notNull: true },
    model: { type: 'text', notNull: true },
    tokens_used: { type: 'bigint', notNull: true, default: 0 },
  });
  pgm.addConstraint('token_usage_daily', 'token_usage_daily_pkey', {
    primaryKey: ['usage_date', 'model'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('token_usage_daily');
};
