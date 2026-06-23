/* eslint-disable camelcase */

// Runs first. Everything else depends on these extensions existing.
exports.shorthands = undefined;

exports.up = (pgm) => {
  // pgvector: provides the `vector` type + ivfflat/hnsw index methods used by kb_chunks.
  pgm.createExtension('vector', { ifNotExists: true });

  // pgcrypto: guarantees gen_random_uuid() is available. It's in core on PG13+,
  // but enabling it explicitly is harmless insurance against an older image.
  pgm.createExtension('pgcrypto', { ifNotExists: true });
};

exports.down = (pgm) => {
  // Intentionally NOT dropping `vector` on rollback: it would fail while any table
  // still uses the type, and dropping a shared extension is rarely what you want.
  // Uncomment if you truly need a clean teardown after dropping the tables.
  // pgm.dropExtension('pgcrypto', { ifExists: true });
  // pgm.dropExtension('vector', { ifExists: true });
};
