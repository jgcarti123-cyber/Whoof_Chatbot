'use strict';

/**
 * RAG retrieval layer.
 *
 * Retrieval pipeline (per chat message):
 *   1. rewriteQueryClinical()  — haiku restates owner language in clinical terms
 *   2. hybridSearch()          — RRF of pgvector cosine + Postgres FTS (tsvector)
 *   3. rerankWithVoyage()      — optional, behind ENABLE_RERANK env var
 *
 * Breed lookup is a separate direct-query path (not vector search).
 *
 * Graceful degradation:
 *   - No VOYAGE_API_KEY → vector leg skipped, FTS-only
 *   - No ANTHROPIC_API_KEY → query rewriting skipped, raw owner question used
 *   - fts_vector column missing (migration 009 not yet applied) → vector-only fallback
 *   - ENABLE_RERANK not set → reranking skipped
 */

const { query } = require('../db');
const provider = require('./llmProvider');
const embeddings = require('./embeddings');

// ── Query embedding (shared module: local model or Voyage) ──────────────────────

async function embedText(text) {
  return embeddings.embedQuery(text);
}

// ── Query rewriting ────────────────────────────────────────────────────────────

// Rewrites an owner's colloquial question into clinical veterinary terms so the
// embedding query better matches the language of clinical guideline documents.
// Example: "his breath stinks and he won't eat" → "halitosis and anorexia in dogs"
async function rewriteQueryClinical(question) {
  if (!provider.isConfigured()) return question; // no key → use original
  try {
    const rewritten = await provider.generate({
      user: `Rewrite the following dog owner's question into 1–2 clinical veterinary search terms. Output ONLY the rewritten query, no explanation, no punctuation at the end.\n\nOwner question: "${question}"`,
      maxTokens: 80,
      fast: true,
    });
    // If the model returned something obviously wrong (too long, a refusal), fall back
    if (!rewritten || rewritten.length > 120 || /^(I |Sure|Of course)/i.test(rewritten)) return question;
    return rewritten;
  } catch {
    return question; // network error / rate-limit → silent fallback
  }
}

// ── Hybrid search (pgvector + FTS with RRF) ────────────────────────────────────

// Retrieves top-k chunks by Reciprocal Rank Fusion of:
//   - pgvector cosine similarity (embedding <=> query_vector)
//   - Postgres full-text search (fts_vector @@ plainto_tsquery)
//
// RRF constant k=60 is the standard value from Cormack et al. (2009).
// candidatePool = topK * 6 so each leg returns a broad set before merging.
async function hybridSearch(queryText, queryEmbedding, topK = 5) {
  const vecStr = JSON.stringify(queryEmbedding);
  const candidatePool = topK * 6;

  const sql = `
    WITH pool AS (SELECT $2::int AS n, $3::int AS k),
    vector_ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM   kb_chunks
      WHERE  embedding IS NOT NULL
      ORDER  BY embedding <=> $1::vector
      LIMIT  (SELECT n FROM pool)
    ),
    fts_ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               ORDER BY ts_rank_cd(fts_vector, plainto_tsquery('english', $4)) DESC
             ) AS rank
      FROM   kb_chunks
      WHERE  fts_vector @@ plainto_tsquery('english', $4)
      ORDER  BY ts_rank_cd(fts_vector, plainto_tsquery('english', $4)) DESC
      LIMIT  (SELECT n FROM pool)
    ),
    rrf AS (
      SELECT
        COALESCE(v.id, f.id)                            AS id,
        COALESCE(1.0 / (60.0 + v.rank), 0.0) +
        COALESCE(1.0 / (60.0 + f.rank), 0.0)           AS rrf_score
      FROM vector_ranked v
      FULL OUTER JOIN fts_ranked f ON v.id = f.id
    )
    SELECT k.id, k.source, k.topic, k.content, k.citation_url,
           k.source_title, k.section, k.subsection, k.sub_subsection,
           k.page_number, k.chunk_type, k.confidence_tier,
           r.rrf_score
    FROM   rrf r
    JOIN   kb_chunks k ON k.id = r.id
    ORDER  BY r.rrf_score DESC
    LIMIT  (SELECT k FROM pool)
  `;

  try {
    const result = await query(sql, [vecStr, candidatePool, topK, queryText]);
    return result.rows;
  } catch (err) {
    // fts_vector column likely missing (migration 009 not yet run) — fall back to vector-only
    if (err.message.includes('fts_vector') || err.message.includes('column')) {
      console.warn('hybridSearch: falling back to vector-only (run migration 009 for full FTS support)');
      const fallback = await query(
        `SELECT id, source, topic, content, citation_url,
                (1 - (embedding <=> $1::vector)) AS rrf_score
         FROM kb_chunks WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector LIMIT $2`,
        [vecStr, topK],
      );
      return fallback.rows;
    }
    throw err;
  }
}

