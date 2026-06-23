/* eslint-disable camelcase */

// Extends kb_chunks with structural metadata from PDF parsing, adds FTS support,
// creates the breed_reference table for direct breed-specific context injection.
//
// New kb_chunks columns:
//   source_title   — "WSAVA Global Dental Guidelines (2020)"
//   section        — Section heading from the source doc
//   subsection     — Sub-heading
//   sub_subsection — Third-level heading
//   page_number    — Source page
//   chunk_type     — body | key_points | table | figure  (default: body)
//   citations      — inline citations stripped from embedded content, kept for audit
//   confidence_tier— high | medium | low  (default: high for peer-reviewed sources)
//
// All new kb_chunks columns are nullable / have defaults so the existing
// plain-text ingest path (ingest-kb.js) continues to work without changes.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── 1. Extend kb_chunks ────────────────────────────────────────────────────
  pgm.addColumn('kb_chunks', {
    source_title:    { type: 'text' },
    section:         { type: 'text' },
    subsection:      { type: 'text' },
    sub_subsection:  { type: 'text' },
    page_number:     { type: 'int' },
    chunk_type: {
      type: 'text',
      default: "'body'",
      check: "chunk_type IN ('body','key_points','table','figure')",
    },
    citations:       { type: 'text' },
    confidence_tier: {
      type: 'text',
      default: "'high'",
      check: "confidence_tier IN ('high','medium','low')",
    },
  });

  // ── 2. Full-text search — generated tsvector column + GIN index ───────────
  // Includes content, topic, section, and subsection so FTS matches both
  // guideline text and structural labels (e.g. "periodontal disease").
  pgm.sql(`
    ALTER TABLE kb_chunks
      ADD COLUMN fts_vector tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(content,      '') || ' ' ||
          coalesce(topic,        '') || ' ' ||
          coalesce(section,      '') || ' ' ||
          coalesce(subsection,   '')
        )
      ) STORED;
  `);

  pgm.createIndex('kb_chunks', 'fts_vector', {
    name:   'kb_chunks_fts_idx',
    method: 'gin',
  });

  // ── 3. breed_reference — direct lookup, not routed through vector search ──
  pgm.createTable('breed_reference', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    breed_name: { type: 'text', notNull: true, unique: true },
    weight_range_kg: { type: 'text' },
    common_conditions: { type: 'text[]' },
    life_expectancy_years: { type: 'text' },
    temperament_notes: { type: 'text' },
    source: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('breed_reference');
  pgm.sql('DROP INDEX IF EXISTS kb_chunks_fts_idx;');
  pgm.sql('ALTER TABLE kb_chunks DROP COLUMN IF EXISTS fts_vector;');
  pgm.dropColumn('kb_chunks', [
    'source_title','section','subsection','sub_subsection',
    'page_number','chunk_type','citations','confidence_tier',
  ]);
};
