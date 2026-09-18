// Cross-vendor "machine verdict" normalizer.
//
// Each verification vendor reports its own quality signal in its own schema.
// This maps the raw verify output into ONE enum so analysis queries can
// compare providers directly:
//
//   provider_status: 'verified' | 'partial' | 'ambiguous' | 'none'
//
// 'none' = the vendor gave no clear verification verdict (e.g. PostGrid's
// "undeliverable", Smarty's missing analysis). The raw output jsonb is
// always stored alongside, so nothing is lost — the enum is just the index.
//
// Mappings below are grounded in live responses for smarty (2026-02-16),
// loqate (2026-02-16 probe: AVC "V22-I44-P0-100"), postgrid (openapi +
// live probe) and precisely (2026-02-16 live verify probes: score 95/ADDRESS
// → 50/ADMIN).

import type { ProviderId } from './providers/meta';

export type ProviderStatus = 'verified' | 'partial' | 'ambiguous' | 'none';

export const PROVIDER_STATUSES: readonly ProviderStatus[] = [
  'verified',
  'partial',
  'ambiguous',
  'none',
];

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
  if (depth > 5) return [];
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

/** First record satisfying `test`, descending wrappers depth-first. */
function firstRecordWith(
  node: unknown,
  test: (rec: Record<string, unknown>) => boolean,
  depth = 0,
): Record<string, unknown> {
  if (depth > 5) return {};
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = firstRecordWith(v, test, depth + 1);
      if (Object.keys(r).length > 0) return r;
    }
    return {};
  }
  if (isRecord(node)) {
    if (test(node)) return node;
    for (const v of Object.values(node)) {
      if (isRecord(v) || Array.isArray(v)) {
        const r = firstRecordWith(v, test, depth + 1);
        if (Object.keys(r).length > 0) return r;
      }
    }
  }
  return {};
}

function smarty(raw: unknown): ProviderStatus {
  // item.analysis.verification_status ∈ { Verified, Partial, Ambiguous }
  const item = firstArray(raw).filter(isRecord)[0];
  const analysis = isRecord(item?.analysis) ? item.analysis : {};
  return mapExact(pick(analysis, ['verification_status']).toLowerCase());
}

function loqate(raw: unknown): ProviderStatus {
  // Probe (2026-02-16): match has AVC "V22-I44-P0-100" — the leading letter
  // is the verification class (V verified, G ambiguous). No MatchType field
  // exists on the international response; AQI is a quality grade (A–F).
  const entry = firstArray(raw).filter(isRecord)[0];
  // Matches is an ARRAY — firstArray passes arrays through untouched, so pass it
  // directly (isRecord(array) is false, which would always fall back to []).
  const match = firstArray(entry?.Matches).filter(isRecord)[0];
  const avc = pick(match ?? {}, ['AVC']).toUpperCase();
  if (avc.startsWith('V')) return 'verified';
  if (avc.startsWith('G')) return 'ambiguous';
  return 'none';
}

function postgrid(raw: unknown): ProviderStatus {
  // data.summary.verificationStatus; "undeliverable"/"unverified" →
  // 'none' (raw keeps the exact term).
  const rec = firstRecordWith(raw, (r) => isRecord(r.summary));
  const summary = isRecord(rec.summary) ? rec.summary : {};
  return mapExact(pick(summary, ['verificationStatus']).toLowerCase());
}

function precisely(raw: unknown): ProviderStatus {
  // POST /v1/verify -> { responses: [{ status, results: [ {
  //   score, explanation.addressMatch.type } ] }] }
  // Live-probed enum (14 Admiralty Way W etc.):
  //   ADDRESS = addressNumber + street + city EXACT  -> verified  (score 95)
  //   STREET  = street matched, number absent or wrong -> partial (86..97)
  //   ADMIN   = city/neighborhood only, street NONE   -> partial (score 50)
  //   ZERO_RESULTS / non-OK / no results              -> none
  // score alone is not the verdict (ADMIN scores 50, STREET up to 97), so the
  // explicit match type carries the semantics; score stays in raw output.
  const responses = isRecord(raw) && Array.isArray(raw.responses) ? raw.responses : [];
  const first = responses.filter(isRecord)[0];
  if (!first) return 'none';
  const item = (Array.isArray(first.results) ? first.results : []).filter(isRecord)[0];
  if (!item) return 'none';
  const explanation = isRecord(item.explanation) ? item.explanation : {};
  const addressMatch = isRecord(explanation.addressMatch) ? explanation.addressMatch : {};
  switch (pick(addressMatch, ['type']).toUpperCase()) {
    case 'ADDRESS':
      return 'verified';
    case 'STREET':
      return 'partial';
    case 'ADMIN':
      return 'partial';
    default:
      return 'none';
  }
}

function geoapify(raw: unknown): ProviderStatus {
  // Category B — geocoded/heuristic match, NOT a postal-database verdict.
  // A feature's properties.rank.match_type classifies placement quality:
  //   full_match   -> exact match at the requested level   -> verified
  //   same_street  -> street matched, number/locality off -> partial
  //   nearest_place / fallback_match                      -> none
  // rank.confidence (0..1) rides along in the raw output — a graded guess,
  // not a deliverability confirmation (postcodes are often absent in NG).
  const feature = firstArray(raw).filter(isRecord)[0];
  if (!feature) return 'none';
  const props = isRecord(feature.properties) ? feature.properties : feature;
  const rank = isRecord(props.rank) ? props.rank : {};
  switch (pick(rank, ['match_type']).toLowerCase()) {
    case 'full_match':
      return 'verified';
    case 'same_street':
      return 'partial';
    default:
      return 'none';
  }
}

function mapExact(lowercased: string): ProviderStatus {
  if (lowercased === 'verified') return 'verified';
  if (lowercased === 'partial') return 'partial';
  if (lowercased === 'ambiguous') return 'ambiguous';
  return 'none';
}

export function providerStatus(providerId: string, raw: unknown): ProviderStatus {
  switch (providerId as ProviderId) {
    case 'smarty':
      return smarty(raw);
    case 'loqate':
      return loqate(raw);
    case 'postgrid':
      return postgrid(raw);
    case 'precisely':
      return precisely(raw);
    case 'geoapify':
      return geoapify(raw);
    default:
      return 'none';
  }
}