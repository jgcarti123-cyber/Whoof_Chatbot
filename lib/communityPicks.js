'use strict';

/**
 * communityPicks.js — layers community sentiment (what dog owners actually recommend) on
 * top of the Google Places results from lib/vetFinder.js. Anchored on real places so every
 * suggestion keeps an address + map pin; the community pass only RE-RANKS and ANNOTATES
 * them with a short "why pet owners like it" reason, and surfaces a few extra spots locals
 * love that weren't in the nearby list.
 *
 * Source design is pluggable (the "both, phased" plan): today only a Tavily web-search
 * source, which covers Reddit threads, blogs and local pet forums in one ToS-safe call.
 * A Reddit official-API source can be added to SOURCES later without touching callers.
 *
 * Fail-soft + timeout everywhere: any error or a slow source returns the places unchanged,
 * so the Find feature never breaks because the community layer was unavailable.
 */

const webSearch = require('./webSearch');
const provider = require('./llmProvider');
const { searchPlaceByText } = require('./vetFinder');

// Per-area cache: the Tavily + LLM pass (and, for parks/cafes, the Places lookups that
// resolve each recommended name to a real address + coordinates) runs once per
// (category, area) and is reused for a week. In-memory (cleared on restart) — fine for an
// enhancement; swap for a DB table if it needs to survive restarts.
const CACHE = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TIMEOUT_MS = 12000;

// Parks & cafes show ONLY community-recommended spots, each resolved to a real place so we
// can show its address + distance. Cap the Places lookups per area (cost) and drop results
// that resolve too far away (likely a wrong-city match).
const COMMUNITY_ONLY_CATS = new Set(['park', 'cafe']);
const MAX_RESOLVE = 10;
const MAX_KM = 30;

// Great-circle distance in km between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function fmtDistance(km) {
  if (km == null) return null;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}
const mapsSearchUrl = (name, loc) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${loc}`)}`;

const CATEGORY_QUERY = {
  vet:  (loc) => `best veterinary clinics in ${loc} that dog owners trust and recommend — most reviewed, good with pets (reddit, local reviews, pet forums)`,
  park: (loc) => `best dog-friendly parks in ${loc} with a good dog community and off-leash space, recommended by dog owners (reddit, local pet groups)`,
  cafe: (loc) => `most genuinely dog-friendly cafes and restaurants in ${loc} that welcome pets, recommended by pet owners (reddit, local reviews)`,
};
const CATEGORY_NOUN = { vet: 'veterinary clinics', park: 'dog parks / parks', cafe: 'dog-friendly cafes and restaurants' };

// ── Fuzzy name matching (community mention ↔ Google place) ───────────────────
const NAME_STOP = new Set([
  'the', 'pet', 'pets', 'clinic', 'vet', 'vets', 'veterinary', 'hospital', 'care', 'centre',
  'center', 'animal', 'animals', 'park', 'garden', 'gardens', 'cafe', 'cafe', 'restaurant',
  'coffee', 'and', 'of', 'dr', 'in', 'at',
]);
const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sigTokens = (s) => normName(s).split(' ').filter(t => t.length >= 3 && !NAME_STOP.has(t));
function nameMatches(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const sa = sigTokens(a), sb = sigTokens(b);
  if (!sa.length || !sb.length) return false;
  if (sa[0] === sb[0]) return true;               // same distinctive brand word
  return sa.filter(t => sb.includes(t)).length >= 2; // or two significant tokens in common
}

// ── LLM extraction: named venues + a short reason, from the search corpus ─────
const MENTIONS_TOOL = {
  name: 'list_recommended_places',
  description: 'List specific named places the community recommends for dogs/pets, each with a short reason.',
  parameters: {
    type: 'object',
    properties: {
      places: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The exact venue name as written (e.g. "Maxpetz", "Cubbon Park", "Roastery Coffee").' },
            reason: { type: 'string', description: 'Why pet owners like it, taken from the text, max ~12 words. Never invent a reason.' },
          },
          required: ['name', 'reason'],
        },
      },
    },
    required: ['places'],
  },
};

