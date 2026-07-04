'use strict';

const { Pool } = require('pg');

// One shared connection pool for the whole API process.
// Reads DATABASE_URL from the environment (see .env.example).
// Managed Postgres (Render, etc.) requires TLS but presents a self-signed chain,
// so the default `rejectUnauthorized: true` fails the handshake. Local/docker-compose
// Postgres has no TLS listener at all, so only turn this on in production.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // A pooled client errored while idle. Log it; don't take the process down.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
