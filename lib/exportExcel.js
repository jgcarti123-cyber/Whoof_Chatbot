'use strict';

/**
 * exportExcel.js — writes (or overwrites) whoof-responses.xlsx in the project root.
 *
 * Called once at server startup (full export of all history) and then after every
 * chat turn that belongs to rushiljohn10@gmail.com, so the sheet stays live.
 *
 * Columns:
 *   Date/Time | Owner | Email | Pet | Session | Question | Answer |
 *   Confidence | Escalated | Rating | Tags | Comment
 */

const path = require('path');
const XLSX = require('xlsx');
const { query } = require('../db');

const OUTPUT_PATH = path.join(__dirname, '..', 'whoof-responses.xlsx');

const TRACKED_EMAIL = 'rushiljohn10@gmail.com';

const HEADERS = [
  'Date/Time', 'Owner Name', 'Email', 'Pet Name', 'Session Title',
  'Question', 'Answer', 'Confidence', 'Escalated',
  'Rating (1–10)', 'Rating Tags', 'Rating Comment',
];

async function fetchAllRows() {
  const res = await query(`
    SELECT
      cm.created_at,
      o.owner_name,
      o.email,
      p.name        AS pet_name,
      cs.title      AS session_title,
      cm.owner_question,
      cm.answer_summary,
      cm.confidence_level,
      cm.escalated,
      rf.rating,
      rf.tags,
      rf.comment
    FROM conversation_memory cm
    JOIN pet_profile            p  ON p.id  = cm.pet_id
    JOIN owners                 o  ON o.id  = p.owner_id
    LEFT JOIN conversation_session cs ON cs.id = cm.session_id
    LEFT JOIN response_feedback rf ON rf.memory_id = cm.id
    ORDER BY cm.created_at ASC
  `);
  return res.rows;
}

function rowToArray(r) {
  const d = r.created_at ? new Date(r.created_at) : null;
  const dateStr = d
    ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
    : '';
  return [
    dateStr,
    r.owner_name  || '',
    r.email       || '',
    r.pet_name    || '',
    r.session_title || '',
    r.owner_question || '',
    r.answer_summary || '',
    r.confidence_level || '',
    r.escalated ? 'Yes' : 'No',
    r.rating != null ? r.rating : '',
    Array.isArray(r.tags) ? r.tags.join(', ') : (r.tags || ''),
    r.comment || '',
  ];
}

async function writeExcel() {
  try {
    const rows = await fetchAllRows();

    const wsData = [HEADERS, ...rows.map(rowToArray)];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [
      { wch: 20 }, // Date/Time
      { wch: 18 }, // Owner Name
      { wch: 28 }, // Email
      { wch: 14 }, // Pet Name
      { wch: 22 }, // Session Title
      { wch: 50 }, // Question
      { wch: 70 }, // Answer
      { wch: 12 }, // Confidence
      { wch: 10 }, // Escalated
      { wch: 12 }, // Rating
      { wch: 28 }, // Tags
      { wch: 40 }, // Comment
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Responses');
    XLSX.writeFile(wb, OUTPUT_PATH);
    console.log(`[excel] exported ${rows.length} rows → whoof-responses.xlsx`);
  } catch (err) {
    console.warn('[excel] export failed:', err.message);
  }
}

// Called after a chat turn. Checks if the owner is the tracked email before doing the
// (slightly expensive) full re-export — so it's a no-op for all other users.
async function maybeUpdate(ownerId) {
  try {
    const res = await query('SELECT email FROM owners WHERE id = $1 LIMIT 1', [ownerId]);
    if (res.rows[0]?.email === TRACKED_EMAIL) await writeExcel();
  } catch {
    // never block the chat response
  }
}

module.exports = { writeExcel, maybeUpdate };
