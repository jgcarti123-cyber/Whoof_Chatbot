'use strict';

/**
 * webSearch.js — Tavily web search, used ONLY as a fallback when the KB has no
 * good match (see routes/chat.js). Scoped to dog/veterinary topics by biasing the
 * query; the broader pet-vs-not gate is the triage step, which runs first.
 *
 * Fail-soft: any error (no key, network, bad status) returns [] so the answer path
 * continues on the model's own knowledge — web search never blocks a reply.
 */

const TAVILY_URL = 'https://api.tavily.com/search';

function isConfigured() {
  return !!process.env.TAVILY_API_KEY;
}

// Returns up to `maxResults` normalized snippets: [{ title, url, content }].
async function searchWeb(queryText, maxResults = 5) {
  if (!process.env.TAVILY_API_KEY) return [];

  try {
    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        // Bias the index toward canine/veterinary pages without hard-filtering domains.
        query: `dog veterinary pet health: ${queryText}`,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
      }),
    });

    if (!resp.ok) {
      console.warn(`Tavily HTTP ${resp.status} — proceeding without web results.`);
      return [];
    }

    const data = await resp.json();
    return (data.results || [])
      .filter(r => r && r.content)
      .slice(0, maxResults)
      .map(r => ({
        title:   r.title || r.url || 'Web result',
        url:     r.url || '',
        content: String(r.content).slice(0, 1200), // cap per-snippet tokens
      }));
  } catch (err) {
    console.warn('Web search failed (proceeding without web results):', err.message);
    return [];
  }
}

module.exports = { searchWeb, isConfigured };
