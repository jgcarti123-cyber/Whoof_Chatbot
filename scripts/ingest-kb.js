'use strict';

// Reads .md / .txt files from kb-source/, chunks them, embeds with Voyage AI,
// and upserts into kb_chunks.
//
// Usage:
//   node scripts/ingest-kb.js               — ingest all files in kb-source/
//   node scripts/ingest-kb.js vaccinations  — ingest a single file by name prefix
//
// The script is idempotent: it DELETEs existing rows with the same source before
// re-inserting, so re-running after editing a source file gives you a clean slate.
//
// Requires:  VOYAGE_API_KEY in .env
// Model:     voyage-3 (1024-dim output — matches the current kb_chunks.embedding column)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
if (!VOYAGE_API_KEY) {
  console.error('ERROR: VOYAGE_API_KEY is not set in .env');
  process.exit(1);
}

const KB_DIR = path.join(__dirname, '..', 'kb-source');
const VOYAGE_MODEL = 'voyage-3';
const BATCH_SIZE = 50; // embed this many chunks per API call
const TARGET_CHUNK_CHARS = 800;
const MIN_CHUNK_CHARS = 100;

// ─── Chunking ──────────────────────────────────────────────────────────────

function chunkMarkdown(text) {
  // 1. Strip front matter
  const body = text.replace(/^---[\s\S]*?---\n/, '').trim();

  // 2. Split at double newlines (paragraph/section boundaries)
  const rawParas = body.split(/\n{2,}/);

  // 3. Merge short paragraphs; split long ones
  const chunks = [];
  let current = '';

  for (const para of rawParas) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length < TARGET_CHUNK_CHARS) {
      current = current ? current + '\n\n' + trimmed : trimmed;
    } else {
      if (current.length >= MIN_CHUNK_CHARS) chunks.push(current);
      current = trimmed;
    }
  }
  if (current.length >= MIN_CHUNK_CHARS) chunks.push(current);

  return chunks;
}

function extractTopic(text, filename) {
  // Use first H1/H2 heading, or fall back to the filename
  const h = text.match(/^#{1,2}\s+(.+)/m);
  return h ? h[1].trim() : filename.replace(/-/g, ' ').replace(/\.\w+$/, '');
}

function extractSource(text, filename) {
  // Look for a "Source:" line, otherwise use filename
  const s = text.match(/^source:\s*(.+)/im);
  return s ? s[1].trim() : filename.replace(/-/g, ' ').replace(/\.\w+$/, '');
}

function extractCitationUrl(text) {
  const u = text.match(/^citation_url:\s*(.+)/im);
  return u ? u[1].trim() : null;
}

function extractLicenseNote(text) {
  const l = text.match(/^license:\s*(.+)/im);
  return l ? l[1].trim() : 'Placeholder — replace with real source before production use';
}

// ─── Embedding ─────────────────────────────────────────────────────────────

async function embedBatch(texts) {
  const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Voyage AI ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  return data.data.map(d => d.embedding); // float[][] shape [texts.length][1024]
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function ingestFile(client, filePath) {
  const filename = path.basename(filePath);
  const rawText = fs.readFileSync(filePath, 'utf8');

  const source = extractSource(rawText, filename);
  const topic = extractTopic(rawText, filename);
  const citationUrl = extractCitationUrl(rawText);
  const licenseNote = extractLicenseNote(rawText);
  const chunks = chunkMarkdown(rawText);

  console.log(`  ${filename}  →  ${chunks.length} chunks  (source: "${source}")`);

  if (!chunks.length) {
    console.log('    (no chunks — skipping)');
    return 0;
  }

  // Delete existing rows for this source so re-runs are clean
  await client.query('DELETE FROM kb_chunks WHERE source = $1', [source]);

  // Embed in batches
  const allEmbeddings = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(batch);
    allEmbeddings.push(...embeddings);
  }

  // Insert
  for (let i = 0; i < chunks.length; i++) {
    const vecStr = JSON.stringify(allEmbeddings[i]);
    await client.query(
      `INSERT INTO kb_chunks (source, topic, content, embedding, citation_url, license_note)
       VALUES ($1, $2, $3, $4::vector, $5, $6)`,
      [source, topic, chunks[i], vecStr, citationUrl, licenseNote],
    );
  }

  return chunks.length;
}

async function main() {
  const filter = process.argv[2]; // optional filename prefix filter

  if (!fs.existsSync(KB_DIR)) {
    console.error(`ERROR: kb-source/ directory not found at ${KB_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(KB_DIR)
    .filter(f => /\.(md|txt)$/.test(f))
    .filter(f => !filter || f.startsWith(filter))
    .map(f => path.join(KB_DIR, f));

  if (!files.length) {
    console.log('No matching files found in kb-source/');
    return;
  }

  console.log(`\nWhoof KB Ingest — model: ${VOYAGE_MODEL}\n`);

  const client = await pool.connect();
  let total = 0;

  try {
    for (const file of files) {
      total += await ingestFile(client, file);
    }
    console.log(`\nDone. ${total} chunks inserted/updated across ${files.length} file(s).`);
    console.log('Run ANALYZE kb_chunks; in psql if this is your first bulk load.\n');
  } catch (err) {
    console.error('\nIngest error:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
