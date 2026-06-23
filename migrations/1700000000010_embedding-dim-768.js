/* eslint-disable camelcase */

// Switches embeddings from Voyage voyage-3 (1024-dim) to the local open-source
// model Xenova/bge-base-en-v1.5 (768-dim). The embedding vector space changes
// entirely, so all existing vectors are invalid — the table is cleared and
// re-ingested with the new model (see scripts/ingest-all-pdfs.sh).
//
// pgvector cannot cast 1024-dim → 768-dim in place, so we drop the ivfflat
// index, clear rows, alter the column, and rebuild the index.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS kb_chunks_embedding_ivfflat_idx;');
  pgm.sql('DELETE FROM kb_chunks;'); // re-ingested fresh with the 768-dim model
  pgm.sql('ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(768);');
  pgm.sql(`
    CREATE INDEX kb_chunks_embedding_ivfflat_idx
      ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS kb_chunks_embedding_ivfflat_idx;');
  pgm.sql('DELETE FROM kb_chunks;');
  pgm.sql('ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(1024);');
  pgm.sql(`
    CREATE INDEX kb_chunks_embedding_ivfflat_idx
      ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);
};
