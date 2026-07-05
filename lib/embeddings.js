'use strict';

/**
 * embeddings.js — single source of embeddings for BOTH ingestion and retrieval.
 *
 * Default provider is 'local': an open-source sentence-embedding model run
 * in-process via Transformers.js (ONNX runtime). No API key, no rate limits,
 * no Python. The model downloads once (cached on disk) on first use.
 *
 * Set EMBEDDING_PROVIDER=voyage to use Voyage AI instead (needs VOYAGE_API_KEY).
 *
 * IMPORTANT: ingestion and retrieval MUST use the same model, or the query and
 * document vectors live in different spaces and retrieval breaks. Both paths go
 * through embedDocuments()/embedQuery() here, so they stay in lockstep.
 *
 * BGE/mxbai-style models want an instruction prefix on the QUERY only (not on
 * stored documents) — handled in embedQuery().
 */

const PROVIDER     = (process.env.EMBEDDING_PROVIDER || 'local').toLowerCase();
// bge-base-en-v1.5 = 768-dim; reliable + light (~440MB). bge-large (1024) is
// higher quality but ~1.3GB and can OOM on small machines — override via env
// (and run migration to match the dimension) if you want it.
const LOCAL_MODEL  = process.env.EMBEDDING_MODEL || 'Xenova/bge-base-en-v1.5';
const QUERY_PREFIX = process.env.EMBEDDING_QUERY_PREFIX
  || 'Represent this sentence for searching relevant passages: ';
const VOYAGE_MODEL = 'voyage-3';

// ── Local model (Transformers.js) — lazy singleton ──────────────────────────
let _pipePromise = null;
function getPipe() {
  if (_pipePromise) return _pipePromise;
  _pipePromise = (async () => {
    // Dynamic import: @xenova/transformers is ESM.
    const { pipeline, env } = await import('@xenova/transformers');
    // Allow remote model download (default), cache under node_modules/.cache.
    env.allowLocalModels = false;
    return pipeline('feature-extraction', LOCAL_MODEL);
  })();
  return _pipePromise;
}

// Embed an array of texts locally. Returns array of float[] (mean-pooled, L2-normalized).
async function embedLocalBatch(texts) {
  const pipe = await getPipe();
  const tensor = await pipe(texts, { pooling: 'mean', normalize: true });
  // Tensor shape [n, dim] → nested arrays.
  return tensor.tolist();
}

// ── Voyage (fallback provider) ───────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Voyage accounts with no payment method on file are capped at 3 requests/minute
// (the free 200M-token allowance still applies — only the request RATE is capped).
// A KB ingest fires many embedding calls back-to-back and trips this immediately.
// Voyage's 429 body has no "retry after" hint (unlike Groq's), so back off a fixed
// ~21s — just over the 20s/request budget that 3 RPM implies — a bit longer each
// retry, instead of parsing a suggested wait time out of the error.
async function embedVoyageBatch(texts, attempt = 1) {
  if (!process.env.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY not set');
  const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL }),
  });
  if (resp.status === 429 && attempt <= 6) {
    await sleep(21000 + (attempt - 1) * 5000);
    return embedVoyageBatch(texts, attempt + 1);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Voyage AI ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

// ── Public API ───────────────────────────────────────────────────────────────

// Embed stored documents/chunks (no query instruction prefix).
async function embedDocuments(texts) {
  return PROVIDER === 'voyage' ? embedVoyageBatch(texts) : embedLocalBatch(texts);
}

// Embed a single search query (adds the instruction prefix for local BGE-style models).
async function embedQuery(text) {
  if (PROVIDER === 'voyage') return (await embedVoyageBatch([text]))[0];
  const [vec] = await embedLocalBatch([QUERY_PREFIX + text]);
  return vec;
}

// Returns the embedding dimension of the active provider (loads the model if local).
async function getDimension() {
  if (PROVIDER === 'voyage') return 1024; // voyage-3
  const [vec] = await embedLocalBatch(['dimension probe']);
  return vec.length;
}

module.exports = { PROVIDER, LOCAL_MODEL, embedDocuments, embedQuery, getDimension };
