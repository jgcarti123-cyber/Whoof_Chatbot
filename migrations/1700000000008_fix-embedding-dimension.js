/* eslint-disable camelcase */

// Changes kb_chunks.embedding from vector(1536) to vector(1024).
//
// The original dimension (1536) was a placeholder matching OpenAI ada-002.
// The chosen embedding model is Voyage AI voyage-3, which outputs 1024 dimensions.
// pgvector requires the column dimension to EXACTLY match the model output, so this
// migration runs before any embeddings are inserted.
//
// Safe to run on an empty table (migrations run before ingest-kb.js).
// If you later re-embed with a different model, add another migration to change the dim.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Must drop the ivfflat index before altering the vector column type.
  pgm.sql('DROP INDEX IF EXISTS kb_chunks_embedding_ivfflat_idx;');
  pgm.sql('ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(1024);');

  // Recreate the ivfflat index for the new dimension.
  // Reminder: run ANALYZE kb_chunks after the first real bulk load.
  pgm.sql(`
    CREATE INDEX kb_chunks_embedding_ivfflat_idx
      ON kb_chunks
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS kb_chunks_embedding_ivfflat_idx;');
  pgm.sql('ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE vector(1536);');
  pgm.sql(`
    CREATE INDEX kb_chunks_embedding_ivfflat_idx
      ON kb_chunks
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  `);
};
