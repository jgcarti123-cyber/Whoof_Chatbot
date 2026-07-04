'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { pool } = require('./db');
const requireAuth = require('./middleware/requireAuth');

const app = express();

const isProd = process.env.NODE_ENV === 'production';

// The session secret signs the auth cookie. In production it MUST come from the
// environment — the dev fallback is public (it's right here in the source), so
// shipping with it would let anyone forge a logged-in cookie. Fail fast instead.
const sessionSecret = process.env.SESSION_SECRET
  || (isProd ? null : 'dev-secret-change-this-in-production');
if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production.');
}

// ─── View engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Safe way to embed a JS value inside an inline <script> block via <%- %>. Plain
// JSON.stringify() does NOT escape "</script>" — if the value is owner-controlled
// (pet name, saved vet name/clinic, etc.) a string containing that literal sequence
// closes the tag early and lets anything after it run as a new <script>. Escaping
// '<', '>', '&' (and the two line terminators some engines treat as string
// terminators) makes the output inert HTML-wise while staying valid JS/JSON.
app.locals.safeJson = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

// Behind an HTTPS proxy (Cloudflare tunnel, Render, etc.) trust X-Forwarded-Proto
// so `secure` cookies are actually sent and req.protocol reflects the real scheme.
if (isProd) app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
// A few baseline security headers with no dependency and no behavior change for this
// app (no iframing, no third-party embedding of Whoof pages is a real use case):
//   X-Content-Type-Options   — stop the browser guessing/executing a response as a
//                              different content type than what was served.
//   X-Frame-Options          — the login/admin pages can't be framed by another site
//                              (clickjacking on the credential forms).
//   Referrer-Policy          — don't leak the full URL (which can carry a memory_id,
//                              session id in a query string, etc.) to third-party links.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({
    pool,
    createTableIfMissing: true, // creates a `session` table in Postgres automatically
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'strict',
    secure: isProd, // HTTPS-only cookie once deployed behind TLS
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
    if (process.env.ENABLE_DEV_LOGIN === 'true') {
      console.log(`  Dev login (Bruno): http://localhost:${port}/dev-login`);
    }
    console.log(`  Login:   http://localhost:${port}/login`);
    console.log(`  Health:  http://localhost:${port}/health`);
    // Initial full export of all responses to whoof-responses.xlsx (fire-and-forget).
    require('./lib/exportExcel').writeExcel().catch(() => {});
  });
}

module.exports = app;
