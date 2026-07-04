'use strict';

// Creates 3-4 test owner accounts with random access codes and stores bcrypt hashes.
// Run this after migrations:
//   node scripts/seed-owners.js
//
// BEFORE RUNNING: replace the OWNERS array below with the real tester email addresses.
// The plain codes printed to stdout are the ones you share (e.g. via WhatsApp).
// Codes are persistent — the same code works every login until you regenerate.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

// ─── Edit these before running ────────────────────────────────────────────────
const OWNERS = [
  { email: 'rushiljohn10@gmail.com' },
  { email: 'tester123@gmail.com' },
];
// ─────────────────────────────────────────────────────────────────────────────

function generateCode() {
  // 6 characters; no ambiguous chars (O/0, I/l/1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function seedOwners() {
  const client = await pool.connect();
  console.log('\n=== Whoof Vet AI — Test Owner Setup ===\n');

  try {
    await client.query('BEGIN');

    const results = [];

    for (const owner of OWNERS) {
      const code = generateCode();
      const hash = await bcrypt.hash(code, 10);

      // Upsert: if the owner already exists, update the hash (regenerates their code).
      await client.query(
        `INSERT INTO owners (email, access_code_hash)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET access_code_hash = EXCLUDED.access_code_hash`,
        [owner.email.toLowerCase().trim(), hash],
      );

      results.push({ email: owner.email, code });
    }

    await client.query('COMMIT');

    console.log('Created/updated accounts. Share each code only with the intended tester:\n');
    const maxLen = Math.max(...results.map(r => r.email.length));
    results.forEach(({ email, code }) => {
      console.log(`  ${email.padEnd(maxLen)}   code: ${code}`);
    });
    console.log('\nCodes are persistent — same code works each login.');
    console.log('Re-run this script at any time to regenerate codes.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seedOwners();
