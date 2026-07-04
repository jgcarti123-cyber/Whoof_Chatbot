/* eslint-disable camelcase */

// signup_requests — the self-serve "request access" flow on the login page.
//
// When a first-time user submits the signup form, we (a) create their owner row with a
// freshly generated access code (bcrypt hash stored on owners.access_code_hash, same as
// a seeded tester), and (b) record this row so the admin dashboard can show the request
// and the PLAINTEXT code, which the admin relays to the user out-of-band (WhatsApp/etc).
// The user can then log in with their email + that code.
//
// Why store the plaintext code here: the admin needs to READ it to pass it on, and bcrypt
// hashes are one-way. These are low-stakes, single-purpose beta invite codes, only ever
// visible behind the ADMIN_SECRET-gated dashboard — an acceptable tradeoff for a private
// beta. (The authoritative credential for login is still the bcrypt hash on owners; this
// column is purely for the admin's relay convenience.)

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('signup_requests', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // The owner row created for this request. Cascade: deleting the owner removes the
    // request too (no orphaned signup records).
    owner_id: {
      type: 'uuid',
      notNull: true,
      references: 'owners',
      onDelete: 'CASCADE',
    },
    name: { type: 'text' },       // the person's name, as typed on the signup form
    dog_name: { type: 'text' },   // their dog's name, for context before onboarding
    access_code: { type: 'text' }, // PLAINTEXT invite code, for the admin to relay
    // Flipped to true the first time this owner logs in successfully — lets the admin see
    // at a glance who has used their code and who is still waiting on it.
    activated: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('signup_requests', 'owner_id');
};

exports.down = (pgm) => {
  pgm.dropTable('signup_requests');
};
