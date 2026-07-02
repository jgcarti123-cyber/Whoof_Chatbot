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

// Shared field mask + place→object mapping, used by both nearby and text search.
const PLACE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.currentOpeningHours.openNow',
  'places.internationalPhoneNumber',
  'places.nationalPhoneNumber',
];

function mapPlace(p) {
  return {
    name:    p.displayName?.text || 'Unknown place',
    address: p.formattedAddress  || '',
    lat:     p.location?.latitude  ?? null,
    lng:     p.location?.longitude ?? null,
    rating:  p.rating            || null,
    reviews: p.userRatingCount   || 0,
    open:    p.currentOpeningHours?.openNow ?? null,
    phone:   p.internationalPhoneNumber || p.nationalPhoneNumber || null,
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:${p.id}`,
  };
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
      'X-Goog-FieldMask': PLACE_FIELDS.join(','),
    },
    body: JSON.stringify({
      includedTypes,
      // 20 is the Places API (New) max — pulling the full page gives routes/chat.js enough
      // real candidates to hit the 5–7 shown/RECOMMEND_MIN/RECOMMEND_DEFAULT requirement
      // (and to top up parks/cafés when the community pass alone turns up fewer than 5).
      maxResultCount: 20,
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
    .map(mapPlace)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0));
}

// Resolve a named clinic to a real place (address + phone) via Places Text Search.
// Used by the in-chat booking flow when the owner names a clinic that isn't one of
// their saved vets — we look it up to get a phone number for the WhatsApp draft.
// Returns the best match (mapPlace shape) or null when nothing is found.
async function searchPlaceByText(textQuery) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set in .env');
  const q = (textQuery || '').toString().trim();
  if (!q) return null;

  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': PLACE_FIELDS.join(','),
    },
    body: JSON.stringify({ textQuery: q, maxResultCount: 3 }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Places API HTTP ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const places = (data.places || []).map(mapPlace);
  if (!places.length) return null;
  // Prefer the first result that actually has a phone number (that's what we need for
  // the booking link); otherwise return the top match so we can still link to Maps.
  return places.find(p => p.phone) || places[0];
}

// Backward-compatible vet-only helper (used by the booking-draft phone lookup path).
function findNearbyVets(lat, lng, radiusMeters = 5000) {
  return findNearbyPlaces(lat, lng, 'vet', radiusMeters);
}

module.exports = { findNearbyPlaces, findNearbyVets, searchPlaceByText, isValidCategory };
