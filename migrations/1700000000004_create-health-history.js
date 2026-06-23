/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('health_history', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    pet_id: {
      type: 'uuid',
      notNull: true,
      references: 'pet_profile',
      onDelete: 'CASCADE',
    },
    date_recorded: { type: 'date', notNull: true },
    condition: { type: 'text', notNull: true },
    severity: { type: 'text', check: "severity IN ('mild','moderate','severe')" },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // B-tree on the pet_id FK (per spec): joins + cascade deletes.
  pgm.createIndex('health_history', 'pet_id');
};

exports.down = (pgm) => {
  pgm.dropTable('health_history');
};
