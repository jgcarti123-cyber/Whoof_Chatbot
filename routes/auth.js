'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { makeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// 10 attempts / 10 min / IP — bcrypt already makes each guess slow, this just caps the
// total guesses an automated attacker gets against any one owner's access code.
const loginLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

// 5 signups / 15 min / IP — each signup creates an owner row, so cap it tighter than
// login to keep the table from being flooded by an automated client.
const signupLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

// Used to run bcrypt.compare on a real hash shape even when no owner matched, so the
// response time (and message) doesn't leak whether an email is a registered tester.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Vs0dVdWXO8vs7v1i8j9OaHXR8QQ5W';

// Access code shared with the user out-of-band: 6 chars, no ambiguous ones (O/0, I/l/1).
// crypto.randomInt (not Math.random) so codes aren't predictable from timing/PRNG state.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateAccessCode() {
  return Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
}

// Single place that renders the login page, so every path passes the full variable set the
// template expects (mode, error/success banners, and any form values to repopulate).
function renderLogin(res, opts = {}) {
  res.render('login', {
    error: null,
    mode: 'login',
    signupError: null,
    signupSuccess: null,
    values: {},
    ...opts,
  });
}

router.get('/login', (req, res) => {
  if (req.session?.ownerId) return res.redirect('/');
  renderLogin(res);
});

// Direct link to the signup form (the login page also toggles to it client-side).
router.get('/signup', (req, res) => {
  if (req.session?.ownerId) return res.redirect('/');
  renderLogin(res, { mode: 'signup' });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const code = (req.body.access_code || '').trim();

  if (!email || !code) {
    return renderLogin(res, { error: 'Please enter both your email and access code.', values: { email } });
  }

  try {
    const result = await query(
      'SELECT id, access_code_hash FROM owners WHERE email = $1',
      [email],
    );
    const owner = result.rows[0];

    // Same message and (via the dummy-hash compare) roughly the same response time
    // whether the email doesn't exist, has no code set, or the code is wrong — none of
    // that should be distinguishable to someone probing for valid tester emails.
    const valid = await bcrypt.compare(code, owner?.access_code_hash || DUMMY_HASH);
    if (!owner || !owner.access_code_hash || !valid) {
      return renderLogin(res, { error: 'Incorrect email or access code. Contact the Prim Pets team if you need one.', values: { email } });
    }

    req.session.ownerId = owner.id;
    // Best-effort: mark this owner's signup request as activated (if they came via the
    // self-serve flow) so the admin can see who's used their code. Never blocks login.
    query('UPDATE signup_requests SET activated = true WHERE owner_id = $1 AND activated = false', [owner.id]).catch(() => {});
    req.session.save(() => res.redirect('/'));
  } catch (err) {
    console.error('Login error:', err);
    renderLogin(res, { error: 'Something went wrong. Please try again.', values: { email } });
  }
});

// Self-serve access request. Creates the owner + a generated access code (hash stored for
// login), and a signup_requests row holding the plaintext code so the admin dashboard can
// show it and the admin can relay it. The user can't log in until they're told the code.
router.post('/signup', signupLimiter, async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const name = (req.body.name || '').trim().slice(0, 80);
  const dogName = (req.body.dog_name || '').trim().slice(0, 60);
  const values = { email, name, dog_name: dogName };

  if (!email || !name || !dogName) {
    return renderLogin(res, { mode: 'signup', signupError: "Please fill in your email, your name, and your dog's name.", values });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderLogin(res, { mode: 'signup', signupError: 'Please enter a valid email address.', values });
  }

  try {
    // Don't overwrite an existing account's code — that would silently change (or reset)
    // a real tester's login. Existing email → tell them to contact John instead.
    const existing = await query('SELECT id FROM owners WHERE email = $1', [email]);
    if (existing.rows.length) {
      return renderLogin(res, { mode: 'signup', signupError: "That email is already registered. If you've lost your access code, contact John.", values });
    }

    const code = generateAccessCode();
    const hash = await bcrypt.hash(code, 10);
    // access_code (plaintext) lives on owners too, not just signup_requests, so the
    // admin's unified user/code list works the same for self-serve and seeded owners.
    const ownerRes = await query(
      'INSERT INTO owners (email, access_code_hash, access_code, owner_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, hash, code, name],
    );
    await query(
      'INSERT INTO signup_requests (owner_id, name, dog_name, access_code) VALUES ($1, $2, $3, $4)',
      [ownerRes.rows[0].id, name, dogName, code],
    );

    return renderLogin(res, {
      mode: 'login',
      signupSuccess: `Thanks, ${name}! Your request is in. John will send your access code shortly — once you have it, log in above with this email.`,
      values: { email },
    });
  } catch (err) {
    // Unique-violation on owners.email = a race between two concurrent signups; treat it
    // the same as the "already registered" branch above rather than a generic error.
    if (err.code === '23505') {
      return renderLogin(res, { mode: 'signup', signupError: "That email is already registered. If you've lost your access code, contact John.", values });
    }
    console.error('Signup error:', err);
    return renderLogin(res, { mode: 'signup', signupError: 'Something went wrong. Please try again.', values });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Dev-only shortcut — skips email/code, logs straight in as the demo owner (Bruno).
// OFF by default (incl. on any public tunnel): an attacker who finds the URL could
// otherwise reach the demo account with no credentials. Opt in with ENABLE_DEV_LOGIN=true
// in a trusted local .env only.
if (process.env.ENABLE_DEV_LOGIN === 'true') {
  router.get('/dev-login', async (req, res) => {
    try {
      const result = await query(
        "SELECT id FROM owners WHERE email = 'demo.owner@whoof.example' LIMIT 1",
      );
      const owner = result.rows[0];
      if (!owner) {
        return res.status(404).send('Demo owner not found — run: node seed.js');
      }
      req.session.ownerId = owner.id;
      req.session.save(() => res.redirect('/'));
    } catch (err) {
      console.error('dev-login error:', err);
      res.status(500).send('Dev login failed: ' + err.message);
    }
  });
}

module.exports = router;
