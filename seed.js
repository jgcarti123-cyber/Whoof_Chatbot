'use strict';

// Inserts one example owner + pet_profile (+ a sample health_history row) so the
// schema can be sanity-checked by querying real data. Safe to run more than once.
//   npm run seed

require('dotenv').config();
const { pool } = require('./db');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert the demo owner by unique email so reruns don't error.
    const ownerRes = await client.query(
      `INSERT INTO owners (email)
       VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email;`,
      ['demo.owner@whoof.example'],
    );
    const owner = ownerRes.rows[0];

    // Only create the pet if this owner doesn't already have it (no unique key to upsert on).
    const existing = await client.query(
      'SELECT id, name FROM pet_profile WHERE owner_id = $1 AND name = $2',
      [owner.id, 'Bruno'],
    );

    let pet;
    if (existing.rows.length === 0) {
      const petRes = await client.query(
        `INSERT INTO pet_profile (
            owner_id, name, breed, is_mixed_breed, age_estimated_years, sex, neutered,
            weight_kg, body_condition, diet_type, meals_per_day, food_allergies,
            treat_frequency, vaccination_history, known_medications, last_vet_visit_date,
            last_vet_visit_reason, living_situation, region, baseline_activity_level,
            other_animals_in_household, household_has_children, temperament_flags, known_phobias
         ) VALUES (
            $1, 'Bruno', 'Labrador Retriever', false, 3.5, 'male', true,
            28.40, 'ideal', 'home-cooked + kibble', 2, ARRAY['chicken'],
            'daily', $2::jsonb, $3::jsonb, DATE '2026-04-10',
            'annual checkup + vaccines', 'indoor', 'Bengaluru, Karnataka', 'high',
            true, true, ARRAY['friendly', 'food-motivated'], 'thunderstorms'
         )
         RETURNING id, name;`,
        [
          owner.id,
          JSON.stringify([
            { vaccine: 'Rabies', date: '2026-04-10' },
            { vaccine: 'DHPPi', date: '2026-04-10' },
          ]),
          JSON.stringify([]),
        ],
      );
      pet = petRes.rows[0];

      // A sample health_history row so the child table isn't empty either.
      await client.query(
        `INSERT INTO health_history (pet_id, date_recorded, condition, severity, notes)
         VALUES ($1, DATE '2026-05-02', 'Ear infection (otitis externa)', 'mild',
                 'Right ear; resolved with a 7-day course of ear drops.');`,
        [pet.id],
      );
    } else {
      pet = existing.rows[0];
    }

    await client.query('COMMIT');

    console.log('Seed complete.');
    console.log(`  Owner: ${owner.id}  (${owner.email})`);
    console.log(`  Pet:   ${pet.id}  (${pet.name})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
