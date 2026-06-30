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
// When Tavily synthesizes a direct answer from the pages, it's prepended as the first
// entry (title "Web summary", no url) so the model sees the extracted fact — e.g. a
// phone number — stated plainly, not buried in (or cut from) a page teaser.
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
        // 'advanced' returns the full relevant content chunks (incl. contact details
        // like phone numbers) rather than the short teaser 'basic' gives.
        search_depth: 'advanced',
        max_results: maxResults,
        // Tavily's model extracts a direct answer from the retrieved pages.
        include_answer: true,
      }),
    });

    if (!resp.ok) {
      console.warn(`Tavily HTTP ${resp.status} — proceeding without web results.`);
      return [];
    }

    const data = await resp.json();
    const results = (data.results || [])
      .filter(r => r && r.content)
      .slice(0, maxResults)
      .map(r => ({
        title:   r.title || r.url || 'Web result',
        url:     r.url || '',
        content: String(r.content).slice(0, 1500), // cap per-snippet tokens
      }));

    const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
    if (answer) {
      results.unshift({ title: 'Web summary', url: '', content: answer });
    }
    return results;
  } catch (err) {
    console.warn('Web search failed (proceeding without web results):', err.message);
    return [];
  }
}

// General-purpose Tavily search (no veterinary query bias). Returns the synthesized
// answer plus normalized snippets: { answer, results:[{title,url,content}] }. Used by the
// community-picks feature, which needs raw place/forum content, not vet-scoped results.
// Fail-soft like searchWeb: any error returns { answer:'', results:[] }.
async function search({ query, maxResults = 6, includeAnswer = true, includeDomains = null }) {
  if (!process.env.TAVILY_API_KEY || !query) return { answer: '', results: [] };
  try {
    const body = {
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: 'advanced',
      max_results: maxResults,
      include_answer: includeAnswer,
    };
    if (Array.isArray(includeDomains) && includeDomains.length) body.include_domains = includeDomains;

    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn(`Tavily HTTP ${resp.status} — proceeding without web results.`);
      return { answer: '', results: [] };
    }
    const data = await resp.json();
    const results = (data.results || [])
      .filter(r => r && r.content)
      .slice(0, maxResults)
      .map(r => ({
        title:   r.title || r.url || 'Web result',
        url:     r.url || '',
        content: String(r.content).slice(0, 1500),
      }));
    const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
    return { answer, results };
  } catch (err) {
    console.warn('Web search failed (proceeding without web results):', err.message);
    return { answer: '', results: [] };
  }
}

module.exports = { searchWeb, search, isConfigured };
