import type { AddressProvider, VerifyInput } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey, getSecret } from '../config';
import { fetchWithRetry } from '../http';

// Precisely adapter — capture + verify. Contract live-confirmed 2026-02-16
// against the working host api.cloud.precisely.com (the older
// api.precisely.com + POST /oauth/token contract simply did not match this
// account — the credentials were valid all along).
//
//   AUTH: POST /auth/v2/token — HTTP Basic (clientId:clientSecret) with form
//     body grant_type=client_credentials&scope=default (scope is REQUIRED)
//     -> { access_token, expires_in } ; cached until expiry, refreshed on 401.
//
//   CAPTURE: POST /v1/autocomplete
//     { preferences: { maxResults, returnAllInfo: true },
//       address: { addressLines: ["<query>"], country: "NGA" } }
//     -> { response: { status: "OK" | "ZERO_RESULTS", predictions: [...] } }
//     Each prediction carries the full resolved address in one call:
//       prediction, address { formattedAddress, formattedStreetAddress,
//       city{longName}, admin1{longName}, country{name} }, addressLines[],
//       location.feature.geometry.coordinates [lng, lat],
//       explanation.addressMatch.description [{ label, matchType }]
//
//   VERIFY: POST /v1/verify — batch form
//     { addresses: [ { addressLines: [...], country: "NGA" } ] }
//     -> { responses: [ { status: "OK" | "ZERO_RESULTS",
//          results: [ { score, address{...}, addressLines[],
//          explanation.addressMatch.type: "ADDRESS" | "STREET" | "ADMIN" } ] } ] }
//     No coordinates on verify results (autocomplete only).
//
//   ZERO_RESULTS arrives as HTTP 200 with no results array — a no-match, not a
//   transport error. Bad request bodies get 400
//   { errors: [{ status: "INVALID_CLIENT_INPUT" (DIS-LI-1018) }] }.

const BASE = 'https://api.cloud.precisely.com';
const TOKEN_URL = `${BASE}/auth/v2/token`;
const AUTOCOMPLETE_URL = `${BASE}/v1/autocomplete`;
const VERIFY_URL = `${BASE}/v1/verify`;
const COUNTRY = 'NGA';

// Module-level token cache with expiry.
let cachedToken = '';
let cachedUntil = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const clientId = getKey('precisely');
  const clientSecret = getSecret('precisely');
  const res = await fetchWithRetry(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials&scope=default',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Precisely token ${res.status}: ${text}`);
  }
  let json: { access_token?: string; expires_in?: number } = {};
  try {
    json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  } catch {
    throw new Error(`Precisely token: non-JSON response ${text}`);
  }
  const token = json.access_token;
  if (!token) throw new Error('Precisely token: no access_token in response');
  const ttlMs = (json.expires_in ?? 3600) * 1000;
  cachedToken = token;
  cachedUntil = Date.now() + Math.max(ttlMs - 60_000, 30_000);
  return token;
}

function clearToken(): void {
  cachedToken = '';
  cachedUntil = 0;
}

/** Fetch with Bearer token; refreshes once on 401 (stale token recovery). */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await getToken()}`);
  const res = await fetchWithRetry(`${BASE}${path}`, { ...init, headers });
  if (res.status !== 401) return res;
  clearToken();
  const retry = new Headers(init.headers);
  retry.set('Authorization', `Bearer ${await getToken()}`);
  return fetchWithRetry(`${BASE}${path}`, { ...init, headers: retry });
}

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

/** Nested record accessor: `nested(addr, 'city')` never throws. */
function nested(rec: Record<string, unknown>, key: string): Record<string, unknown> {
  return isRecord(rec[key]) ? (rec[key] as Record<string, unknown>) : {};
}

/** Autocomplete call; returns the envelope status + prediction records. */
async function predictions(
  query: string,
): Promise<{ status: string; items: Record<string, unknown>[] }> {
  const res = await authedFetch('/v1/autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preferences: { maxResults: 10, returnAllInfo: true },
      address: { addressLines: [query], country: COUNTRY },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Precisely autocomplete ${res.status}: ${text}`);
  const data = JSON.parse(text) as unknown;
  const response = isRecord(data) ? nested(data, 'response') : {};
  const items = (Array.isArray(response.predictions) ? response.predictions : []).filter(isRecord);
  return { status: pick(response, ['status']), items };
}

