import type { AddressProvider, VerifyInput } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey } from '../config';
import { fetchWithRetry } from '../http';

// Geoapify (https://geoapify.com) adapter — capture + verify (Category B).
//
// Docs:
//   Autocomplete:      https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/
//   Forward geocoding: https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/
//
// AUTH: one API key, sent as an `X-Api-Key` header (their docs also accept
// an `apiKey` query param — the header keeps the key out of query logs).
//
// CAPTURE:
//   GET /v1/geocode/autocomplete?text=<q>&filter=countrycode:ng&limit=10&lang=en
//     -> FeatureCollection. Unlike Google (text+id only), Geoapify's
//        autocomplete ALREADY returns the complete structured address in
//        each feature.properties (address_line1/2, city, state, postcode,
//        lat/lon, rank.confidence/match_type) — there is no "details" round
//        trip. Confirmed against the live API (2026-03): the search endpoint
//        has NO id-lookup — GET /v1/geocode/search?id=... 400s with
//        '"value" must contain at least one of [text, name, housenumber,
//        postcode, city, state, country]' — and reverse geocoding can't
//        faithfully reproduce a suggestion (at bare coordinates it returned
//        a POI name as address_line1).
//   RETRIEVE is therefore served from a module-level cache populated by
//     autocomplete() (suggestion properties keyed by place_id). This honors
//     the app's "typeahead rows must be re-resolvable by id" invariant in
//     every realistic flow: search and pick happen seconds apart in the same
//     process. On a cache miss (e.g. the page survived a server restart) we
//     throw a clear "please search again" error rather than degrade.
//
// VERIFY (geocoded/heuristic — matches a candidate on a map; it does NOT
// confirm postal deliverability):
//   GET /v1/geocode/search?text=<freeform>&country=ng&lang=en
//     Freeform single-line form: Geoapify's own parser handles Nigerian
//     conventions (house-number-first lines, "Plot 12", missing postcodes)
//     better than a fragile client-side street/housenumber split. The
//     structured alternative on the same endpoint (housenumber/street/
//     city/state/postcode params) is documented if we later want to isolate
//     postcode effects.
//     Empty features[] = no spatial match -> throws (a real signal for this
//     category, logged like any verify failure). Placement quality is graded
//     in lib/verdict.ts from properties.rank.match_type, with
//     rank.confidence (0..1) kept in the raw payload. Live-probed:
//     '15 Admiralty Way, Ikoyi, Lagos' -> building match; a fabricated
//     address -> features:[] (HTTP 200).
//
// Errors: bodies are { statusCode, error, message } JSON. 401 bad/absent
// key, 403 free-tier usage exceeded (3,000 credits/day), 429 rate limit.

const AUTO_URL = 'https://api.geoapify.com/v1/geocode/autocomplete';
const SEARCH_URL = 'https://api.geoapify.com/v1/geocode/search';
// Alpha-2, per Geoapify's `country` (search) / `filter=countrycode:` (autocomplete) params.
const COUNTRY = 'ng';
// Bound on distinct place_ids kept for retrieve (each search re-seeds ~10).
const CACHE_MAX = 200;

/** place_id -> autocomplete feature properties (retrieve is cache-served). */
const suggestionCache = new Map<string, Record<string, unknown>>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(rec: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && !Number.isNaN(v)) return `${v}`;
  }
  return '';
}

/** First array found in a response envelope (guards unknown wrapper keys). */
function firstArray(node: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(node)) return node;
  if (isRecord(node)) {
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) return v;
      const r = firstArray(v, depth + 1);
      if (r.length > 0) return r;
    }
  }
  return [];
}

/** FeatureCollection.features records. */
function featuresOf(node: unknown): Record<string, unknown>[] {
  return firstArray(node).filter(isRecord);
}

function propsOf(feature: Record<string, unknown>): Record<string, unknown> {
  return isRecord(feature.properties) ? feature.properties : feature;
}

