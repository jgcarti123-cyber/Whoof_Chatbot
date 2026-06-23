'use strict';

const { Pool } = require('pg');

// One shared connection pool for the whole API process.
// Reads DATABASE_URL from the environment (see .env.example).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // A pooled client errored while idle. Log it; don't take the process down.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
