import type { AddressProvider, VerifyInput } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey, getSecret } from '../config';
import { fetchWithRetry } from '../http';
import { noMatchError } from '../errors';

// Smarty (https://www.smarty.com) adapter — capture + verify.
// Contract from their docs (2026-02-16, live-probed from this machine):
//
//   AUTH: "secret key" pair — auth-id (disclosure-safe) + auth-token
//   (secret), sent as query params on every request (both APIs are GET-only).
//   Their "embedded keys" are the browser-side alternative (Referer-bound,
//   GET-only, blocked from public-cloud IPs) — wrong for server-side use.
//
//   CAPTURE (International Address Autocomplete V2, free search):
//     GET https://international-autocomplete.api.smarty.com/v2/lookup
//         ?country=<ISO3, uppercase>&search=<q>&max_results=<1..10>
//         -> { "candidates": [ { "address_text", "address_id", "entries" } ] }
//     GET https://international-autocomplete.api.smarty.com/v2/lookup/<address_id>
//         ?country=<ISO3>  (billing happens on this final selection, not per
//         keystroke) -> { "candidates": [ { "street", "locality",
//         "administrative_area", "postal_code", "country_iso3" } ] }
//         A multi-entry candidate expands to subunit candidates here.
//
//   VERIFY (International Street Address API):
//     GET https://international-street.api.smarty.com/verify
//         ?country=<ISO3>&address1=<addr>&locality=&administrative_area=
//         &postal_code=&geocode=true
//         -> [ { address1..., components: {...}, metadata: {latitude,
//              longitude, geocode_precision}, analysis: {verification_status,
//              address_precision} } ]  (JSON array, one element per match)
//         verification_status: Verified | Partial | Ambiguous; address
//         precision: DeliveryPoint / Premise / Thoroughfare or worse.
//         NOTE: geocode=true is NOT sent by default — Global Geocoding is a
//         separate paid subscription (402 `1588026162` on trial/non-geo
//         accounts), while plain verification works on the Address
//         Verification trial. Set GEOCODE to 'true' to re-enable
//         coordinates once the account licenses it.
//
//   STATUS CODES: 401 bad creds (or embedded key called from a cloud IP),
//   402 no active subscription, 422 missing required fields, 429 rate limit
//   on identical repeat requests. All bodies are { "errors": [...] } JSON.

const AUTO_BASE = 'https://international-autocomplete.api.smarty.com/v2/lookup';
const VERIFY_URL = 'https://international-street.api.smarty.com/verify';
// Both APIs accept ISO-3; autocomplete requires uppercase ISO-3 (3 bytes max).
const COUNTRY = 'NGA';
// Global Geocoding is a separate paid product — see verify() comment.
// Flip to true once the account licenses it (restores lat/lng on results).
const GEOCODE = false;

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

function withAuth(qs: URLSearchParams): URLSearchParams {
  qs.set('auth-id', getKey('smarty'));
  qs.set('auth-token', getSecret('smarty'));
  return qs;
}

/** 401/402/422/429 carry a "status header" semantics — surface them usefully. */
function statusError(status: number, body: string): Error {
  const vendor = /"message":\s*"([^"]+)"/.exec(body);
  const detail = vendor?.[1] ?? body.slice(0, 160);
  switch (status) {
    case 401:
      return new Error(`Smarty: unauthorized (401) — ${detail}`);
    case 402:
      return new Error(
        `Smarty: no active subscription for this account (402) — ${detail}. ` +
          `Activate the free trial on the International products at ` +
          `https://www.smarty.com/account/subscriptions, then retry.`,
      );
    case 422:
      return new Error(`Smarty: missing/unsuitable parameters (422) — ${detail}`);
    case 429:
      return new Error(`Smarty: rate limited (429, identical repeat requests) — ${detail}`);
    default:
      return new Error(`Smarty HTTP ${status}: ${detail}`);
  }
}

