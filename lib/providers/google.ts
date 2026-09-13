import type { AddressProvider } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey } from '../config';

// Google Places API (New) adapter — capture only (Google's Address Validation
// API does not cover Nigeria, so verify is intentionally absent).

const BASE = 'https://places.googleapis.com/v1';

interface GoogleSuggestion {
  placePrediction?: { placeId: string; text: { text: string } };
  queryPrediction?: { text: { text: string } };
}

interface AutocompleteResponse {
  suggestions?: GoogleSuggestion[];
}

interface AddressComponent {
  longText: string;
  shortText: string;
  types: string[];
}

interface PlaceResponse {
  id: string;
  formattedAddress: string;
  location?: { latitude: number; longitude: number };
  addressComponents?: AddressComponent[];
}

export const google: AddressProvider = {
  id: 'google',
  kind: 'capture',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const res = await fetch(`${BASE}/places:autocomplete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getKey('google'),
      },
      body: JSON.stringify({ input: query, languageCode: 'en' }),
    });
    if (!res.ok) throw new Error(`Google autocomplete ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as AutocompleteResponse;

    const suggestions: Suggestion[] = [];
    for (const s of data.suggestions ?? []) {
      // Typeahead rows must be retrievable by id, so drop query predictions.
      if (s.placePrediction) {
        suggestions.push({
          label: s.placePrediction.text.text,
          providerId: s.placePrediction.placeId,
          raw: s.placePrediction,
        });
      }
    }
    return suggestions;
  },

  async retrieve(placeId: string): Promise<NormalizedResult> {
    const res = await fetch(`${BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': getKey('google'),
        'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents',
      },
    });
    if (!res.ok) throw new Error(`Google retrieve ${res.status}: ${await res.text()}`);
    const place = (await res.json()) as PlaceResponse;

    const components = place.addressComponents ?? [];
    const pick = (types: string[]) =>
      components.find((c) => types.some((t) => c.types.includes(t)));

    const streetNumber = pick(['street_number'])?.longText;
    const route = pick(['route'])?.longText;
    const line1 = [streetNumber, route].filter(Boolean).join(' ');

    const canonical: CanonicalAddress = {
      line1,
      line2: pick(['subpremise', 'premise'])?.longText,
      cityArea: pick(['locality'])?.longText ?? '',
      state: pick(['administrative_area_level_1'])?.longText ?? '',
      postalCode: pick(['postal_code'])?.longText ?? '',
      country: pick(['country'])?.longText ?? '',
      lat: place.location?.latitude,
      lng: place.location?.longitude,
      providerId: place.id,
    };

    return { canonical, raw: place };
  },
};