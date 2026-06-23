/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('pet_profile', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    owner_id: {
      type: 'uuid',
      notNull: true,
      references: 'owners',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    breed: { type: 'text', notNull: true },
    is_mixed_breed: { type: 'boolean', notNull: true, default: false },
    date_of_birth: { type: 'date' },                // nullable: many owners won't know it
    age_estimated_years: { type: 'numeric(4,1)' },   // used when DOB is unknown
    sex: { type: 'text', check: "sex IN ('male','female')" },
    neutered: { type: 'boolean' },
    weight_kg: { type: 'numeric(5,2)' },
    body_condition: {
      type: 'text',
      check: "body_condition IN ('underweight','ideal','overweight')",
    },
    diet_type: { type: 'text' },
    meals_per_day: { type: 'smallint' },
    food_allergies: { type: 'text[]' },
    treat_frequency: { type: 'text' },
    // jsonb array of {vaccine, date}. See README "Design flags" re: jsonb vs. a
    // normalized vaccinations child table.
    vaccination_history: { type: 'jsonb' },
    known_medications: { type: 'jsonb' },
    known_drug_reactions: { type: 'text' },
    last_vet_visit_date: { type: 'date' },
    last_vet_visit_reason: { type: 'text' },
    living_situation: {
      type: 'text',
      check: "living_situation IN ('indoor','outdoor','mixed')",
    },
    region: { type: 'text', notNull: true },         // city/state in India — climate-risk context later
    baseline_activity_level: { type: 'text' },
    other_animals_in_household: { type: 'boolean' },
    household_has_children: { type: 'boolean' },
    temperament_flags: { type: 'text[]' },
    known_phobias: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Index the owner_id FK. Beyond the spec's explicit list, but every FK we filter/join
  // on — especially one with ON DELETE CASCADE — should be indexed, or deleting an owner
  // forces a sequential scan of pet_profile. See README "Design flags".
  pgm.createIndex('pet_profile', 'owner_id');

  // GIN indexes for the array columns we expect to query by containment (@>, &&, ?).
  pgm.createIndex('pet_profile', 'temperament_flags', { method: 'gin' });
  pgm.createIndex('pet_profile', 'food_allergies', { method: 'gin' });

  // Keep updated_at honest. The column default only fires on INSERT; without this
  // trigger updated_at would never change on UPDATE. Remove this if you prefer to set
  // updated_at in application code instead. See README "Design flags".
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER pet_profile_set_updated_at
    BEFORE UPDATE ON pet_profile
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS pet_profile_set_updated_at ON pet_profile;');
  pgm.dropTable('pet_profile');
  pgm.sql('DROP FUNCTION IF EXISTS set_updated_at();');
};
