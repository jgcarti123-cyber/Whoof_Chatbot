'use strict';

const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { makeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// The admin dashboard exposes every tester's conversations, so in production it must
// have an explicit secret — the dev fallback is public knowledge in this source file.
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_SECRET) {
  throw new Error('ADMIN_SECRET must be set when NODE_ENV=production to protect /admin.');
}
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'whoof-admin';
const ADMIN_SECRET_BUF = Buffer.from(ADMIN_SECRET);

// 8 attempts / 10 min / IP — this one password gates every tester's data, so brute force
// here is a bigger deal than a single owner's account.
const adminLoginLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 8 });

// Constant-time compare — a plain `===` short-circuits on the first mismatched byte,
// which leaks how many leading characters an attacker guessed correctly via response
// timing. crypto.timingSafeEqual needs equal-length buffers, so pad/compare a fixed
// length first and only timingSafeEqual once lengths already match.
function secretMatches(candidate) {
  const candidateBuf = Buffer.from(candidate);
  if (candidateBuf.length !== ADMIN_SECRET_BUF.length) return false;
  return crypto.timingSafeEqual(candidateBuf, ADMIN_SECRET_BUF);
}

// Middleware: require admin session flag
function requireAdmin(req, res, next) {
  if (req.session?.adminAuth) return next();
  res.redirect('/admin/login');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /admin/login
router.get('/admin/login', (req, res) => {
  if (req.session?.adminAuth) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

// POST /admin/login
router.post('/admin/login', adminLoginLimiter, (req, res) => {
  if (secretMatches((req.body.secret || '').trim())) {
    req.session.adminAuth = true;
    req.session.save(() => res.redirect('/admin'));
  } else {
    res.render('admin-login', { error: 'Wrong password.' });
  }
});

// POST /admin/logout
router.post('/admin/logout', (req, res) => {
  req.session.adminAuth = false;
  req.session.save(() => res.redirect('/admin/login'));
});

// POST /admin/users/:id/delete — permanently remove a user and everything that cascades
// from them (pet profile, chat sessions/turns, feedback, signup request). Irreversible —
// the confirm() prompt lives client-side in admin.ejs; this route trusts the admin session
// the same way every other /admin action does.
// 20 attempts / 10 min / IP — generous (this is a legitimate bulk-cleanup action an admin
// might do many of in a row), but still capped so a stolen admin session can't be used to
// script through every row in one shot without at least slowing down.
const deleteUserLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
router.post('/admin/users/:id/delete', requireAdmin, deleteUserLimiter, async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return res.redirect('/admin');
  try {
    await query('DELETE FROM owners WHERE id = $1', [id]);
  } catch (err) {
    console.error('Admin delete user error:', err);
  }
  res.redirect('/admin');
});

// GET /admin — main dashboard
router.get('/admin', requireAdmin, async (req, res) => {
  // Every real user (email + access code + onboarding state), for the unified
  // users/codes panel AND as the source of truth for who can be selected in the chat
  // viewer below — excludes the seeded demo/dev-login account, which isn't a real tester.
  const usersRes = await query(
    `SELECT
       o.id, o.email, o.owner_name, o.access_code, o.created_at,
       COALESCE(p.name, sr.dog_name) AS dog_name,
       (p.id IS NOT NULL) AS onboarded,
       sr.activated AS signup_activated
     FROM owners o
     LEFT JOIN pet_profile p ON p.owner_id = o.id
     LEFT JOIN signup_requests sr ON sr.owner_id = o.id
     WHERE o.email <> 'demo.owner@whoof.example'
     ORDER BY o.created_at DESC`,
  );
  const users = usersRes.rows;

  // Which user's chats are showing (default: most recently created). ?tester= must match
  // a real user's email or it's ignored — anything else falls back to the default so the
  // page never renders with an empty/undefined selection.
  const selected = users.some(u => u.email === req.query.tester)
    ? req.query.tester
    : (users[0]?.email || null);

  const rows = selected ? await query(
    `SELECT
       cm.id,
       cm.created_at,
       cm.owner_question,
       cm.answer_summary,
       cm.escalated,
       cm.confidence_level,
       p.name  AS pet_name,
       cs.title AS session_title,
       rf.rating,
       rf.tags,
       rf.comment AS fb_comment
     FROM conversation_memory cm
     JOIN pet_profile p          ON p.id  = cm.pet_id
     JOIN owners o               ON o.id  = p.owner_id
     LEFT JOIN conversation_session cs ON cs.id = cm.session_id
     LEFT JOIN response_feedback rf    ON rf.memory_id = cm.id
     WHERE o.email = $1
     ORDER BY cm.created_at DESC`,
    [selected],
  ) : { rows: [] };

  const turns = rows.rows;

  // Summary stats
  const rated   = turns.filter(t => t.rating != null);
  const avgRating = rated.length
    ? (rated.reduce((s, t) => s + t.rating, 0) / rated.length).toFixed(1)
    : null;
  const lowCount = rated.filter(t => t.rating <= 4).length;

  res.render('admin', {
    users, selected, turns, avgRating, lowCount, rated: rated.length,
  });
});

module.exports = router;
