'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { makeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// 10 attempts / 10 min / IP — bcrypt already makes each guess slow, this just caps the
// total guesses an automated attacker gets against any one owner's access code.
const loginLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

// Used to run bcrypt.compare on a real hash shape even when no owner matched, so the
// response time (and message) doesn't leak whether an email is a registered tester.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Vs0dVdWXO8vs7v1i8j9OaHXR8QQ5W';

router.get('/login', (req, res) => {
  if (req.session?.ownerId) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const code = (req.body.access_code || '').trim();

  if (!email || !code) {
    return res.render('login', { error: 'Please enter both your email and access code.' });
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
      return res.render('login', { error: 'Incorrect email or access code. Contact the Whoof team if you need one.' });
    }

    req.session.ownerId = owner.id;
    req.session.save(() => res.redirect('/'));
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: 'Something went wrong. Please try again.' });
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
