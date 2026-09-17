import type { AddressProvider } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey } from '../config';
import { fetchWithRetry } from '../http';

// Postcoder (https://postcoder.com) adapter — capture only.
//
// Docs:
//   Overview:       https://postcoder.com/docs/address-lookup
//   autocomplete:   https://postcoder.com/docs/address-lookup/autocomplete-find
//   retrieve:       https://postcoder.com/docs/address-lookup/autocomplete-retrieve
//
// AUTH: a single API key (PCW…-…-…-…X format, from the account dashboard)
// sent as the `apikey` query param. No header, no secret pair — KEY_ENV only.
//
// CAPTURE (validated live with a trial key; NG):
//   GET …/autocomplete/find?query=<q>&country=ng&apikey=<key>&format=json
//       &singlesummary=true&maximumresults=10
//     -> JSON array of { id, type, summaryline, locationsummary, count }.
//     type "ADD" = an address — its id resolves via autocomplete/retrieve.
//     Any other type (STR, BNA, LOC…) = a broader location that needs a
//     pathfilter drill-down; for NG the data bottoms out at street level, so
//     non-ADD ids are dead ends. We surface ADD suggestions only (same stance
//     as postgrid.ts: only resolvable suggestions appear in the typeahead).
//   GET …/autocomplete/retrieve/?id=<id>&query=<q>&country=ng
//       &apikey=<key>&format=json&addtags=latitude,longitude
//     -> JSON array with one record: addressline1/2, number, premise, street,
//        posttown, county, state, postcode, country, and latitude/longitude
//        WHEN addtags is set (probed: without addtags the record has NO
//        coordinates). NG records are street-level with no postcode.
//     The `query` param is only echoed — resolution is driven by `id`.
//     Live-probed: retriever with a bogus query (and with the id itself as
//     the query) returned the correct address. We therefore echo the id,
//     which keeps retrieve() STATELESS: no module-level cache, so it works
//     across Next's per-route module instances and after server restarts
//     (a geoapify-style in-memory cache keyed by suggestion id failed in
//     dev because /api/autocomplete and /api/retrieve get separate bundles).
//
// VERIFY: not offered. Postcoder has no address verification/cleansing
// product — its docs sitemap covers address lookup plus bank/email/mobile
// validation and OTP only. So kind: 'capture' and no verify(); the /api/verify
// route rejects it before any request is made.
//
// PRICING: autocomplete/find = 0 credits (free); autocomplete/retrieve =
// 2 credits rest-of-world (2.4 with addtags). Credits come in packs or
// monthly plans (probed /status on the trial key: credits healthy, state Ok).
//
// RATE LIMIT: the default API-key security setting allows 5 requests per IP
// per 5 minutes (security + troubleshooting docs). A typing burst of
// debounced find calls plus the chargeable retrieve therefore trips HTTP 429
// "Browser Direct Lookups exceeded, retry later" — NOT a credit/billing
// error. Fix in the Postcoder dashboard: raise the per-IP limit (1–50 per
// 5 min) or switch the key to "Trusted IP addresses only" (the documented
// mode for server-side integrations like this one). Every request counts
// toward the window, including 0-credit find calls.
//
// ERRORS: non-200 bodies are plain text (probed: wrong key -> HTTP 403
// "Incorrect Search Key (check Status service for additional details)").
// No matches -> HTTP 200 with an empty array, not an error.

const BASE = 'https://ws.postcoder.com/pcw';
// POC is Nigeria-fixed — same constant approach as the other adapters.
const COUNTRY = 'ng';
// Attribution on their Identifier Usage page (account dashboard).
const IDENTIFIER = 'address-poc';

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

function statusError(status: number, body: string): Error {
  const detail = body.trim().slice(0, 200) || '(empty error body)';
  switch (status) {
    case 401:
      return new Error(`Postcoder: unauthorized (401) — ${detail}`);
    case 403:
      return new Error(`Postcoder HTTP 403: ${detail}`);
    case 429:
      return new Error(`Postcoder: rate limited (429) — ${detail}`);
    default:
      return new Error(`Postcoder HTTP ${status}: ${detail}`);
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetchWithRetry(url);
  const body = await res.text();
  if (!res.ok) throw statusError(res.status, body);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Postcoder: non-JSON response ${body.slice(0, 160)}`);
  }
}

function toCanonical(rec: Record<string, unknown>, providerId: string): CanonicalAddress {
  const latS = pick(rec, ['latitude']);
  const lngS = pick(rec, ['longitude']);
  const lat = latS ? parseFloat(latS) : undefined;
  const lng = lngS ? parseFloat(lngS) : undefined;
  return {
    line1: pick(rec, ['addressline1', 'summaryline']),
    line2: pick(rec, ['addressline2']) || undefined,
    // NG records carry the town in posttown; county carries the state
    // (e.g. "Lagos") — both surface here rather than being dropped.
    cityArea: pick(rec, ['posttown']),
    state: pick(rec, ['state', 'county']),
    postalCode: pick(rec, ['postcode']),
    country: pick(rec, ['country']) || 'Nigeria',
    lat: lat !== undefined && !Number.isNaN(lat) ? lat : undefined,
    lng: lng !== undefined && !Number.isNaN(lng) ? lng : undefined,
    providerId,
  };
}

export const postcoder: AddressProvider = {
  id: 'postcoder',
  kind: 'capture',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const qs = new URLSearchParams({
      query,
      country: COUNTRY,
      apikey: getKey('postcoder'),
      format: 'json',
      singlesummary: 'true',
      maximumresults: '10',
      identifier: IDENTIFIER,
    });
    const json = await getJson(`${BASE}/autocomplete/find?${qs.toString()}`);
    return firstArray(json)
      .filter(isRecord)
      .filter((s) => pick(s, ['type']) === 'ADD')
      .map((s) => {
        const providerId = pick(s, ['id']);
        const label = pick(s, ['summaryline', 'locationsummary']) || providerId;
        return { label, providerId, raw: s };
      })
      .filter((s) => s.label.length > 0 && s.providerId.length > 0);
  },

  async retrieve(providerId: string): Promise<NormalizedResult> {
    // `query` is echoed, not used for resolution (see header) — the id alone
    // drives the lookup, so no cross-request state is needed.
    const qs = new URLSearchParams({
      id: providerId,
      query: providerId,
      country: COUNTRY,
      apikey: getKey('postcoder'),
      format: 'json',
      addtags: 'latitude,longitude',
      identifier: IDENTIFIER,
    });
    const json = await getJson(`${BASE}/autocomplete/retrieve/?${qs.toString()}`);
    const rec = firstArray(json).filter(isRecord)[0];
    if (!rec) {
      throw new Error('Postcoder: retrieve returned no address record');
    }
    return { canonical: toCanonical(rec, providerId), raw: json };
  },
};