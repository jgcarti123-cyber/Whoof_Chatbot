/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('owners', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    email: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    // NOT NULL added on top of the spec: a column with a now() default should never
    // legitimately hold NULL. Same pattern on every created_at/updated_at below.
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('owners');
};
