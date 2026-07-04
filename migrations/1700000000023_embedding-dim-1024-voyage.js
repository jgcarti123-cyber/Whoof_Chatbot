/* eslint-disable camelcase */

// Switches embeddings back from the local open-source model Xenova/bge-base-en-v1.5
// (768-dim) to Voyage AI voyage-3 (1024-dim) — the reverse of migration 010.
//
// Why: the local model runs in-process (Transformers.js/ONNX), which needs the full
// model resident in memory. On Render's free web-service tier (512MB RAM cap), loading
// it alongside Node/Express/the Postgres pool pushed the process over the limit and got
// it OOM-killed mid-request. Voyage embeddings are a small HTTP call instead — no model
// held in memory — trading a per-call API dependency (free tier: 3 RPM/10K TPM) for a
// dramatically smaller runtime footprint.
//
// The embedding vector space changes entirely, so all existing vectors are invalid —
// the table is cleared and must be re-ingested with EMBEDDING_PROVIDER=voyage (see
// scripts/ingest-all-pdfs.sh). Same pgvector limitation as migration 010: it can't cast
// 768-dim → 1024-dim in place, so drop the ivfflat index, clear rows, alter the column,
// rebuild the index.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS kb_chunks_embedding_ivfflat_idx;');
  pgm.sql('DELETE FROM kb_chunks;'); // re-ingested fresh with voyage-3
  pgm.sql('ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(1024);');
  pgm.sql(`
    CREATE INDEX kb_chunks_embedding_ivfflat_idx
      ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS kb_chunks_embedding_ivfflat_idx;');
  pgm.sql('DELETE FROM kb_chunks;');
  pgm.sql('ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(768);');
  pgm.sql(`
    CREATE INDEX kb_chunks_embedding_ivfflat_idx
      ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);
};