function geoOf(rec: Record<string, unknown>): Record<string, unknown> {
  return isRecord(rec.metadata) ? rec.metadata : {};
}

function canonicalFrom(
  display: Record<string, unknown>,
  comps: Record<string, unknown>,
  geo: Record<string, unknown>,
  providerId: string,
): CanonicalAddress {
  const latS = pick(geo, ['latitude', 'lat']);
  const lngS = pick(geo, ['longitude', 'lng']);
  const lat = latS ? parseFloat(latS) : undefined;
  const lng = lngS ? parseFloat(lngS) : undefined;
  const iso3 = pick(comps, ['country_iso3']);
  return {
    line1: pick(display, ['address1']) || pick(comps, ['street', 'thoroughfare']),
    line2: pick(display, ['address2', 'address3']) || undefined,
    cityArea: pick(comps, ['locality']),
    state: pick(comps, ['administrative_area']),
    postalCode: pick(comps, ['postal_code']),
    country: iso3 === 'NGA' ? 'Nigeria' : iso3 || 'Nigeria',
    lat: lat !== undefined && !Number.isNaN(lat) ? lat : undefined,
    lng: lng !== undefined && !Number.isNaN(lng) ? lng : undefined,
    providerId,
  };
}

export const smarty: AddressProvider = {
  id: 'smarty',
  kind: 'both',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const qs = withAuth(new URLSearchParams({ country: COUNTRY, search: query, max_results: '10' }));
    const res = await fetchWithRetry(`${AUTO_BASE}?${qs.toString()}`);
    const body = await res.text();
    if (!res.ok) throw statusError(res.status, body);

    return firstArray(JSON.parse(body))
      .filter(isRecord)
      .map((it) => ({ label: pick(it, ['address_text']), providerId: pick(it, ['address_id']), raw: it }))
      .filter((s) => s.label.length > 0 && s.providerId.length > 0);
  },

  async retrieve(id: string): Promise<NormalizedResult> {
    // Address-id call returns subunit/entry details; take the first match.
    const qs = withAuth(new URLSearchParams({ country: COUNTRY }));
    const res = await fetchWithRetry(`${AUTO_BASE}/${encodeURIComponent(id)}?${qs.toString()}`);
    const body = await res.text();
    if (!res.ok) throw statusError(res.status, body);

    const data = JSON.parse(body) as unknown;
    const item = firstArray(data).filter(isRecord)[0];
    if (!item) throw new Error('Smarty: no completion detail');
    return {
      canonical: {
        line1: pick(item, ['street']),
        cityArea: pick(item, ['locality']),
        state: pick(item, ['administrative_area']),
        postalCode: pick(item, ['postal_code']),
        country: 'Nigeria',
        providerId: id,
      },
      raw: data,
    };
  },

  async verify(input: VerifyInput): Promise<NormalizedResult> {
    // geocode=true rides Global Geocoding — a separate paid subscription that
    // 402s on trial accounts (verified live: `id 1588026162`, and the error
    // body does not mention geocode, so a retry heuristic can't rely on it).
    // Omit it: plain verification succeeds on the Address Verification trial.
    const qs = withAuth(
      new URLSearchParams({
        country: COUNTRY,
        address1: input.line1,
        address2: input.line2 ?? '',
        locality: input.cityArea ?? '',
        administrative_area: input.state ?? '',
        postal_code: input.postalCode ?? '',
        ...(GEOCODE ? { geocode: 'true' } : {}),
      }),
    );
    const res = await fetchWithRetry(`${VERIFY_URL}?${qs.toString()}`);
    const body = await res.text();
    if (!res.ok) throw statusError(res.status, body);

    const data = JSON.parse(body) as unknown;
    const item = firstArray(data).filter(isRecord)[0];
    if (!item) throw noMatchError('Smarty: no match for address');
    const comps = isRecord(item.components) ? item.components : item;
    return { canonical: canonicalFrom(item, comps, geoOf(item), 'smarty'), raw: data };
  },
};