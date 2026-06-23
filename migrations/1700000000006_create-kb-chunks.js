/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('kb_chunks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    source: { type: 'text', notNull: true }, // e.g. "WSAVA Global Guidelines", "Dr. X, BVSc"
    topic: { type: 'text' },
    content: { type: 'text', notNull: true },

    // ⚠️ PLACEHOLDER DIMENSION — NOT FINAL.
    // 1536 == OpenAI text-embedding-3-small / ada-002. No embedding model has been
    // chosen for Whoof yet. pgvector requires this column's dimension to EXACTLY match
    // the model's output size; changing it later means ALTER + a full re-embed of the
    // whole knowledge base. Finalize once the model is picked. See README "Design flags".
    embedding: { type: 'vector(1536)' },

    citation_url: { type: 'text' },
    license_note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Approximate-nearest-neighbour index for similarity search.
  //
  // NOTE: ivfflat builds its centroid lists from the rows that EXIST when the index is
  // created. On an empty table it is effectively untrained. After the first real bulk
  // load of kb_chunks you should:
  //     ANALYZE kb_chunks;
  // and ideally drop + recreate this index so `lists` matches the row count
  // (rule of thumb: lists ≈ rows / 1000, up to ~1M rows). `lists = 100` is a placeholder.
  //
  // Distance op: vector_cosine_ops (cosine distance) — the standard choice for text
  // embeddings. Your retrieval query must use the matching operator (<=> for cosine).
  // (See README "Design flags" for why HNSW may be the better index here.)
  pgm.sql(`
    CREATE INDEX kb_chunks_embedding_ivfflat_idx
      ON kb_chunks
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('kb_chunks'); // drops the index with it
};
