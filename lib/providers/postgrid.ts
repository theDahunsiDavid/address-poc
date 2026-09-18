import type { AddressProvider, VerifyInput } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey } from '../config';
import { fetchWithRetry } from '../http';
import { noMatchError } from '../errors';

// PostGrid (https://postgrid.com) adapter — capture + verify.
// Contract extracted from their public OpenAPI (guides.postgrid.com/api/openapi.yaml)
// and live-probed (2026-02-16):
//   Base https://api.postgrid.com, auth header x-api-key (test_.../live_...).
//   CAPTURE (free text search, then 1 lookup to resolve):
//     GET  /v1/intl_addver/completions?partialStreet=<q>&countriesFilter=<ISO2>
//          -> IntlAddressPreview items: { id, type, preview:{address,city,pc,prov} }
//          type=="Address" results resolve via their id; other types are
//          buildings/complexes requiring a follow-up (drill-down) call.
//     POST /v1/intl_addver/completions   { id } -> IntlAddressCompletion
//   VERIFY (1 lookup):
//     POST /v1/intl_addver/verifications?geoData=true
//          body { "address": "<freeform single line>" }  (freeform form)
//          or structured { "address": { line1, city, provinceOrState,
//          postalOrZip, country (ISO2/3) } }  -> VerifiedAddress with
//          status/summary/geoData.
//   Note: sandbox probe of the verify route got connection-reset (exit 56)
//   while completions routes answered cleanly — unknown WAF behavior; the
//   user's live test decides. Its own sandbox limitation, not the contract.

const BASE = 'https://api.postgrid.com';
const COMPLETIONS_URL = `${BASE}/v1/intl_addver/completions`;
const VERIFY_URL = `${BASE}/v1/intl_addver/verifications`;

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

/** First object that looks like an address payload, descending wrappers. */
function firstAddressRecord(node: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};
  if (Array.isArray(node)) return firstAddressRecord(node[0], depth + 1);
  if (isRecord(node)) {
    if (pick(node, ['line1', 'address']) || pick(node, ['city', 'formattedAddress'])) {
      return node;
    }
    for (const v of Object.values(node)) {
      if (isRecord(v) || Array.isArray(v)) {
        const r = firstAddressRecord(v, depth + 1);
        if (Object.keys(r).length > 0) return r;
      }
    }
  }
  return {};
}

function toCanonical(
  rec: Record<string, unknown>,
  providerId: string,
  geo?: Record<string, unknown>,
): CanonicalAddress {
  const latS = pick(geo ?? {}, ['latitude', 'lat']);
  const lngS = pick(geo ?? {}, ['longitude', 'lng']);
  const lat = latS ? parseFloat(latS) : undefined;
  const lng = lngS ? parseFloat(lngS) : undefined;
  return {
    line1: pick(rec, ['line1']),
    line2: pick(rec, ['line2', 'line3']) || undefined,
    cityArea: pick(rec, ['city']),
    state: pick(rec, ['provinceOrState', 'provinceCode']),
    postalCode: pick(rec, ['postalOrZip']),
    country: pick(rec, ['countryName', 'country']) || 'Nigeria',
    lat: lat !== undefined && !Number.isNaN(lat) ? lat : undefined,
    lng: lng !== undefined && !Number.isNaN(lng) ? lng : undefined,
    providerId,
  };
}

export const postgrid: AddressProvider = {
  id: 'postgrid',
  kind: 'both',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const qs = new URLSearchParams({ partialStreet: query, countriesFilter: 'NG', limit: '10' });
    const res = await fetchWithRetry(`${COMPLETIONS_URL}?${qs.toString()}`, {
      headers: { 'x-api-key': getKey('postgrid') },
    });
    if (!res.ok) throw new Error(`PostGrid autocomplete ${res.status}: ${await res.text()}`);

    const items = firstArray(await res.json())
      .filter(isRecord)
      .filter((it) => !pick(it, ['error']));
    // Prefer directly-resolvable results (type Address; POST /completions
    // resolves their id). If Nigeria returns none (e.g. only buildings/
    // complexes, type Container), still surface the best-effort matches.
    const addressLike = items.filter((it) => pick(it, ['type']) === 'Address');
    const candidates = addressLike.length > 0 ? addressLike : items;

    return candidates
      .map((it) => {
        // International preview schema: { id, type, text, highlight, description }.
        // (The nested preview:{address,...} shape only exists on the US/CA api.)
        const p = isRecord(it.preview) ? it.preview : {};
        const label = [pick(it, ['text']) || pick(p, ['address']), pick(it, ['description']) || pick(p, ['city'])]
          .filter(Boolean)
          .join(', ');
        return { label, providerId: pick(it, ['id']), raw: it };
      })
      .filter((s) => s.label.length > 0 && s.providerId.length > 0);
  },

  async retrieve(id: string): Promise<NormalizedResult> {
    const res = await fetchWithRetry(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'x-api-key': getKey('postgrid'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`PostGrid retrieve ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as unknown;
    const rec = firstAddressRecord(data);
    const err = pick(rec, ['error']);
    if (err) throw new Error(`PostGrid retrieve: ${err}`);
    if (Object.keys(rec).length === 0) throw new Error('PostGrid: no completion record');
    return { canonical: toCanonical(rec, id), raw: data };
  },

  async verify(input: VerifyInput): Promise<NormalizedResult> {
    const iso = input.country.toUpperCase() === 'NIGERIA' ? 'NG' : input.country;
    // Freeform form: a single address line the intl verifier parses itself.
    // (Structured form — { address: { line1, city, provinceOrState,
    // postalOrZip, country } } — is the alternative if freeform misparses.)
    const addressString = [input.line1, input.line2, input.cityArea, input.state, input.postalCode, iso]
      .filter(Boolean)
      .join(', ');

    const res = await fetchWithRetry(`${VERIFY_URL}?geoData=true`, {
      method: 'POST',
      headers: {
        'x-api-key': getKey('postgrid'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ address: addressString }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PostGrid verify ${res.status}: ${text}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`PostGrid verify: non-JSON response ${text}`);
    }
    const rec = firstAddressRecord(json);
    if (Object.keys(rec).length === 0) throw noMatchError('PostGrid: no verified address');
    const geo = isRecord(rec.geoData) ? rec.geoData : {};
    return { canonical: toCanonical(rec, 'postgrid', geo), raw: json };
  },
};