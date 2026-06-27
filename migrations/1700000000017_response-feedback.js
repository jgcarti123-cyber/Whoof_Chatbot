/* eslint-disable camelcase */

// response_feedback — one tester rating per conversation turn, for MANUAL review.
//
// This is a feedback LOG, not a training pipeline. One upsertable row per turn, keyed
// by the turn it rates. conversation_memory deliberately doesn't know feedback exists —
// the link points one way (feedback → turn), so the chat path is untouched and a feedback
// failure can never affect a conversation.
//
// - memory_id  PRIMARY KEY + FK → conversation_memory.id, ON DELETE CASCADE. Using the
//   turn id as the PK makes "submit or revise a rating" a natural upsert
//   (ON CONFLICT (memory_id) DO UPDATE), and one feedback row per turn falls out for free.
// - owner_id   FK → owners.id, set server-side from the session (never the request body).
//   Denormalized on purpose — reachable via conversation_memory → pet_profile.owner_id,
//   but "everything tester X said" is a query we'll run often, so it's worth storing flat.
// - rating     smallint 1–10, CHECK-constrained.
// - tags       text[] from a fixed vocabulary; also validated server-side in the route.
// - comment    optional free text.
// - created_at / updated_at — updated_at is bumped on every revision via the EXISTING
//   set_updated_at() trigger function (defined in the pet_profile migration), reused here.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('response_feedback', {
    memory_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'conversation_memory',
      onDelete: 'CASCADE',
    },
    owner_id: {
      type: 'uuid',
      notNull: true,
      references: 'owners',
      onDelete: 'CASCADE',
    },
    rating: {
      type: 'smallint',
      notNull: true,
      check: 'rating BETWEEN 1 AND 10',
    },
    tags: { type: 'text[]' },
    comment: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // "Show me what's failing" — the one query run over and over (low scores, newest first).
  // A partial index keeps it small and pointed straight at the rows worth reviewing.
  pgm.sql(
    'CREATE INDEX response_feedback_failing_idx ON response_feedback (created_at DESC) WHERE rating <= 4;',
  );

  // Index the denormalized owner FK — "everything tester X said" filters on it, and the
  // ON DELETE CASCADE means deleting an owner otherwise sequential-scans this table.
  pgm.createIndex('response_feedback', 'owner_id');

  // Reuse the shared set_updated_at() trigger fn (from the pet_profile migration) rather
  // than redefining it. Keeps updated_at honest on every revision (ON CONFLICT DO UPDATE).
  pgm.sql(`
    CREATE TRIGGER response_feedback_set_updated_at
    BEFORE UPDATE ON response_feedback
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  // Drop only the trigger, not set_updated_at() — that function is owned by the
  // pet_profile migration and other tables still depend on it.
  pgm.sql('DROP TRIGGER IF EXISTS response_feedback_set_updated_at ON response_feedback;');
  pgm.dropTable('response_feedback');
};
