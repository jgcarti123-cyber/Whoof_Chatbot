'use strict';

const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { query } = require('../db');

const router = express.Router();

// GET /onboarding — show form, pre-fill if profile already exists
router.get('/onboarding', requireAuth, async (req, res) => {
  try {
    const [petResult, breedsResult, ownerResult] = await Promise.all([
      query('SELECT * FROM pet_profile WHERE owner_id = $1 LIMIT 1', [req.session.ownerId]),
      query('SELECT breed_name, weight_range_kg FROM breed_reference ORDER BY breed_name'),
      query('SELECT owner_name FROM owners WHERE id = $1', [req.session.ownerId]),
    ]);
    const breeds = breedsResult.rows; // [{breed_name, weight_range_kg}]
    const ownerName = ownerResult.rows[0]?.owner_name || '';
    res.render('onboarding', { pet: petResult.rows[0] || null, breeds, ownerName, error: null });
  } catch (err) {
    console.error('Onboarding GET error:', err);
    res.render('onboarding', { pet: null, breeds: [], ownerName: '', error: 'Could not load profile.' });
  }
});

// POST /onboarding — upsert pet_profile, redirect to chat
router.post('/onboarding', requireAuth, async (req, res) => {
  const b = req.body;

  const name = b.name?.trim();
  const ownerName = b.owner_name?.trim() || null;
  if (!name) {
    return res.render('onboarding', {
      pet: b,
      breeds: [],
      ownerName: b.owner_name || '',
      error: "Please enter your dog's name.",
    });
  }

  // text[] columns arrive as comma-separated strings
  const foodAllergies = splitCSV(b.food_allergies);
  const temperamentFlags = splitCSV(b.temperament_flags);

  // vaccination_history: parallel arrays from the repeatable vaccine rows
  const vaccineNames = [b.vaccine_name].flat();
  const vaccineDates = [b.vaccine_date].flat();
  const vaccinationHistory = vaccineNames
    .map((name, i) => ({ vaccine: name?.trim(), date: vaccineDates[i]?.trim() || null }))
    .filter(v => v.vaccine);

  // known_medications: free text, stored as jsonb {notes: "..."}
  const knownMedications = b.known_medications_text?.trim()
    ? { notes: b.known_medications_text.trim() }
    : null;

  // Multi-meal diet: meal_entry[] arrives as array or single string
  const mealEntries = [b.meal_entry].flat().map(s => s?.trim()).filter(Boolean);
  const dietType = mealEntries.length ? mealEntries.join(' | ') : (b.diet_type?.trim() || null);

  // Past surgeries: surgery_desc[] and surgery_date[] arrive as parallel arrays
  const surgeryDescs = [b.surgery_desc].flat();
  const surgeryDates = [b.surgery_date].flat();
  const pastSurgeries = b.has_surgery === 'yes'
    ? surgeryDescs
        .map((desc, i) => ({ description: desc?.trim(), date: surgeryDates[i]?.trim() || null }))
        .filter(s => s.description)
    : [];

  // Body condition is auto-calculated on the frontend and submitted as a hidden field
  const bodyCondition = ['underweight', 'ideal', 'overweight'].includes(b.body_condition)
    ? b.body_condition : null;

  const data = {
    name,
    breed: b.breed?.trim() || 'Unknown',
    is_mixed_breed: b.is_mixed_breed === 'on',
    date_of_birth: b.date_of_birth || null,
    age_estimated_years: b.age_estimated_years ? parseFloat(b.age_estimated_years) : null,
    sex: b.sex || null,
    neutered: b.neutered === 'on',
    weight_kg: b.weight_kg ? parseFloat(b.weight_kg) : null,
    body_condition: bodyCondition,
    diet_type: dietType,
    meals_per_day: b.meals_per_day ? parseInt(b.meals_per_day, 10) : null,
    food_allergies: foodAllergies,
    treat_frequency: b.treat_frequency?.trim() || null,
    vaccination_history: vaccinationHistory.length ? vaccinationHistory : null,
    known_medications: knownMedications,
    known_drug_reactions: b.known_drug_reactions?.trim() || null,
    last_vet_visit_date: b.last_vet_visit_date || null,
    last_vet_visit_reason: b.last_vet_visit_reason?.trim() || null,
    living_situation: b.living_situation || null,
    region: b.region?.trim() || 'India',
    baseline_activity_level: b.baseline_activity_level?.trim() || null,
    other_animals_in_household: b.other_animals_in_household === 'on',
    household_has_children: b.household_has_children === 'on',
    temperament_flags: temperamentFlags,
    known_phobias: b.known_phobias?.trim() || null,
    past_surgeries: pastSurgeries,
  };

  try {
    // The owner's own name lives on owners; save it alongside the pet upsert so
    // it's mapped to this dog (one human → one account → one dog).
    await query('UPDATE owners SET owner_name = $1 WHERE id = $2', [ownerName, req.session.ownerId]);

    const existing = await query(
      'SELECT id FROM pet_profile WHERE owner_id = $1 LIMIT 1',
      [req.session.ownerId],
    );

    if (existing.rows.length > 0) {
      await query(
        `UPDATE pet_profile SET
           name=$2, breed=$3, is_mixed_breed=$4, date_of_birth=$5,
           age_estimated_years=$6, sex=$7, neutered=$8, weight_kg=$9,
           body_condition=$10, diet_type=$11, meals_per_day=$12,
           food_allergies=$13, treat_frequency=$14, vaccination_history=$15,
           known_medications=$16, known_drug_reactions=$17, last_vet_visit_date=$18,
           last_vet_visit_reason=$19, living_situation=$20, region=$21,
           baseline_activity_level=$22, other_animals_in_household=$23,
           household_has_children=$24, temperament_flags=$25, known_phobias=$26,
           past_surgeries=$27, updated_at=now()
         WHERE owner_id=$1`,
        [
          req.session.ownerId,
          data.name, data.breed, data.is_mixed_breed,
          data.date_of_birth, data.age_estimated_years, data.sex,
          data.neutered, data.weight_kg, data.body_condition,
          data.diet_type, data.meals_per_day,
          data.food_allergies, data.treat_frequency,
          JSON.stringify(data.vaccination_history),
          JSON.stringify(data.known_medications),
          data.known_drug_reactions, data.last_vet_visit_date,
          data.last_vet_visit_reason, data.living_situation,
          data.region, data.baseline_activity_level,
          data.other_animals_in_household, data.household_has_children,
          data.temperament_flags, data.known_phobias,
          JSON.stringify(data.past_surgeries),
        ],
      );
    } else {
      await query(
        `INSERT INTO pet_profile (
           owner_id, name, breed, is_mixed_breed, date_of_birth, age_estimated_years,
           sex, neutered, weight_kg, body_condition, diet_type, meals_per_day,
           food_allergies, treat_frequency, vaccination_history, known_medications,
           known_drug_reactions, last_vet_visit_date, last_vet_visit_reason,
           living_situation, region, baseline_activity_level,
           other_animals_in_household, household_has_children,
           temperament_flags, known_phobias, past_surgeries
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
         )`,
        [
          req.session.ownerId,
          data.name, data.breed, data.is_mixed_breed,
          data.date_of_birth, data.age_estimated_years, data.sex,
          data.neutered, data.weight_kg, data.body_condition,
          data.diet_type, data.meals_per_day,
          data.food_allergies, data.treat_frequency,
          JSON.stringify(data.vaccination_history),
          JSON.stringify(data.known_medications),
          data.known_drug_reactions, data.last_vet_visit_date,
          data.last_vet_visit_reason, data.living_situation,
          data.region, data.baseline_activity_level,
          data.other_animals_in_household, data.household_has_children,
          data.temperament_flags, data.known_phobias,
          JSON.stringify(data.past_surgeries),
        ],
      );
    }

    res.redirect('/chat');
  } catch (err) {
    console.error('Profile save error:', err);
    res.render('onboarding', { pet: b, breeds: [], ownerName: b.owner_name || '', error: 'Could not save profile. Please try again.' });
  }
});

function splitCSV(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = router;