// ── Voyage reranking ───────────────────────────────────────────────────────────

// Reranks a candidate set using Voyage AI's cross-encoder reranker.
// Enabled only when ENABLE_RERANK=true (it's a per-message API cost, not one-time).
async function rerankWithVoyage(queryText, chunks, topK) {
  if (!chunks.length) return chunks;
  const resp = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      query: queryText,
      documents: chunks.map(c => {
        const prefix = c.section ? `${c.section}: ` : '';
        return prefix + c.content;
      }),
      model: 'rerank-2',
      top_k: topK,
    }),
  });
  if (!resp.ok) throw new Error(`Voyage rerank ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.data.map(r => ({ ...chunks[r.index], rerank_score: r.relevance_score }));
}

// ── Main retrieval entrypoint ─────────────────────────────────────────────────

// Orchestrates: rewrite → embed → hybrid search → optional rerank.
// Returns { chunks, rewritten_query } so the caller can log what was searched.
async function retrieveChunks(questionText, topK = 5) {
  // 1. Query rewriting (falls back silently if no API key)
  const clinicalQuery = await rewriteQueryClinical(questionText);

  // 2. Embed the (possibly rewritten) query
  const embedding = await embedText(clinicalQuery);

  // 3. Hybrid search
  const candidateCount = process.env.ENABLE_RERANK === 'true' ? topK * 4 : topK;
  let chunks = await hybridSearch(clinicalQuery, embedding, candidateCount);

  // 4. Reranking (opt-in, behind env var to control cost)
  if (process.env.ENABLE_RERANK === 'true' && chunks.length > topK) {
    try {
      chunks = await rerankWithVoyage(questionText, chunks, topK);
    } catch (rerankErr) {
      console.warn('Rerank failed, using hybrid-search order:', rerankErr.message);
      chunks = chunks.slice(0, topK);
    }
  }

  return { embedding, chunks: chunks.slice(0, topK), rewritten_query: clinicalQuery };
}

// ── Breed lookup ───────────────────────────────────────────────────────────────

// Looks up a pet's breed in breed_reference using:
//   1. Exact case-insensitive match
//   2. Fuzzy substring match (handles "Lab" → "Labrador Retriever", "indie" → "Indian Pariah Dog")
//   3. Fallback to "Mixed breed / unknown"
// This is a direct SQL lookup, NOT routed through vector search.
async function lookupBreed(breedName) {
  if (!breedName) return null;
  const clean = breedName.trim();

  // Exact (case-insensitive)
  let res = await query(
    'SELECT * FROM breed_reference WHERE breed_name ILIKE $1 LIMIT 1',
    [clean],
  );
  if (res.rows.length) return res.rows[0];

  // Substring: query contains breed_name OR breed_name contains query
  // Longer breed_name preferred over shorter (avoids "Pug" matching "Pug Dog Encephalitis")
  res = await query(`
    SELECT * FROM breed_reference
    WHERE  $1 ILIKE '%' || breed_name || '%'
       OR  breed_name ILIKE '%' || $1 || '%'
    ORDER  BY length(breed_name) DESC
    LIMIT  1
  `, [clean]);
  if (res.rows.length) return res.rows[0];

  // Fallback
  res = await query(
    "SELECT * FROM breed_reference WHERE breed_name = 'Mixed breed / unknown' LIMIT 1",
  );
  return res.rows[0] || null;
}

module.exports = { embedText, retrieveChunks, lookupBreed };
