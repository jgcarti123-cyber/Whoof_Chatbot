'use strict';

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// Finds veterinary clinics near a lat/lng using Google Places Nearby Search.
// Returns an array of vet objects sorted by rating (highest first).
async function findNearbyVets(lat, lng, radiusMeters = 5000) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set in .env');

  const url = `${PLACES_BASE}/nearbysearch/json?` +
    `location=${lat},${lng}` +
    `&radius=${radiusMeters}` +
    `&type=veterinary_care` +
    `&key=${key}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Places API HTTP ${resp.status}`);

  const data = await resp.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error: ${data.status} — ${data.error_message || ''}`);
  }

  return (data.results || [])
    .slice(0, 6)
    .map(p => ({
      name:    p.name,
      address: p.vicinity || '',
      rating:  p.rating   || null,
      reviews: p.user_ratings_total || 0,
      open:    p.opening_hours?.open_now ?? null,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + (p.vicinity || ''))}&query_place_id=${p.place_id}`,
    }))
    .sort((a, b) => (b.rating || 0) - (a.rating || 0));
}

module.exports = { findNearbyVets };
