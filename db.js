'use strict';

const { Pool } = require('pg');

// One shared connection pool for the whole API process.
// Reads DATABASE_URL from the environment (see .env.example).
// Managed Postgres (Render, etc.) requires TLS but presents a self-signed chain, so the
// default `rejectUnauthorized: true` fails the handshake. Local/docker-compose Postgres
// has no TLS listener at all and rejects an SSL negotiation outright ("SSL/TLS required"
// is actually Postgres saying the opposite — the server demands TLS and the client
// didn't offer it). Deciding this from NODE_ENV breaks one-off scripts (seed-owners.js,
// ingest-all-pdfs.sh) run locally with DATABASE_URL pointed at a remote database — those
// never set NODE_ENV=production. Deciding from the connection target itself works for
// both the running app and any local script: local/docker-compose Postgres is always
// localhost/127.0.0.1, anything else (Render, etc.) needs TLS.
const isLocalDb = /^(localhost|127\.0\.0\.1)$/.test(
  new URL(process.env.DATABASE_URL || 'postgres://localhost').hostname,
);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // A pooled client errored while idle. Log it; don't take the process down.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