async function extractMentions({ category, locationLabel, answer, results }) {
  if (!provider.isConfigured()) return [];
  const corpus = [answer, ...results.map(r => `${r.title}\n${r.content}`)].filter(Boolean).join('\n\n').slice(0, 6000);
  if (!corpus.trim()) return [];
  try {
    const out = await provider.generateStructured({
      system:
        `You read web, Reddit and local-forum excerpts about ${CATEGORY_NOUN[category] || 'places'} in ${locationLabel}. ` +
        `List ONLY specific, named venues that are recommended as good for dogs/pets, each with a short reason taken from the text. ` +
        `Do not invent venues or reasons. Skip generic advice and anything not clearly named. If none are clearly named, return an empty list.`,
      user: corpus,
      tool: MENTIONS_TOOL,
      fast: true,
      maxTokens: 500,
    });
    const arr = out && Array.isArray(out.places) ? out.places : [];
    return arr
      .map(p => ({ name: String(p.name || '').trim().slice(0, 120), reason: String(p.reason || '').trim().slice(0, 140) }))
      .filter(p => p.name);
  } catch (err) {
    console.warn('Community mention extraction failed:', err.message);
    return [];
  }
}

// ── Sources (pluggable) ──────────────────────────────────────────────────────
// Each source resolves to { mentions:[{name,reason}], summary }. Add a reddit-API source
// here in phase 2; gatherCommunity merges them by name.
async function tavilySource({ category, locationLabel }) {
  if (!webSearch.isConfigured()) return { mentions: [], summary: '' };
  const query = (CATEGORY_QUERY[category] || CATEGORY_QUERY.vet)(locationLabel);
  const { answer, results } = await webSearch.search({ query, maxResults: 6, includeAnswer: true });
  const mentions = await extractMentions({ category, locationLabel, answer, results });
  return { mentions, summary: answer };
}

const SOURCES = [tavilySource];

