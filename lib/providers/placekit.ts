import type { AddressProvider } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey } from '../config';
import { fetchWithRetry } from '../http';

// PlaceKit (https://placekit.io) adapter — capture only.
//
// Docs/OpenAPI: https://api.placekit.io/ (rendered from
// github.com/placekit/api-reference, spec v1.4.0). The live API host is
// api.placekit.co — the .io domain is the OpenAPI/docs host.
//
// AUTH: a single API key, sent as the `x-placekit-api-key` header (their
// apiKey security scheme). Server-side only, like every adapter here —
// PlaceKit also issues browser-safe "public" keys with domain allowlists,
// but this repo keeps vendor keys in process.env (lib/config.ts).
//
// CAPTURE (validated live with the trial key in .env.local; NG):
//   POST /search  body { query, countries: ['ng'], maxResults, language }
//     -> JSON { results: [ { highlight?, street: { number, suffix, name },
//        name, city, county, administrative, country, countrycode, zipcode:
//        string[], population, lat, lng, coordinates: "lat, lng", type } ],
//        resultsCount, maxResults, query }
//     Live probes: '15 Admiralty Way, Ikoyi, Lagos' -> name "15 Admiralty
//     Way" with street.number "15"; 'Plot 12, Joel Ogunnaike Street, Ikosi,
//     Ikeja' -> "12 Joel Ogunnaike Street"; 'Lagos' -> a type "city" record
//     then type "street" records. NG records carry zipcode[] (e.g. 71510,
//     100242) and coordinates out of the box — no addtags-style flag needed
//     (contrast postcoder.ts). Gibberish queries return HTTP 200 with a
//     fuzzy low-relevance record rather than an error or an empty list.
//     All record types are surfaced as the API ranks them (like the
//     google/geoapify adapters); the `types` request param exists if the
//     typeahead ever needs restricting to street/city only.
//
//   RETRIEVE: PlaceKit records carry NO id and the API has NO id-based
//     retrieve endpoint (OpenAPI paths: /search, /reverse, /patch/*, /keys).
//     The suggestion's providerId is therefore the base64url-encoded JSON of
//     the record, and retrieve() decodes it back — STATELESS, with no
//     module-level cache (a geoapify-style cache fails in dev because
//     /api/autocomplete and /api/retrieve get separate bundles; see
//     postcoder.ts), no second network call, and no extra billing. This
//     honors the app's "typeahead rows must be re-resolvable by id"
//     invariant. The encoded id is a transport detail only — canonical
//     providerId is left empty because PlaceKit exposes no stable record id
//     (the "provider id" row in the capture details panel stays blank).
//
// VERIFY: not offered. PlaceKit's product is forward/reverse geocoding plus
// admin APIs (Live Patching /patch, key management /keys) — no address
// verification/cleansing. So kind: 'capture' and no verify().
//
// ERRORS: JSON bodies { message, errors? }. Probed with the trial key:
//   bad API key -> HTTP 401 "Access denied: authentication failed."
//   unsupported country (e.g. countries[0]='sx') -> HTTP 422
//     "Invalid body parameters..." with errors[] { path, msg, ... }.
//   429 (documented) "Too many requests from this IP, please try again in a
//   minute"; 403/412 access-denied variants; 451 fair-usage violation.
//
// PRICING (placekit.io/pricing): 10,000 requests/month free every month;
// $0.0030 per request from 10k to 50k; custom volume plans beyond.

const BASE = 'https://api.placekit.co';
// POC is Nigeria-fixed — same constant approach as the other adapters.
const COUNTRY = 'ng';

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

/** `coordinates` is the documented source; lat/lng are also present live. */
function coords(rec: Record<string, unknown>): { lat?: number; lng?: number } {
  const pair = pick(rec, ['coordinates']);
  if (pair) {
    const parts = pair.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      return { lat: parts[0], lng: parts[1] };
    }
  }
  const lat = parseFloat(pick(rec, ['lat']));
  const lng = parseFloat(pick(rec, ['lng']));
  const out: { lat?: number; lng?: number } = {};
  if (!Number.isNaN(lat)) out.lat = lat;
  if (!Number.isNaN(lng)) out.lng = lng;
  return out;
}

// Each suggestion stores the full PlaceKit record in its id (see header).
function encodeRecord(rec: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(rec)).toString('base64url');
}

function decodeRecord(id: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function statusError(status: number, body: string): Error {
  let message = body.trim().slice(0, 200) || '(empty error body)';
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      errors?: Array<{ path?: unknown; msg?: unknown }>;
    };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      message = parsed.message;
    }
    if (Array.isArray(parsed.errors)) {
      const detail = parsed.errors
        .map((e) => `${String(e?.path ?? '?')}: ${String(e?.msg ?? '')}`)
        .filter((s) => s.length > 0)
        .join('; ');
      if (detail) message = `${message} (${detail})`;
    }
  } catch {
    // keep the raw body
  }
  switch (status) {
    case 401:
      return new Error(`PlaceKit: unauthorized (401) — ${message}`);
    case 403:
      return new Error(`PlaceKit HTTP 403: ${message}`);
    case 412:
      return new Error(`PlaceKit: access denied, missing credentials (412) — ${message}`);
    case 422:
      return new Error(`PlaceKit HTTP 422: ${message}`);
    case 429:
      return new Error(`PlaceKit: rate limited (429) — ${message}`);
    case 451:
      return new Error(`PlaceKit: fair usage policy violation (451) — ${message}`);
    default:
      return new Error(`PlaceKit HTTP ${status}: ${message}`);
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-placekit-api-key': getKey('placekit'),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw statusError(res.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`PlaceKit: non-JSON response ${text.slice(0, 160)}`);
  }
}

function toCanonical(rec: Record<string, unknown>): CanonicalAddress {
  const { lat, lng } = coords(rec);
  const zipcode = Array.isArray(rec.zipcode)
    ? rec.zipcode.filter((z): z is string => typeof z === 'string')
    : [];
  return {
    line1: pick(rec, ['name']),
    // Live NG records put suburb-ish names in city and the LGA in county;
    // surface city as-is.
    cityArea: pick(rec, ['city']),
    // For NG, administrative carries the state (e.g. "Lagos") and county the
    // LGA (e.g. "Eti Osa") — administrative first, matching the admin-1 level
    // of every other country's data.
    state: pick(rec, ['administrative', 'county']),
    postalCode: zipcode[0] ?? '',
    country: pick(rec, ['country']) || 'Nigeria',
    lat,
    lng,
  };
}

export const placekit: AddressProvider = {
  id: 'placekit',
  kind: 'capture',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const json = await postJson(`${BASE}/search`, {
      query,
      countries: [COUNTRY],
      maxResults: 10,
      language: 'en',
    });
    const results = isRecord(json) && Array.isArray(json.results) ? json.results : [];
    return results
      .filter(isRecord)
      .map((s) => {
        const label = pick(s, ['name']);
        const providerId = encodeRecord(s);
        return { label, providerId, raw: s };
      })
      .filter((s) => s.label.length > 0 && s.providerId.length > 0);
  },

  async retrieve(providerId: string): Promise<NormalizedResult> {
    const rec = decodeRecord(providerId);
    if (!rec) {
      throw new Error('PlaceKit: suggestion id is not a decodable record — search again?');
    }
    return { canonical: toCanonical(rec), raw: rec };
  },
};