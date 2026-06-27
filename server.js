'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { pool } = require('./db');
const requireAuth = require('./middleware/requireAuth');

const app = express();

// ─── View engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({
    pool,
    createTableIfMissing: true, // creates a `session` table in Postgres automatically
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'strict',
  },
}));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/profile'));
app.use('/', require('./routes/chat'));
app.use('/', require('./routes/admin'));

// Root: redirect based on whether the owner has a pet profile yet
app.get('/', requireAuth, async (req, res) => {
  try {
    const { query } = require('./db');
    const result = await query(
      'SELECT id FROM pet_profile WHERE owner_id = $1 LIMIT 1',
      [req.session.ownerId],
    );
    res.redirect(result.rows.length ? '/chat' : '/onboarding');
  } catch {
    res.redirect('/onboarding');
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok, now() AS db_time;');
    res.status(200).json({ status: 'ok', db: 'reachable', db_time: rows[0].db_time });
  } catch (err) {
    console.error('Health check DB query failed:', err.message);
    res.status(503).json({ status: 'error', db: 'unreachable', error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Whoof Vet AI listening on http://localhost:${port}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`  Dev login (Bruno): http://localhost:${port}/dev-login`);
    }
    console.log(`  Login:   http://localhost:${port}/login`);
    console.log(`  Health:  http://localhost:${port}/health`);
  });
}

module.exports = app;
