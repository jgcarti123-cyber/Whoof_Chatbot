/* eslint-disable camelcase */

// Cross-session memory, fixed. Three pieces:
//
// 1. pet_decisions — durable, confirmed facts ("Monkey's official diet plan"). These
//    are NOT retrieval targets: they're loaded as plain asserted fact into every
//    prompt. Superseding (not deleting) keeps an audit trail; only the active row
//    of each decision_type is used going forward.
//
// 2. conversation_memory.summarized — marks a turn as already folded into the rolling
//    summary, so the roll-up never re-processes it (keeps memory cost flat).
//
// 3. conversation_session.pending_decision — when the bot proactively offers to save a
//    decision, the proposal parks here until the owner's next message confirms ("yes")
//    or declines. Cleared either way.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('pet_decisions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    pet_id: {
      type: 'uuid',
      notNull: true,
      references: 'pet_profile',
      onDelete: 'CASCADE',
    },
    decision_type: { type: 'text', notNull: true }, // diet_plan | allergy | diagnosis | treatment_routine | other
    title: { type: 'text', notNull: true },
    content: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active','superseded')",
    },
    locked_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    superseded_at: { type: 'timestamptz' },
  });
  // "active decisions for this pet" is the hot path, loaded every request.
  pgm.createIndex('pet_decisions', ['pet_id', 'status']);

  pgm.addColumn('conversation_memory', {
    summarized: { type: 'boolean', notNull: true, default: false },
  });

  pgm.addColumn('conversation_session', {
    pending_decision: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('conversation_session', 'pending_decision');
  pgm.dropColumn('conversation_memory', 'summarized');
  pgm.dropTable('pet_decisions');
};
