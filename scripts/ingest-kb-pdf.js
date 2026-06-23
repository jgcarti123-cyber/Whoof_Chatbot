'use strict';

/**
 * ingest-kb-pdf.js — PDF knowledge base ingestion pipeline.
 *
 * Flow:
 *   1. Hash PDF → skip if unchanged (idempotent)
 *   2. Run scripts/parse_pdf.py → structured JSON with chunks + image paths
 *   3. For each figure chunk: call Claude haiku vision to describe the image
 *   4. Embed all chunks with Voyage AI voyage-3 (batched, heading path prepended)
 *   5. Delete existing kb_chunks rows for this source_title
 *   6. Insert all chunks with full structural metadata
 *   7. Save file hash, print ingest report
 *
 * Usage:
 *   node scripts/ingest-kb-pdf.js <pdf_path> [--force] [--no-vision] [--dry-run]
 *
 * Flags:
 *   --force      Re-ingest even if PDF hash hasn't changed
 *   --no-vision  Skip Claude vision calls (use caption text only for figures)
 *   --dry-run    Parse + report without writing to DB
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execSync, spawnSync } = require('child_process');
const provider = require('../lib/llmProvider');
const embeddings = require('../lib/embeddings');
const { pool }  = require('../db');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const pdfPath  = args.find(a => !a.startsWith('--'));
const FORCE    = args.includes('--force');
const NO_VISION= args.includes('--no-vision');
const DRY_RUN  = args.includes('--dry-run');

// --title "Custom Citation Title" overrides the auto-derived source_title.
function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
const TITLE_OVERRIDE = flagValue('--title');

if (!pdfPath) {
  console.error('Usage: node scripts/ingest-kb-pdf.js <pdf_path> [--force] [--no-vision] [--dry-run] [--title "Citation Title"]');
  process.exit(1);
}

const HASH_FILE    = path.join(__dirname, '.pdf-hashes.json');
const EMBED_BATCH  = 16;         // chunks embedded per call (local model, CPU)

const VISION_PROMPT = 'This image is from a veterinary clinical guideline document. In 2-3 specific sentences, describe what is clinically depicted: the anatomical structure, pathology, procedure, or finding shown, and its diagnostic significance. Be precise and clinical. If the image is too low-resolution or non-clinical (e.g. a logo or diagram only), say so.';

// ── Hash tracking ─────────────────────────────────────────────────────────────
function loadHashes() {
  try { return JSON.parse(fs.readFileSync(HASH_FILE, 'utf8')); }
  catch { return {}; }
}
function saveHash(filePath, hash) {
  const hashes = loadHashes();
  hashes[path.resolve(filePath)] = hash;
  fs.writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2));
}
function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Python parser ─────────────────────────────────────────────────────────────
function findPython() {
  for (const cmd of ['python3', 'python']) {
    try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return cmd; }
    catch { continue; }
  }
  throw new Error('Python 3 not found on PATH');
}

function ensurePythonDeps(pythonCmd) {
  const check = spawnSync(pythonCmd, ['-c', 'import fitz, pdfplumber'], { encoding: 'utf8' });
  if (check.status !== 0) {
    console.log('Installing Python dependencies (PyMuPDF, pdfplumber)...');
    const install = spawnSync(
      pythonCmd, ['-m', 'pip', 'install', '--quiet', '--user', 'PyMuPDF', 'pdfplumber'],
      { stdio: 'inherit' },
    );
    if (install.status !== 0) throw new Error('pip install failed — run manually: pip3 install PyMuPDF pdfplumber');
  }
}

async function runPythonParser(pdfAbsPath, pythonCmd) {
  const tmpOutput = path.join('/tmp', `whoof_parse_${Date.now()}.json`);
  const parseScript = path.join(__dirname, 'parse_pdf.py');

  console.log('Running PDF parser...');
  const parseArgs = [parseScript, pdfAbsPath, '--output', tmpOutput];
  if (TITLE_OVERRIDE) parseArgs.push('--title', TITLE_OVERRIDE);
  const result = spawnSync(
    pythonCmd,
    parseArgs,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Python parser exited with code ${result.status}`);
  }

  const parsed = JSON.parse(fs.readFileSync(tmpOutput, 'utf8'));
  fs.unlinkSync(tmpOutput);
  return parsed;
}

// ── Vision (provider-aware: Groq vision model or Claude) ────────────────────────
async function describeImage(imagePath) {
  return provider.describeImage({ imagePath, prompt: VISION_PROMPT, maxTokens: 300 });
}

// ── Embedding (shared module: local open-source model or Voyage) ───────────────
async function embedBatch(texts) {
  return embeddings.embedDocuments(texts);
}

function prepareForEmbedding(chunk) {
  const path = chunk.heading_path || '';
  const prefix = path ? `${path}: ` : '';
  return prefix + chunk.content;
}

// ── DB insert ──────────────────────────────────────────────────────────────────
async function insertChunk(client, chunk, embedding, sourceTitle) {
  const vecStr = JSON.stringify(embedding);
  await client.query(
    `INSERT INTO kb_chunks (
       source_title, source, topic,
       section, subsection, sub_subsection,
       page_number, chunk_type, content, citations,
       embedding, confidence_tier, license_note
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12,$13)`,
    [
      sourceTitle,
      chunk.section || sourceTitle,
      chunk.sub_subsection || chunk.subsection || chunk.section || null,
      chunk.section        || null,
      chunk.subsection     || null,
      chunk.sub_subsection || null,
      chunk.page_number    || null,
      chunk.chunk_type     || 'body',
      chunk.content,
      chunk.citations      || null,
      vecStr,
      'high',
      'WSAVA / peer-reviewed guideline — review before production use',
    ],
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const absPath = path.resolve(pdfPath);
  if (!fs.existsSync(absPath)) {
    console.error(`ERROR: File not found: ${absPath}`);
    process.exit(1);
  }

  // Idempotency check
  const hash = fileHash(absPath);
  const hashes = loadHashes();
  if (!FORCE && hashes[absPath] === hash) {
    console.log(`\n✓ ${path.basename(absPath)}: unchanged (hash matches). Use --force to re-ingest.\n`);
    return;
  }

  // Python
  const pythonCmd = findPython();
  ensurePythonDeps(pythonCmd);

  // Parse
  const parsed = await runPythonParser(absPath, pythonCmd);
  const sourceTitle = parsed.source_title;
  const chunks = parsed.chunks;

  console.log(`\nSource: "${sourceTitle}"  (${parsed.page_count} pages, ${chunks.length} chunks)\n`);

  // Vision descriptions for figures
  const figureChunks = chunks.filter(c => c.chunk_type === 'figure' && c.image_path);
  console.log(`Figure chunks with images: ${figureChunks.length}`);

  if (!NO_VISION && figureChunks.length > 0) {
    if (!provider.isConfigured()) {
      console.warn(`  ${provider.PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'} not set — skipping vision descriptions (use --no-vision to suppress this warning).`);
    } else {
      console.log(`  Generating vision descriptions via ${provider.PROVIDER} (${provider.PROVIDER === 'groq' ? provider.GROQ_VISION_MODEL : 'claude'})...`);
      let visionOk = 0, visionFail = 0;
      for (const chunk of figureChunks) {
        try {
          const description = await describeImage(chunk.image_path);
          const isLowConf = /low.resolution|logo|diagram only|cannot describe/i.test(description);
          chunk.content += `\n\nVisual description: ${description}`;
          if (isLowConf) {
            console.log(`    ⚠ Flagged for review: ${chunk.figure_id} (p${chunk.page_number}) — ${description.slice(0, 80)}…`);
          }
          visionOk++;
        } catch (err) {
          console.warn(`    ✗ Vision failed for ${chunk.figure_id} (p${chunk.page_number}): ${err.message}`);
          visionFail++;
        }
      }
      console.log(`  Vision complete: ${visionOk} ok, ${visionFail} failed`);
    }
  } else if (NO_VISION) {
    console.log('  --no-vision: skipping Claude vision calls, using captions only.');
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing to DB.\n');
    printReport(chunks, sourceTitle);
    return;
  }

  if (embeddings.PROVIDER === 'voyage' && !process.env.VOYAGE_API_KEY) {
    console.error('ERROR: EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is not set — cannot embed chunks.');
    process.exit(1);
  }

  // Embed all chunks in batches
  console.log(`\nEmbedding ${chunks.length} chunks via ${embeddings.PROVIDER} (${embeddings.LOCAL_MODEL})...`);
  const texts = chunks.map(prepareForEmbedding);
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const vecs = await embedBatch(batch);
    vectors.push(...vecs);
    process.stdout.write(`\r  ${Math.min(i + EMBED_BATCH, texts.length)} / ${texts.length}`);
  }
  console.log('\r  Done.                          ');

  // Write to DB
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete existing rows for this source to make re-ingestion clean
    const deleted = await client.query(
      'DELETE FROM kb_chunks WHERE source_title = $1',
      [sourceTitle],
    );
    if (deleted.rowCount > 0) {
      console.log(`  Removed ${deleted.rowCount} existing chunks for "${sourceTitle}"`);
    }

    for (let i = 0; i < chunks.length; i++) {
      await insertChunk(client, chunks[i], vectors[i], sourceTitle);
    }

    await client.query('COMMIT');
    console.log(`  Inserted ${chunks.length} chunks.`);

    // Run ANALYZE so the ivfflat index is fresh
    await pool.query('ANALYZE kb_chunks;');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  // Save hash
  saveHash(absPath, hash);

  printReport(chunks, sourceTitle);
}

function printReport(chunks, sourceTitle) {
  const byType = {};
  for (const c of chunks) {
    byType[c.chunk_type] = (byType[c.chunk_type] || 0) + 1;
  }

  console.log('\n══════════════════════════════════════');
  console.log(' Ingest report');
  console.log('══════════════════════════════════════');
  console.log(` Source: ${sourceTitle}`);
  console.log(` Total chunks: ${chunks.length}`);
  for (const [t, n] of Object.entries(byType).sort()) {
    console.log(`   ${t.padEnd(12)}: ${n}`);
  }
  const withImages = chunks.filter(c => c.image_path).length;
  if (withImages) console.log(`   figures with images: ${withImages}`);
  const avgLen = Math.round(chunks.reduce((s, c) => s + c.content.length, 0) / chunks.length);
  console.log(` Avg chunk length: ${avgLen} chars`);

  // Phase-2 note as requested
  console.log(`\n── Phase-2 idea (not built): image-embedding / visual-diagnosis ──`);
  console.log(`   Building a retrieval path where owners upload a photo of their dog's`);
  console.log(`   gums/skin and get matched against reference images would require`);
  console.log(`   multimodal embeddings (e.g. CLIP), a separate image-vector column,`);
  console.log(`   and careful liability review before surfacing in the chat UI.`);
  console.log(`   Flag this as a phase-2 feature — not built here.\n`);
}

main().catch(err => {
  console.error('\nIngest failed:', err.message);
  process.exitCode = 1;
});
