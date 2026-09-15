import type { AddressProvider } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey } from '../config';
import { fetchWithRetry } from '../http';

// Melissa Global Address Verification (cloud V3) adapter — capture only.
// Live-confirmed contract (2026-02-16, docs.melissa.com quickstart):
//   GET https://address.melissadata.net/V3/WEB/GlobalAddress/doGlobalAddress
//     ?id=<license>&format=JSON&act=st|vi&search=<q>&ct=NG&a1=..&a2=..&a3=..&a4=..
//   JSON envelope: { Version, TransmissionResults, TotalRecords, Records: [] }
// The old host (globaladdress.melissadata.net) no longer resolves anywhere.
// TransmissionResults: "SSxx" = success; "GExx" = license/coverage error.
// NOTE: the user's Q-... key currently returns GE03/GE08 on V3 → license
// mismatch to confirm against the Melissa dashboard (Customer ID/digest vs
// api key). That code is surfaced verbatim in the UI.

const API_URL = 'https://address.melissadata.net/V3/WEB/GlobalAddress/doGlobalAddress';

interface MelissaItem {
  RecordID?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  City?: string;
  State?: string;
  StateProvince?: string;
  Postal?: string;
  PostalCode?: string;
  CountryName?: string;
  Latitude?: string | number;
  Longitude?: string | number;
  Fields?: { Name?: string; Value?: string }[];
  [key: string]: unknown;
}

interface MelissaResponse {
  TransmissionResults?: string;
  Records?: MelissaItem[];
  [key: string]: unknown;
}

function fieldValue(item: MelissaItem, name: string): string {
  const direct = item[name];
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'number' && !Number.isNaN(direct)) return `${direct}`;
  return (item.Fields ?? []).find((f) => f.Name === name)?.Value ?? '';
}

function parseCoord(value: string | number | undefined): number | undefined {
  const n = parseFloat(`${value ?? ''}`);
  return Number.isNaN(n) ? undefined : n;
}

function assertOk(data: MelissaResponse): void {
  const code = data.TransmissionResults ?? '';
  // GE## codes = license/coverage failures (GE03 invalid key/action, GE05,
  // GE08). Treat any other (or missing) code as OK so empty trials still
  // produce an empty suggestion list rather than an error.
  if (/^GE/.test(code)) {
    throw new Error(`Melissa ${code} (see Melissa dashboard for key type/Customer ID)`);
  }
}

export const melissa: AddressProvider = {
  id: 'melissa',
  kind: 'capture',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const url = new URL(API_URL);
    url.searchParams.set('id', getKey('melissa'));
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('act', 'st');
    url.searchParams.set('search', query);
    url.searchParams.set('ct', 'NG');
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Melissa search ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as MelissaResponse;
    assertOk(data);

    return (data.Records ?? [])
      .map((it) => ({
        label: [
          fieldValue(it, 'AddressLine1') || fieldValue(it, 'Place') || fieldValue(it, 'PlaceName'),
          fieldValue(it, 'City'),
          fieldValue(it, 'StateProvince') || fieldValue(it, 'State'),
          fieldValue(it, 'Postal') || fieldValue(it, 'PostalCode'),
        ]
          .filter(Boolean)
          .join(', '),
        providerId:
          fieldValue(it, 'RecordID') || fieldValue(it, 'MelissaRecordID') || fieldValue(it, 'ID'),
        raw: it,
      }))
      .filter((s) => s.label.length > 0 && s.providerId.length > 0);
  },

  async retrieve(id: string): Promise<NormalizedResult> {
    const url = new URL(API_URL);
    url.searchParams.set('id', getKey('melissa'));
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('act', 'vi');
    url.searchParams.set('id3', id);
    url.searchParams.set('ct', 'NG');
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Melissa verify-by-id ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as MelissaResponse;
    assertOk(data);
    const it = data.Records?.[0];
    if (!it) throw new Error('Melissa: no record for id');

    const canonical: CanonicalAddress = {
      line1: fieldValue(it, 'AddressLine1'),
      line2: fieldValue(it, 'AddressLine2') || undefined,
      cityArea: fieldValue(it, 'City'),
      state: fieldValue(it, 'StateProvince') || fieldValue(it, 'State'),
      postalCode: fieldValue(it, 'Postal') || fieldValue(it, 'PostalCode'),
      country: fieldValue(it, 'CountryName') || 'Nigeria',
      lat: parseCoord(fieldValue(it, 'Latitude')),
      lng: parseCoord(fieldValue(it, 'Longitude')),
      providerId: fieldValue(it, 'RecordID') || id,
    };
    return { canonical, raw: data };
  },
};