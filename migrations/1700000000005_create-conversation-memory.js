/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('conversation_memory', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    pet_id: {
      type: 'uuid',
      notNull: true,
      references: 'pet_profile',
      onDelete: 'CASCADE',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    owner_question: { type: 'text', notNull: true },
    symptom_tags: { type: 'text[]' },
    answer_summary: { type: 'text' },
    sources_cited: { type: 'jsonb' },
    escalated: { type: 'boolean', notNull: true, default: false },
    escalation_reason: { type: 'text' },
    confidence_level: {
      type: 'text',
      check: "confidence_level IN ('low','medium','high')",
    },
    owner_reported_outcome: { type: 'text' },
  });

  // B-tree on the pet_id FK (per spec). A composite (pet_id, created_at DESC) would
  // serve "most recent N memories for this pet" better — see README "Design flags".
  pgm.createIndex('conversation_memory', 'pet_id');
};

exports.down = (pgm) => {
  pgm.dropTable('conversation_memory');
};
