'use strict';

/**
 * llmProvider.js — single switch point for every LLM call in the app.
 *
 * Set LLM_PROVIDER=groq to use Groq's OpenAI-compatible API with open models;
 * leave it unset (or =anthropic) to use Claude. Embeddings + reranking are NOT
 * here — those always go to Voyage (see lib/rag.js), since Groq has no embeddings.
 *
 * Three primitives cover the whole app:
 *   generate()           — plain text answer            (chat answer, query rewrite)
 *   generateStructured() — forced single tool/function  (triage classifier)
 *   describeImage()      — vision caption               (figure ingestion)
 *
 * Each maps to the right shape per provider (Anthropic Messages API vs. OpenAI
 * chat/completions). Groq uses fetch (no extra dependency).
 */

const fs = require('fs');
const path = require('path');

const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// ── Model selection (override via env) ──────────────────────────────────────
const GROQ_BASE        = 'https://api.groq.com/openai/v1';
const GROQ_MODEL       = process.env.GROQ_MODEL        || 'llama-3.3-70b-versatile';     // main answers
const GROQ_FAST_MODEL  = process.env.GROQ_FAST_MODEL   || 'llama-3.1-8b-instant';        // triage + rewrite
const GROQ_VISION_MODEL= process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const ANTHROPIC_MODEL      = process.env.ANTHROPIC_MODEL      || 'claude-sonnet-4-6';
const ANTHROPIC_FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001';

// ── Lazy Anthropic client ────────────────────────────────────────────────────
let _anthropic = null;
function anthropicClient() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// True when the active provider has a usable API key.
function isConfigured() {
  return PROVIDER === 'groq'
    ? !!process.env.GROQ_API_KEY
    : !!process.env.ANTHROPIC_API_KEY;
}

// ── Groq (OpenAI-compatible) transport ───────────────────────────────────────
async function groqCompletion(body) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const resp = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Groq ${resp.status}: ${txt}`);
  }
  return resp.json();
}

function imageToDataParts(imagePath) {
  const raw = fs.readFileSync(imagePath);
  const b64 = raw.toString('base64');
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mediaType = ext === 'png' ? 'image/png'
    : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
    : 'image/png';
  return { b64, mediaType };
}

// ── Public: plain text generation ────────────────────────────────────────────
// opts: { system?, user, maxTokens?, fast? }
async function generate({ system, user, maxTokens = 1024, fast = false }) {
  if (PROVIDER === 'groq') {
    const data = await groqCompletion({
      model: fast ? GROQ_FAST_MODEL : GROQ_MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    });
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  const client = anthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not set');
  const msg = await client.messages.create({
    model: fast ? ANTHROPIC_FAST_MODEL : ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: user }],
  });
  return (msg.content[0]?.text || '').trim();
}

// ── Public: forced structured output via a single tool/function ──────────────
// tool: { name, description, parameters: <JSON Schema object> }
// Returns the parsed arguments object, or null if the model produced none.
async function generateStructured({ system, user, tool, maxTokens = 900, fast = true }) {
  if (PROVIDER === 'groq') {
    const data = await groqCompletion({
      model: fast ? GROQ_FAST_MODEL : GROQ_MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      tools: [{
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }],
      tool_choice: { type: 'function', function: { name: tool.name } },
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    if (call?.function?.arguments) {
      try { return JSON.parse(call.function.arguments); } catch { /* fall through */ }
    }
    // Fallback: some models return JSON in content instead of a tool call.
    const content = data.choices?.[0]?.message?.content;
    if (content) { try { return JSON.parse(content); } catch { /* ignore */ } }
    return null;
  }

  const client = anthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not set');
  const resp = await client.messages.create({
    model: fast ? ANTHROPIC_FAST_MODEL : ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }],
  });
  const block = resp.content.find(b => b.type === 'tool_use');
  return block ? block.input : null;
}

// ── Public: vision caption for one image ─────────────────────────────────────
async function describeImage({ imagePath, prompt, maxTokens = 300 }) {
  const { b64, mediaType } = imageToDataParts(imagePath);

  if (PROVIDER === 'groq') {
    const data = await groqCompletion({
      model: GROQ_VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
        ],
      }],
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  const client = anthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not set');
  const msg = await client.messages.create({
    model: ANTHROPIC_FAST_MODEL,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  return (msg.content[0]?.text || '').trim();
}

module.exports = {
  PROVIDER, isConfigured, generate, generateStructured, describeImage,
  GROQ_MODEL, GROQ_FAST_MODEL, GROQ_VISION_MODEL,
};
