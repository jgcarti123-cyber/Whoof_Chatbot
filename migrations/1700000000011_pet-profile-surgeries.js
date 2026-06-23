'use strict';

exports.up = (pgm) => {
  pgm.addColumn('pet_profile', {
    past_surgeries: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('pet_profile', 'past_surgeries');
};
