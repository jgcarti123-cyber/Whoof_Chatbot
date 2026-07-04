'use strict';

// One-off: gives every owner that has NO stored plaintext access_code a fresh one
// (owners created before the access_code column existed only have the bcrypt hash,
// which can't be read back — a fresh code is generated and both the hash and the
// plaintext are updated). Run once after the access_code migration:
//   node scripts/backfill-access-codes.js
//
// Safe to re-run: it only touches owners where access_code IS NULL, so anyone already
// backfilled (or created via seed-owners.js / self-serve signup, which both already set
// access_code) is left untouched.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0, I/l/1
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function backfill() {
  const client = await pool.connect();
  console.log('\n=== Prim Pets — Backfilling access codes ===\n');
  try {
    const { rows } = await client.query(
      'SELECT id, email FROM owners WHERE access_code IS NULL ORDER BY created_at',
    );
    if (!rows.length) {
      console.log('Nothing to backfill — every owner already has a stored code.\n');
      return;
    }

    await client.query('BEGIN');
    const results = [];
    for (const owner of rows) {
      const code = generateCode();
      const hash = await bcrypt.hash(code, 10);
      await client.query(
        'UPDATE owners SET access_code_hash = $2, access_code = $3 WHERE id = $1',
        [owner.id, hash, code],
      );
      results.push({ email: owner.email, code });
    }
    await client.query('COMMIT');

    console.log('This REPLACES their previous access code — share the new one, the old one no longer works:\n');
    const maxLen = Math.max(...results.map(r => r.email.length));
    results.forEach(({ email, code }) => {
      console.log(`  ${email.padEnd(maxLen)}   code: ${code}`);
    });
    console.log('');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

backfill();
