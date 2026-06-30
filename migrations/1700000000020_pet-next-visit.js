/* eslint-disable camelcase */

// next_vet_visit_date — a future appointment the owner has scheduled, separate from
// last_vet_visit_date (which marks a completed visit and resets the "since last visit"
// summary boundary). Lets the UI show an upcoming appointment and, later, act on it
// (e.g. reminders) without confusing it with visit history.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('pet_profile', {
    next_vet_visit_date: { type: 'date' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('pet_profile', 'next_vet_visit_date');
};