/** 401/403/429 carry semantic weight — surface them usefully. */
function statusError(status: number, body: string): Error {
  // Error body is { statusCode, error, message } JSON, but message can hold
  // escaped quotes ("\"value\" must contain at least one of [...]") which a
  // regex can't parse — extract via JSON.parse instead.
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) detail = parsed.message;
    else if (typeof parsed.error === 'string' && parsed.error) detail = parsed.error;
    else detail = body ? body.slice(0, 160) : '(empty error body)';
  } catch {
    detail = body ? body.slice(0, 160) : '(empty error body)';
  }
  switch (status) {
    case 401:
      return new Error(`Geoapify: unauthorized (401) — ${detail}`);
    case 403:
      return new Error(
        `Geoapify: free-tier usage limit exceeded (403) — ${detail}. The free tier allows 3,000 credits/day.`,
      );
    case 429:
      return new Error(`Geoapify: rate limited (429) — ${detail}`);
    default:
      return new Error(`Geoapify HTTP ${status}: ${detail}`);
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetchWithRetry(url, { headers: { 'X-Api-Key': getKey('geoapify') } });
  const body = await res.text();
  if (!res.ok) throw statusError(res.status, body);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Geoapify: non-JSON response ${body.slice(0, 160)}`);
  }
  return json;
}

/** Cache a suggestion's full properties under its place_id (LRU-ish via delete+set). */
function cacheSuggestion(id: string, props: Record<string, unknown>): void {
  if (suggestionCache.has(id)) suggestionCache.delete(id);
  suggestionCache.set(id, props);
  if (suggestionCache.size > CACHE_MAX) {
    const oldest = suggestionCache.keys().next().value;
    if (oldest !== undefined) suggestionCache.delete(oldest);
  }
}

function toCanonical(props: Record<string, unknown>, providerId: string): CanonicalAddress {
  const latS = pick(props, ['lat']);
  const lngS = pick(props, ['lon']);
  const lat = latS ? parseFloat(latS) : undefined;
  const lng = lngS ? parseFloat(lngS) : undefined;
  return {
    line1: pick(props, ['address_line1', 'formatted']),
    line2: pick(props, ['address_line2']) || undefined,
    cityArea: pick(props, ['city', 'town', 'village', 'municipality']),
    state: pick(props, ['state']),
    postalCode: pick(props, ['postcode']),
    country: pick(props, ['country']) || 'Nigeria',
    lat: lat !== undefined && !Number.isNaN(lat) ? lat : undefined,
    lng: lng !== undefined && !Number.isNaN(lng) ? lng : undefined,
    providerId,
  };
}

export const geoapify: AddressProvider = {
  id: 'geoapify',
  kind: 'both',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const qs = new URLSearchParams({
      text: query,
      filter: `countrycode:${COUNTRY}`,
      limit: '10',
      lang: 'en',
    });
    const json = await getJson(`${AUTO_URL}?${qs.toString()}`);
    return featuresOf(json)
      .map((feature) => {
        const props = propsOf(feature);
        const providerId = pick(props, ['place_id']);
        if (providerId) cacheSuggestion(providerId, props);
        return {
          label: pick(props, ['formatted', 'address_line1']),
          providerId,
          raw: props,
        };
      })
      .filter((s) => s.label.length > 0 && s.providerId.length > 0);
  },

  async retrieve(placeId: string): Promise<NormalizedResult> {
    const props = suggestionCache.get(placeId);
    if (!props) {
      throw new Error('Geoapify: place_id no longer in the lookup cache — please search again');
    }
    return { canonical: toCanonical(props, placeId), raw: props };
  },

  async verify(input: VerifyInput): Promise<NormalizedResult> {
    const text = [input.line1, input.line2, input.cityArea, input.state, input.postalCode]
      .filter(Boolean)
      .join(', ');
    const qs = new URLSearchParams({ text, country: COUNTRY, lang: 'en' });
    const json = await getJson(`${SEARCH_URL}?${qs.toString()}`);
    const features = featuresOf(json);
    if (features.length === 0) {
      throw new Error('Geoapify: no spatial match — address not found on map');
    }
    return { canonical: toCanonical(propsOf(features[0]), 'geoapify'), raw: json };
  },
};