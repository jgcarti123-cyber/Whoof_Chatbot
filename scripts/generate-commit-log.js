'use strict';

/**
 * generate-commit-log.js — writes (or overwrites) whoof-commit-log.xlsx in the project
 * root: one row per git commit (date, time, hash, subject, description, author, files/
 * insertions/deletions), newest first.
 *
 * Run manually with `node scripts/generate-commit-log.js`, or automatically after every
 * commit via the .git/hooks/post-commit hook (installed by scripts/install-git-hooks.sh) —
 * so the sheet stays in sync with the repo without anyone remembering to update it by hand.
 */

const path = require('path');
const { execSync } = require('child_process');
const XLSX = require('xlsx');

const REPO_ROOT = path.join(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'whoof-commit-log.xlsx');

const HEADERS = ['Date', 'Time', 'Commit', 'Subject', 'Description', 'Author', 'Files Changed', 'Insertions', 'Deletions'];

// \x1f (unit separator) / \x1e (record separator) are control chars that will never appear
// in a commit message, so they're safe, unambiguous field/record delimiters.
const FORMAT = '@@%H\x1f%an\x1f%ai\x1f%s\x1f%b\x1e';

function parseShortstat(line) {
  const out = { files: 0, insertions: 0, deletions: 0 };
  if (!line) return out;
  const f = line.match(/(\d+) files? changed/);
  const i = line.match(/(\d+) insertions?\(\+\)/);
  const d = line.match(/(\d+) deletions?\(-\)/);
  if (f) out.files = parseInt(f[1], 10);
  if (i) out.insertions = parseInt(i[1], 10);
  if (d) out.deletions = parseInt(d[1], 10);
  return out;
}

function fetchCommits() {
  const raw = execSync(`git log --pretty=format:'${FORMAT}' --shortstat`, {
    cwd: REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  }).toString('utf8');

  return raw.split('@@').filter(Boolean).map((chunk) => {
    const [hash, author, authorDate, subject, rest] = chunk.split('\x1f');
    const [bodyRaw, statLine] = (rest || '').split('\x1e');
    const body = (bodyRaw || '')
      .split('\n')
      .filter(l => !/^Co-Authored-By:/i.test(l.trim())) // strip the AI co-author trailer — noise for a changelog
      .join('\n')
      .trim();
    const stat = parseShortstat(statLine);
    const dt = new Date(authorDate);
    return {
      date: isNaN(dt) ? '' : dt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
      time: isNaN(dt) ? '' : dt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      hash: (hash || '').slice(0, 7),
      subject: (subject || '').trim(),
      description: body,
      author: (author || '').trim(),
      files: stat.files,
      insertions: stat.insertions,
      deletions: stat.deletions,
    };
  });
}

function rowToArray(c) {
  return [c.date, c.time, c.hash, c.subject, c.description, c.author, c.files, c.insertions, c.deletions];
}

function writeCommitLog() {
  try {
    const commits = fetchCommits(); // git log is newest-first already
    const wsData = [HEADERS, ...commits.map(rowToArray)];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    ws['!cols'] = [
      { wch: 12 }, // Date
      { wch: 10 }, // Time
      { wch: 10 }, // Commit
      { wch: 45 }, // Subject
      { wch: 80 }, // Description
      { wch: 18 }, // Author
      { wch: 12 }, // Files Changed
      { wch: 11 }, // Insertions
      { wch: 11 }, // Deletions
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Commits');
    XLSX.writeFile(wb, OUTPUT_PATH);
    console.log(`[commit-log] exported ${commits.length} commits → whoof-commit-log.xlsx`);
  } catch (err) {
    console.warn('[commit-log] export failed:', err.message);
  }
}

if (require.main === module) writeCommitLog();

module.exports = { writeCommitLog };
