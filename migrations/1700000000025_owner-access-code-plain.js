/* eslint-disable camelcase */

// access_code — the PLAINTEXT invite code, stored directly on owners so the admin
// dashboard can show a code for every user (not just self-serve signups, which already
// had one via signup_requests.access_code). owners.access_code_hash remains the only
// thing login actually checks; this column exists purely for the admin's relay
// convenience, same tradeoff already accepted for signup_requests.access_code.
//
// Nullable: existing owners created before this column don't have a stored plaintext
// (only the hash) until scripts/backfill-access-codes.js gives them a fresh one.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('owners', {
    access_code: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('owners', 'access_code');
};
