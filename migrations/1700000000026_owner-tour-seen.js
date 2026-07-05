/* eslint-disable camelcase */

// tour_seen — whether this owner has seen the one-time feature tour (Pet profile → Find
// nearby → My Vet → /visualise) shown once on their first visit to /chat right after
// completing onboarding. Flips to true the moment the tour is skipped or finished — it
// never shows again after that, by design (not "show whenever chat is empty").
//
// Backfilled true for any owner that already has a pet_profile at migration time: they're
// already past onboarding, so surfacing a first-run tour out of nowhere for an existing
// tester would be confusing, not helpful. Only genuinely new signups (or anyone mid-
// onboarding right now) end up with tour_seen = false and see it.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('owners', {
    tour_seen: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
  pgm.sql(`
    UPDATE owners SET tour_seen = true
    WHERE id IN (SELECT DISTINCT owner_id FROM pet_profile);
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('owners', 'tour_seen');
};
