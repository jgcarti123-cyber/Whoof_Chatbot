'use strict';

// Nearby place search via the Google Places API (New) — POST-based, header-authenticated.
// https://developers.google.com/maps/documentation/places/web-service/nearby-search
//
// Categories the owner can search for around them (all dog-relevant):
//   vet  → veterinary clinics
//   park → dog parks and parks (somewhere to walk/run the dog)
//   cafe → cafés & restaurants (often pet-friendly; the API can't filter on that, so the
//          UI frames these as "worth checking" rather than guaranteed pet-friendly)
const CATEGORY_TYPES = {
  vet:  ['veterinary_care'],
  park: ['dog_park', 'park'],
  cafe: ['cafe', 'restaurant'],
};

function isValidCategory(category) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_TYPES, category);
}

async function findNearbyPlaces(lat, lng, category = 'vet', radiusMeters = 5000) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set in .env');
  const includedTypes = CATEGORY_TYPES[category] || CATEGORY_TYPES.vet;

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
        'places.internationalPhoneNumber',
        'places.nationalPhoneNumber',
      ].join(','),
    },
    body: JSON.stringify({
      includedTypes,
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
      name:    p.displayName?.text || 'Unknown place',
      address: p.formattedAddress  || '',
      rating:  p.rating            || null,
      reviews: p.userRatingCount   || 0,
      open:    p.currentOpeningHours?.openNow ?? null,
      phone:   p.internationalPhoneNumber || p.nationalPhoneNumber || null,
      mapsUrl: `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    }))
    .sort((a, b) => (b.rating || 0) - (a.rating || 0));
}

// Backward-compatible vet-only helper (used by the booking-draft phone lookup path).
function findNearbyVets(lat, lng, radiusMeters = 5000) {
  return findNearbyPlaces(lat, lng, 'vet', radiusMeters);
}

module.exports = { findNearbyPlaces, findNearbyVets, isValidCategory };
