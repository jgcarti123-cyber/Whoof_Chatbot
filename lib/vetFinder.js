'use strict';

// Uses the Places API (New) — POST-based, header-authenticated.
// https://developers.google.com/maps/documentation/places/web-service/nearby-search
async function findNearbyVets(lat, lng, radiusMeters = 5000) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set in .env');

  const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.rating',
        'places.userRatingCount',
        'places.currentOpeningHours.openNow',
      ].join(','),
    },
    body: JSON.stringify({
      includedTypes: ['veterinary_care'],
      maxResultCount: 6,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusMeters,
        },
      },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Places API HTTP ${resp.status}: ${txt}`);
  }

  const data = await resp.json();

  return (data.places || [])
    .map(p => ({
      name:    p.displayName?.text || 'Unknown clinic',
      address: p.formattedAddress  || '',
      rating:  p.rating            || null,
      reviews: p.userRatingCount   || 0,
      open:    p.currentOpeningHours?.openNow ?? null,
      mapsUrl: `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    }))
    .sort((a, b) => (b.rating || 0) - (a.rating || 0));
}

module.exports = { findNearbyVets };
