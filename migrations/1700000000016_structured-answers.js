/* eslint-disable camelcase */

// Structured AI responses. Any assistant turn can be rendered as a structured card
// (stats, a schedule, callouts, tags, action buttons) instead of a plain text bubble —
// the model decides per answer. This adds the storage + telemetry for that mechanism.
//
// - structured_answer  — the validated StructuredAnswer payload (see lib/structured.js).
//   NULL for ordinary text turns. When present, the client renders the card; the turn's
//   answer_summary still holds the StructuredAnswer.fallbackText so every existing
//   text-based path (memory roll-up, search, decision detection) keeps working unchanged.
// - response_modality  — 'text' | 'structured'. Cheap to GROUP BY for a dashboard later.
// - structured_trigger — how the structured path was chosen: 'model' | 'phrase' | 'manual'.
// - structured_kind    — the StructuredAnswer.kind ('diet' | 'training' | ...), for analytics.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('conversation_memory', {
    structured_answer: { type: 'jsonb' },
    response_modality: {
      type: 'text',
      notNull: true,
      default: 'text',
      check: "response_modality IN ('text','structured')",
    },
    structured_trigger: { type: 'text' }, // model | phrase | manual
    structured_kind: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('conversation_memory', [
    'structured_answer',
    'response_modality',
    'structured_trigger',
    'structured_kind',
  ]);
};