/** [lng, lat] from a prediction's GeoJSON point. */
function coordsOf(prediction: Record<string, unknown>): { lat?: number; lng?: number } {
  const location = nested(prediction, 'location');
  const geometry = nested(nested(location, 'feature'), 'geometry');
  const coords = geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return {};
  const lng = typeof coords[0] === 'number' ? coords[0] : undefined;
  const lat = typeof coords[1] === 'number' ? coords[1] : undefined;
  return { lat, lng };
}

function lineArray(rec: Record<string, unknown>): string[] {
  const lines = rec.addressLines;
  return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string') : [];
}

function canonicalFrom(
  addr: Record<string, unknown>,
  lines: string[],
  providerId: string,
  lat?: number,
  lng?: number,
): CanonicalAddress {
  const city = nested(addr, 'city');
  const admin1 = nested(addr, 'admin1');
  const admin2 = nested(addr, 'admin2');
  const postal = addr.postalCode;
  return {
    // formattedStreetAddress is absent on weak (ADMIN/STREET) matches — fall
    // back to the first returned address line so the output stays honest.
    line1: pick(addr, ['formattedStreetAddress']) || lines[0] || '',
    line2: undefined,
    cityArea: pick(city, ['longName', 'shortName']),
    state: pick(admin1, ['longName', 'shortName']) || pick(admin2, ['longName', 'shortName']),
    postalCode:
      (typeof postal === 'string' ? postal : '') ||
      pick(nested(addr, 'postalCode'), ['longName', 'shortName']),
    country: pick(nested(addr, 'country'), ['name']) || 'Nigeria',
    lat,
    lng,
    providerId,
  };
}

export const precisely: AddressProvider = {
  id: 'precisely',
  kind: 'both',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const { items } = await predictions(query);
    return items
      .map((it) => ({
        label: pick(it, ['prediction']),
        providerId: pick(it, ['prediction']),
        raw: it,
      }))
      .filter((s) => s.label.length > 0);
  },

  // Autocomplete predictions already contain the resolved address, but the
  // client only holds the label — re-run the lookup for the selected label and
  // take its top prediction (same "resolve the selection" shape as the other
  // adapters). providerId is the prediction text.
  async retrieve(id: string): Promise<NormalizedResult> {
    const { items } = await predictions(id);
    const item = items[0];
    if (!item) throw new Error('Precisely: no match for selection');
    const addr = nested(item, 'address');
    const { lat, lng } = coordsOf(item);
    return { canonical: canonicalFrom(addr, lineArray(item), id, lat, lng), raw: item };
  },

  async verify(input: VerifyInput): Promise<NormalizedResult> {
    // Batch-shaped request: { addresses: [ { addressLines, country } ] }.
    const lines = [input.line1, input.line2, input.cityArea, input.state, input.postalCode].filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    const res = await authedFetch('/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [{ addressLines: lines, country: COUNTRY }] }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Precisely verify ${res.status}: ${text}`);
    const data = JSON.parse(text) as unknown;

    const responses = isRecord(data) && Array.isArray(data.responses) ? data.responses : [];
    const first = isRecord(responses[0]) ? responses[0] : {};
    const status = pick(first, ['status']);
    const results = Array.isArray(first.results) ? first.results.filter(isRecord) : [];
    if (status !== 'OK' || results.length === 0) {
      // ZERO_RESULTS = no match at all (HTTP 200). Surface it as a miss.
      throw new Error(`Precisely: no match (${status || 'empty response'})`);
    }

    const item = results[0];
    const addr = nested(item, 'address');
    return {
      canonical: canonicalFrom(addr, lineArray(item), `${input.line1}|verified`),
      raw: data,
    };
  },
};