// Resolve community mention names to real places (address + coordinates) so parks/cafes can
// show location + distance. A mention that matches an already-fetched nearby place reuses
// that (no API call); the rest go through a Places text search. Runs in parallel, capped at
// MAX_RESOLVE, and the result is cached (see gatherCommunity) so this is a one-time cost per
// area. Distance is NOT computed here — it's per-user, so attachCommunity adds it live.
async function resolveMentions({ mentions, nearbyPlaces, locationLabel }) {
  const limited = mentions.slice(0, MAX_RESOLVE);
  const resolved = await Promise.all(limited.map(async (m) => {
    let place = (nearbyPlaces || []).find(p => nameMatches(m.name, p.name));
    if (!place) {
      try { place = await searchPlaceByText(`${m.name} ${locationLabel}`); }
      catch { place = null; }
    }
    if (!place || place.lat == null || place.lng == null) return null;
    return {
      name: place.name || m.name,
      address: place.address || '',
      lat: place.lat, lng: place.lng,
      rating: place.rating || null,
      reviews: place.reviews || 0,
      open: place.open ?? null,
      phone: place.phone || null,
      mapsUrl: place.mapsUrl,
      community: { favourite: true, reason: m.reason },
    };
  }));
  // Drop unresolved + de-dupe by place identity.
  const seen = new Set();
  const out = [];
  for (const r of resolved) {
    if (!r) continue;
    const k = r.mapsUrl || normName(r.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

async function gatherCommunity({ category, locationLabel, nearbyPlaces }) {
  const cacheKey = `${category}::${normName(locationLabel)}`;
  const hit = CACHE.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.data;

  const merged = new Map(); // normName → { name, reason }
  let summary = '';
  for (const source of SOURCES) {
    try {
      const { mentions, summary: s } = await source({ category, locationLabel });
      if (s && !summary) summary = s;
      for (const m of mentions) {
        const k = normName(m.name);
        if (k && !merged.has(k)) merged.set(k, m);
      }
    } catch (err) {
      console.warn('Community source failed:', err.message);
    }
  }
  const mentions = [...merged.values()];

  // For parks/cafes, resolve every recommended name to a real place now (cached), so the
  // list has addresses + coordinates. Vets don't need this (they show nearby places).
  const resolvedPlaces = COMMUNITY_ONLY_CATS.has(category)
    ? await resolveMentions({ mentions, nearbyPlaces, locationLabel })
    : [];

  const data = { mentions, summary, resolvedPlaces };
  CACHE.set(cacheKey, { ts: Date.now(), data });
  return data;
}

// Derive a human area label ("Wakad, Pimpri-Chinchwad") from the Places addresses, so the
// search is about a real suburb/city rather than raw coordinates. Drops the street line,
// pincodes, the country, and street-like fragments (so a query isn't sent for "Park
// Street"); weights earlier segments (closer to the venue's suburb) more heavily.
const STREETY = /\b(road|rd|street|st|marg|lane|ln|highway|hwy|brts|cross|main|sector|phase|floor|bldg|building|survey|plot|near|opp|opposite|behind|shop|no)\b|\d/i;
function deriveLocality(places) {
  const counts = new Map();
  for (const p of places) {
    const parts = (p.address || '').split(',').map(s => s.trim()).filter(Boolean);
    const middle = parts.slice(1, Math.max(1, parts.length - 2)); // drop street + state/pin + country
    middle.forEach((part, idx) => {
      if (!part || part.length < 3 || /^india$/i.test(part) || STREETY.test(part)) return;
      counts.set(part, (counts.get(part) || 0) + (middle.length - idx));
    });
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 2).join(', ');
}

// ── Public: enrich + re-rank Google places with community sentiment ──────────
// Returns { places, summary, extras, recommended }; on any failure/timeout, places is the
// input list unchanged so the caller can carry on with plain Google results.
//   places      — nearby Google places, community favourites floated up (used for VETS).
//   extras      — community names not in the nearby list (VETS "also loved" footnote).
//   recommended — real, resolved, distance-sorted community picks (used for PARKS/CAFES).
// userLat/userLng (the searcher's coordinates) drive the distance shown + the sort.
async function attachCommunity({ places, category, userLat = null, userLng = null }) {
  const out = { places, summary: '', extras: [], recommended: [] };
  if (!Array.isArray(places) || !places.length || !webSearch.isConfigured()) return out;

  const locationLabel = deriveLocality(places) || 'this area';
  try {
    const community = await Promise.race([
      gatherCommunity({ category, locationLabel, nearbyPlaces: places }),
      new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    if (!community || !community.mentions.length) {
      out.summary = community ? community.summary : '';
      return out;
    }

    const used = new Set();
    const enriched = places.map((p) => {
      const hit = community.mentions.find(m => nameMatches(m.name, p.name));
      if (hit) { used.add(normName(hit.name)); return { ...p, community: { favourite: true, reason: hit.reason } }; }
      return p;
    });
    // Community favourites first; stable within each group (keeps the rating order).
    enriched.sort((a, b) => (b.community ? 1 : 0) - (a.community ? 1 : 0));

    // Community-loved names that weren't in the nearby list → light, clickable extras
    // (a Maps search link, so no extra Places API calls needed). Used by VETS only.
    const extras = community.mentions
      .filter(m => !used.has(normName(m.name)))
      .slice(0, 4)
      .map(m => ({ name: m.name, reason: m.reason, searchUrl: mapsSearchUrl(m.name, locationLabel) }));

    // PARKS/CAFES: the resolved real places, each with a live distance from the searcher,
    // dropping anything implausibly far (wrong-city resolve) and sorted nearest-first.
    const recommended = (community.resolvedPlaces || [])
      .map((p) => {
        const distanceKm = (userLat != null && userLng != null && p.lat != null && p.lng != null)
          ? haversineKm(userLat, userLng, p.lat, p.lng) : null;
        return { ...p, distanceKm, distanceLabel: fmtDistance(distanceKm) };
      })
      .filter(p => p.distanceKm == null || p.distanceKm <= MAX_KM)
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));

    out.places = enriched;
    out.summary = community.summary;
    out.extras = extras;
    out.recommended = recommended;
    return out;
  } catch (err) {
    console.warn('attachCommunity failed (returning plain places):', err.message);
    return out;
  }
}

module.exports = { attachCommunity, deriveLocality, nameMatches };
