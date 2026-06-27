'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'whoof-admin';

// Middleware: require admin session flag
function requireAdmin(req, res, next) {
  if (req.session?.adminAuth) return next();
  res.redirect('/admin/login');
}

// GET /admin/login
router.get('/admin/login', (req, res) => {
  if (req.session?.adminAuth) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

// POST /admin/login
router.post('/admin/login', (req, res) => {
  if ((req.body.secret || '').trim() === ADMIN_SECRET) {
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

// GET /admin — main dashboard
router.get('/admin', requireAdmin, async (req, res) => {
  // All real testers (exclude seeded demo/example accounts)
  const testers = [
    'rushiljohn10@gmail.com',
    'tester123@gmail.com',
  ];

  // Filter: which tester is selected (default first)
  const selected = testers.includes(req.query.tester) ? req.query.tester : testers[0];

  const rows = await query(
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
  );

  const turns = rows.rows;

  // Summary stats
  const rated   = turns.filter(t => t.rating != null);
  const avgRating = rated.length
    ? (rated.reduce((s, t) => s + t.rating, 0) / rated.length).toFixed(1)
    : null;
  const lowCount = rated.filter(t => t.rating <= 4).length;

  res.render('admin', { testers, selected, turns, avgRating, lowCount, rated: rated.length });
});

module.exports = router;
