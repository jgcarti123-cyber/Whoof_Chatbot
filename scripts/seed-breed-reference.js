'use strict';

/**
 * Seeds breed_reference with common breeds in India + required fallbacks.
 * Idempotent: uses ON CONFLICT DO UPDATE so re-running updates existing rows.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../db');

const BREEDS = [
  {
    breed_name: 'Labrador Retriever',
    weight_range_kg: '25–36',
    common_conditions: ['hip dysplasia', 'elbow dysplasia', 'obesity', 'ear infections', 'exercise-induced collapse'],
    life_expectancy_years: '10–12',
    temperament_notes: 'Friendly, outgoing, energetic. Strong food motivation. High exercise needs.',
    source: 'Breed health surveys / OFA data',
  },
  {
    breed_name: 'Golden Retriever',
    weight_range_kg: '25–34',
    common_conditions: ['hip dysplasia', 'cancer (higher incidence)', 'hypothyroidism', 'skin allergies', 'heart disease (SAS)'],
    life_expectancy_years: '10–12',
    temperament_notes: 'Gentle, loyal, eager to please. Tolerates children and other pets well.',
    source: 'Breed health surveys / GRCA health data',
  },
  {
    breed_name: 'German Shepherd',
    weight_range_kg: '22–40',
    common_conditions: ['hip dysplasia', 'degenerative myelopathy', 'bloat (GDV)', 'exocrine pancreatic insufficiency', 'perianal fistula'],
    life_expectancy_years: '9–13',
    temperament_notes: 'Loyal, confident, courageous. High intelligence and working drive. Needs daily exercise and mental stimulation.',
    source: 'Breed health surveys / GSDCA',
  },
  {
    breed_name: 'Pug',
    weight_range_kg: '6–8',
    common_conditions: ['brachycephalic airway syndrome (BOAS)', 'pug dog encephalitis', 'obesity', 'skin fold infections', 'eye ulcers', 'hip dysplasia'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Playful, charming, even-tempered. Very popular in India. Heat-sensitive; exercise tolerance limited by airway anatomy.',
    source: 'BSAVA breed predispositions / clinical experience',
  },
  {
    breed_name: 'Shih Tzu',
    weight_range_kg: '4–7.5',
    common_conditions: ['brachycephalic syndrome', 'dental disease', 'eye conditions (exposure keratopathy)', 'ear infections', 'patellar luxation'],
    life_expectancy_years: '10–16',
    temperament_notes: 'Affectionate, alert, friendly. Coat requires daily grooming. Generally good with families.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Beagle',
    weight_range_kg: '9–11',
    common_conditions: ['obesity', 'epilepsy', 'cherry eye', 'intervertebral disc disease', 'ear infections'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Curious, friendly, merry. Strong scent drive. Can be vocal. Common breed in Indian cities.',
    source: 'Breed health surveys',
  },
  {
    breed_name: 'Rottweiler',
    weight_range_kg: '35–60',
    common_conditions: ['osteosarcoma', 'hip/elbow dysplasia', 'bloat (GDV)', 'heart disease (SAS/DCM)', 'parvovirus susceptibility'],
    life_expectancy_years: '8–10',
    temperament_notes: 'Loyal, confident, calm. Requires firm, consistent training and early socialisation. High exercise requirements.',
    source: 'AKC health data / breed surveys',
  },
  {
    breed_name: 'Doberman Pinscher',
    weight_range_kg: '27–45',
    common_conditions: ['dilated cardiomyopathy (DCM)', 'von Willebrand disease', 'cervical vertebral instability (Wobbler)', 'bloat (GDV)'],
    life_expectancy_years: '10–13',
    temperament_notes: 'Alert, fearless, loyal. Needs structured exercise and mental engagement. Cardiac screening recommended annually from age 3.',
    source: 'Doberman Health Inc / breed health surveys',
  },
  {
    breed_name: 'Dachshund',
    weight_range_kg: '7–15',
    common_conditions: ['intervertebral disc disease (IVDD)', 'obesity', 'patellar luxation', 'progressive retinal atrophy', 'Cushing\'s disease'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Curious, lively, clever. Long back makes jumping hazardous. Ramps preferred over stairs. Weight management critical.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Cocker Spaniel',
    weight_range_kg: '12–16',
    common_conditions: ['ear infections (chronic otitis)', 'eye disease (cataracts, glaucoma)', 'skin allergies', 'hip dysplasia', 'autoimmune haemolytic anaemia'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Gentle, sociable, cheerful. Long floppy ears trap moisture — weekly ear cleaning essential.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Indian Pariah Dog',
    weight_range_kg: '15–30',
    common_conditions: ['tick-borne diseases (ehrlichiosis, babesiosis)', 'transmissible venereal tumour (TVT)', 'mange', 'canine distemper (if unvaccinated)'],
    life_expectancy_years: '13–15',
    temperament_notes: 'Independent, alert, territorial. Excellent immune resilience compared to pedigree breeds. Common in India as both street dogs and increasingly as companion pets. Also known as "Indie" or "INDog".',
    source: 'Indian veterinary clinical experience / IndiDog breed documentation',
  },
  // ── More popular breeds in India ────────────────────────────────────────────
  {
    breed_name: 'Indian Spitz',
    weight_range_kg: '5–7',
    common_conditions: ['dental disease', 'patellar luxation', 'eye infections', 'obesity'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Alert, playful, vocal. One of the most popular breeds in India. Adapts well to apartment life. Often mistaken for Pomeranian.',
    source: 'Indian veterinary clinical experience',
  },
  {
    breed_name: 'Rajapalayam',
    weight_range_kg: '20–30',
    common_conditions: ['deafness (linked to white coat gene)', 'skin sensitivity', 'hip dysplasia'],
    life_expectancy_years: '10–12',
    temperament_notes: 'Loyal, reserved with strangers, strong prey drive. Native South Indian sighthound. Requires experienced owner.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Mudhol Hound',
    weight_range_kg: '22–28',
    common_conditions: ['low body fat (cold-sensitive)', 'skin injuries', 'bloat risk'],
    life_expectancy_years: '10–14',
    temperament_notes: 'Agile, swift, reserved. Native Karnataka/Maharashtra sighthound. Lean build needs warmth in cold weather.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Kombai',
    weight_range_kg: '20–30',
    common_conditions: ['skin conditions', 'tick-borne diseases'],
    life_expectancy_years: '12–14',
    temperament_notes: 'Fierce, territorial, loyal. Ancient Tamil Nadu working/guard dog. Needs firm training and early socialisation.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Chippiparai',
    weight_range_kg: '15–20',
    common_conditions: ['low body fat (cold-sensitive)', 'skin issues'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Swift, elegant, dignified. Native Tamil Nadu sighthound. Very independent nature.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Kanni',
    weight_range_kg: '16–22',
    common_conditions: ['cold sensitivity', 'tick-borne diseases'],
    life_expectancy_years: '12–14',
    temperament_notes: 'Gentle yet athletic. Rare native Tamil sighthound; considered sacred in Tamil culture.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Rampur Greyhound',
    weight_range_kg: '27–30',
    common_conditions: ['bloat (GDV)', 'cold sensitivity', 'bone injuries'],
    life_expectancy_years: '10–13',
    temperament_notes: 'Fast, powerful, calm indoors. Native North Indian sighthound. Requires large exercise space.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Gaddi Kutta',
    weight_range_kg: '35–45',
    common_conditions: ['hip dysplasia', 'bloat (GDV)', 'joint issues'],
    life_expectancy_years: '10–12',
    temperament_notes: 'Brave, loyal, thick-coated Himalayan mountain dog. Used as flock guardian. Needs space and cold tolerant.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Jonangi',
    weight_range_kg: '15–22',
    common_conditions: ['skin issues', 'tick-borne diseases'],
    life_expectancy_years: '12–14',
    temperament_notes: 'Unusual yodelling vocalisation (does not bark typically). Native Andhra Pradesh/West Bengal. Lean and agile.',
    source: 'Indian native breed documentation',
  },
  {
    breed_name: 'Boxer',
    weight_range_kg: '25–32',
    common_conditions: ['brachycephalic syndrome (moderate)', 'heart disease (AS/DCM)', 'cancer', 'hip dysplasia', 'bloat (GDV)'],
    life_expectancy_years: '10–12',
    temperament_notes: 'Playful, energetic, loyal. Great family dog. Heat-sensitive due to short snout.',
    source: 'AKC health data / breed surveys',
  },
  {
    breed_name: 'Dalmatian',
    weight_range_kg: '23–30',
    common_conditions: ['deafness (congenital)', 'urinary stones (urate)', 'skin allergies', 'hip dysplasia'],
    life_expectancy_years: '11–13',
    temperament_notes: 'High energy, intelligent, sensitive. Needs lots of exercise. BAER hearing test recommended in puppies.',
    source: 'Dalmatian Club health surveys',
  },
  {
    breed_name: 'Great Dane',
    weight_range_kg: '45–90',
    common_conditions: ['bloat/GDV (very high risk)', 'dilated cardiomyopathy (DCM)', 'hip dysplasia', 'bone cancer', 'Wobbler syndrome'],
    life_expectancy_years: '7–10',
    temperament_notes: 'Gentle giant. Requires large space. Bloat is life-threatening — know the signs. Cardiac screening advised annually.',
    source: 'Great Dane Club health data',
  },
  {
    breed_name: 'Siberian Husky',
    weight_range_kg: '16–27',
    common_conditions: ['eye conditions (cataracts, PRA)', 'hip dysplasia', 'hypothyroidism', 'zinc-responsive dermatosis'],
    life_expectancy_years: '12–14',
    temperament_notes: 'Energetic, friendly, escape artist. Struggles in Indian heat — needs AC environment and limited outdoor exercise midday.',
    source: 'Breed health surveys / OFA',
  },
  {
    breed_name: 'Lhasa Apso',
    weight_range_kg: '5–8',
    common_conditions: ['eye conditions (cherry eye, dry eye)', 'kidney disease (hereditary)', 'dental disease', 'skin issues'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Assertive, comical, loyal. Originally Tibetan temple dogs. Long coat needs regular grooming.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Pomeranian',
    weight_range_kg: '1.4–3.2',
    common_conditions: ['patellar luxation', 'tracheal collapse', 'dental disease', 'alopecia X', 'hypothyroidism'],
    life_expectancy_years: '12–16',
    temperament_notes: 'Extroverted, alert, lively. Popular in Indian cities. Double coat requires regular brushing.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Chihuahua',
    weight_range_kg: '1.5–3',
    common_conditions: ['patellar luxation', 'tracheal collapse', 'dental disease', 'hypoglycaemia', 'heart valve disease (MVD)'],
    life_expectancy_years: '12–18',
    temperament_notes: 'Bold, loyal, alert. World\'s smallest breed. Cold-sensitive. Fragile — supervision with children essential.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'French Bulldog',
    weight_range_kg: '8–13',
    common_conditions: ['brachycephalic airway syndrome (severe)', 'spinal disease (hemivertebrae)', 'skin fold infections', 'eye ulcers', 'reproductive difficulties'],
    life_expectancy_years: '10–12',
    temperament_notes: 'Adaptable, playful, sociable. Cannot tolerate Indian heat — AC essential. Cannot swim unaided.',
    source: 'BSAVA / French Bulldog health surveys',
  },
  {
    breed_name: 'English Bulldog',
    weight_range_kg: '18–25',
    common_conditions: ['brachycephalic airway syndrome (severe)', 'hip dysplasia', 'skin fold infections', 'eye conditions', 'heart disease'],
    life_expectancy_years: '8–10',
    temperament_notes: 'Calm, courageous, friendly. Extremely heat-sensitive; AC mandatory in India. Cannot exercise strenuously.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Yorkshire Terrier',
    weight_range_kg: '2–3.2',
    common_conditions: ['patellar luxation', 'tracheal collapse', 'dental disease', 'portosystemic shunt', 'hypoglycaemia'],
    life_expectancy_years: '13–16',
    temperament_notes: 'Bold, independent, affectionate. Silky coat requires daily grooming. Popular apartment breed.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Maltese',
    weight_range_kg: '3–4',
    common_conditions: ['dental disease', 'patellar luxation', 'tear staining', 'portosystemic shunt', 'tracheal collapse'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Gentle, playful, charming. White coat requires daily care. Good for small apartments.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Border Collie',
    weight_range_kg: '12–20',
    common_conditions: ['collie eye anomaly (CEA)', 'epilepsy', 'hip dysplasia', 'TNS (trapped neutrophil syndrome)'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Highly intelligent, intense, energetic. Needs a job to do. Not suited to apartment life without extensive daily exercise and mental stimulation.',
    source: 'Breed health surveys / OFA',
  },
  {
    breed_name: 'Miniature Schnauzer',
    weight_range_kg: '5–9',
    common_conditions: ['pancreatitis', 'bladder stones', 'hyperlipidaemia', 'progressive retinal atrophy', 'myotonia congenita'],
    life_expectancy_years: '12–15',
    temperament_notes: 'Spirited, alert, friendly. Low-shedding wiry coat. High-fat diets especially dangerous — strong predisposition to pancreatitis.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Basset Hound',
    weight_range_kg: '20–29',
    common_conditions: ['intervertebral disc disease (IVDD)', 'ear infections (chronic)', 'obesity', 'bloat', 'eye conditions (entropion/ectropion)'],
    life_expectancy_years: '10–12',
    temperament_notes: 'Laid-back, friendly, stubborn. Long ears need weekly cleaning. Weight management critical.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Jack Russell Terrier',
    weight_range_kg: '5–8',
    common_conditions: ['patellar luxation', 'lens luxation', 'deafness', 'Legg-Calvé-Perthes disease'],
    life_expectancy_years: '13–16',
    temperament_notes: 'Fearless, energetic, tenacious. Requires lots of exercise. May have high prey drive.',
    source: 'Breed health surveys',
  },
  {
    breed_name: 'Cavalier King Charles Spaniel',
    weight_range_kg: '5–8',
    common_conditions: ['mitral valve disease (MVD) — very high risk', 'syringomyelia/Chiari malformation', 'hip dysplasia', 'eye conditions'],
    life_expectancy_years: '9–14',
    temperament_notes: 'Affectionate, gentle, sociable. Heart murmur screening essential — majority develop MVD by age 5. Annual cardiac auscultation recommended.',
    source: 'BSAVA / Cavalier Health surveys',
  },
  {
    breed_name: 'Spitz (Japanese / German)',
    weight_range_kg: '5–10',
    common_conditions: ['patellar luxation', 'dental disease', 'eye conditions'],
    life_expectancy_years: '12–16',
    temperament_notes: 'Fluffy, alert, loyal. Common in India as companion dogs. Resembles Indian Spitz; breed standards vary.',
    source: 'Breed health surveys',
  },
  {
    breed_name: 'Saint Bernard',
    weight_range_kg: '54–82',
    common_conditions: ['hip/elbow dysplasia', 'bloat (GDV)', 'heart disease (DCM)', 'ectropion/entropion'],
    life_expectancy_years: '8–10',
    temperament_notes: 'Gentle, patient, friendly. Struggles severely in Indian heat — AC mandatory. Drools heavily.',
    source: 'Breed health surveys',
  },
  {
    breed_name: 'Chow Chow',
    weight_range_kg: '20–32',
    common_conditions: ['hip dysplasia', 'elbow dysplasia', 'patellar luxation', 'skin conditions', 'eye conditions (entropion)'],
    life_expectancy_years: '8–12',
    temperament_notes: 'Aloof, loyal, independent. Heavy coat poorly suited to Indian summers — needs AC. Can be dog-aggressive.',
    source: 'BSAVA breed predispositions',
  },
  {
    breed_name: 'Mixed breed / unknown',
    weight_range_kg: 'varies',
    common_conditions: ['generally lower breed-specific disease risk', 'tick-borne diseases (India)', 'dental disease', 'obesity'],
    life_expectancy_years: '13–17',
    temperament_notes: 'Highly variable. Often demonstrate hybrid vigour with lower incidence of breed-specific hereditary conditions.',
    source: 'Fallback row — used when breed is unrecognised or unknown',
  },
];

async function seedBreeds() {
  const client = await pool.connect();
  console.log('\nSeeding breed_reference table...\n');
  try {
    await client.query('BEGIN');
    let inserted = 0, updated = 0;

    for (const b of BREEDS) {
      const result = await client.query(
        `INSERT INTO breed_reference
           (breed_name, weight_range_kg, common_conditions, life_expectancy_years, temperament_notes, source)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (breed_name) DO UPDATE SET
           weight_range_kg       = EXCLUDED.weight_range_kg,
           common_conditions     = EXCLUDED.common_conditions,
           life_expectancy_years = EXCLUDED.life_expectancy_years,
           temperament_notes     = EXCLUDED.temperament_notes,
           source                = EXCLUDED.source
         RETURNING (xmax = 0) AS inserted`,
        [b.breed_name, b.weight_range_kg, b.common_conditions, b.life_expectancy_years, b.temperament_notes, b.source],
      );
      if (result.rows[0]?.inserted) inserted++; else updated++;
      console.log(`  ${result.rows[0]?.inserted ? '+ ' : '~ '} ${b.breed_name}`);
    }

    await client.query('COMMIT');
    console.log(`\nDone: ${inserted} inserted, ${updated} updated.\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seedBreeds();
