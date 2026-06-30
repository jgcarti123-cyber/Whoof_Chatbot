/* eslint-disable camelcase */

// Saved regular vet — the clinic the owner usually sees. Stored on the pet so the
// booking-draft and the pre-visit summary can address/send to a known vet without
// re-asking each time. The visit-boundary date already exists as
// pet_profile.last_vet_visit_date (reused for "summary since last visit"). All
// nullable: existing pets simply have no saved vet until the owner adds one.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('pet_profile', {
    vet_name:   { type: 'text' },
    vet_clinic: { type: 'text' },
    vet_phone:  { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('pet_profile', ['vet_name', 'vet_clinic', 'vet_phone']);
};
