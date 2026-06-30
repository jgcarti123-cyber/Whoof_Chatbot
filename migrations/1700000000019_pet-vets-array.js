/* eslint-disable camelcase */

// Multiple saved vets. Supersedes the single vet_name/vet_clinic/vet_phone columns
// (migration 018) with a `vets` jsonb array, each entry:
//   { id, name, clinic, phone, primary }
// One entry is flagged primary — the default target for the pre-visit summary and
// booking prefill. The old single-vet columns are backfilled into the array and then
// left in place (harmless) so nothing downstream breaks mid-deploy.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('pet_profile', {
    vets: { type: 'jsonb', notNull: true, default: '[]' },
  });

  // Backfill: any pet with an existing single vet becomes a one-entry primary array.
  pgm.sql(`
    UPDATE pet_profile
       SET vets = jsonb_build_array(jsonb_build_object(
             'id',      gen_random_uuid()::text,
             'name',    COALESCE(vet_name, ''),
             'clinic',  COALESCE(vet_clinic, ''),
             'phone',   COALESCE(vet_phone, ''),
             'primary', true
           ))
     WHERE (vet_name IS NOT NULL OR vet_clinic IS NOT NULL OR vet_phone IS NOT NULL)
       AND vets = '[]'::jsonb
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('pet_profile', 'vets');
};
