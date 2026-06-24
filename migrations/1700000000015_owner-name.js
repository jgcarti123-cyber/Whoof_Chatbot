/* eslint-disable camelcase */

// owner_name — the human's name (e.g. "John"), captured in onboarding and mapped
// to their dog. Lives on owners (one human → one account), read alongside the pet
// so the chat header and the AI can address the owner by name and know whose dog
// this is. Nullable: existing accounts simply have no name until they fill it in.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('owners', {
    owner_name: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('owners', 'owner_name');
};
