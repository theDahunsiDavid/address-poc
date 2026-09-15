import type { AddressProvider, VerifyInput } from './types';
import type { CanonicalAddress, NormalizedResult, Suggestion } from '../schema';
import { getKey } from '../config';
import { fetchWithRetry } from '../http';

// Loqate adapter — capture (Interactive Find / Retrieve v1.10, json3.ws) and
// verify (Cleansing International Batch v1.20, json6.ws POST). Nigeria via
// Countries=NG (capture) / Country=NGA (verify). Endpoint paths confirmed
// against docs.loqate.com (2026) and the live platform.

const FIND_URL = 'https://api.addressy.com/Capture/Interactive/Find/v1.10/json3.ws';
const RETRIEVE_URL = 'https://api.addressy.com/Capture/Interactive/Retrieve/v1.10/json3.ws';
const VERIFY_URL = 'https://api.addressy.com/Cleansing/International/Batch/v1.20/json6.ws';

interface FindItem {
  Id: string;
  Type?: string;
  Text?: string;
  Description?: string;
}

interface FindResponse {
  Items?: FindItem[];
  error?: string;
}

// Retrieve returns Item-formatted fields as Field1..Field8 (set via the
// FieldNFormat request params).
interface RetrieveItem {
  Id: string;
  Field1?: string;
  Field2?: string;
  Field3?: string;
  Field4?: string;
  Field5?: string;
  Field6?: string;
  Field7?: string;
  Field8?: string;
}

interface RetrieveResponse {
  Items?: RetrieveItem[];
}

interface VerifyMatch {
  Latitude?: string;
  Longitude?: string;
  Address1?: string;
  Address2?: string;
  Locality?: string;
  AdministrativeArea?: string;
  PostalCode?: string;
  CountryName?: string;
  AVC?: string;
  AQI?: string;
}

interface VerifyEntry {
  Input?: Record<string, string>;
  Matches?: VerifyMatch[];
}

// Verify responds with a JSON *array* (one entry per input address), not the
// JSON3 object envelope used by Find/Retrieve.
type VerifyResponse = VerifyEntry[];

function clean(v: string | undefined): string {
  return v && v.trim() ? v.trim() : '';
}

function parseCoord(v: string | undefined): number | undefined {
  const n = parseFloat(v ?? '');
  return Number.isNaN(n) ? undefined : n;
}

export const loqate: AddressProvider = {
  id: 'loqate',
  kind: 'both',

  async autocomplete(query: string): Promise<Suggestion[]> {
    const url = new URL(FIND_URL);
    url.searchParams.set('Key', getKey('loqate'));
    url.searchParams.set('Text', query);
    url.searchParams.set('Countries', 'NG');
    url.searchParams.set('Limit', '10');
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Loqate find ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as FindResponse;

    return (data.Items ?? [])
      .map((item) => ({
        label: [item.Text, item.Description].filter(Boolean).join(', '),
        providerId: item.Id,
        raw: item,
      }))
      .filter((s) => s.label.length > 0 && s.providerId.length > 0);
  },

  async retrieve(id: string): Promise<NormalizedResult> {
    const url = new URL(RETRIEVE_URL);
    url.searchParams.set('Key', getKey('loqate'));
    url.searchParams.set('Id', id);
    url.searchParams.set('Field1Format', '{Line1}');
    url.searchParams.set('Field2Format', '{Line2}');
    url.searchParams.set('Field3Format', '{City}');
    url.searchParams.set('Field4Format', '{Province}');
    url.searchParams.set('Field5Format', '{PostalCode}');
    url.searchParams.set('Field6Format', '{CountryName}');
    url.searchParams.set('Field7Format', '{Latitude}');
    url.searchParams.set('Field8Format', '{Longitude}');
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Loqate retrieve ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as RetrieveResponse;
    const item = data.Items?.[0];
    if (!item) throw new Error('Loqate retrieve: no data for id');

    const canonical: CanonicalAddress = {
      line1: clean(item.Field1),
      line2: clean(item.Field2) || undefined,
      cityArea: clean(item.Field3),
      state: clean(item.Field4),
      postalCode: clean(item.Field5),
      country: clean(item.Field6) || 'Nigeria',
      lat: parseCoord(item.Field7),
      lng: parseCoord(item.Field8),
      providerId: item.Id,
    };
    return { canonical, raw: data };
  },

  async verify(input: VerifyInput): Promise<NormalizedResult> {
    const res = await fetchWithRetry(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Key: getKey('loqate'),
        GeoCode: true,
        Addresses: [
          {
            Address1: input.line1,
            Address2: input.line2 ?? '',
            Locality: input.cityArea ?? '',
            AdministrativeArea: input.state ?? '',
            PostalCode: input.postalCode ?? '',
            Country: 'NGA',
          },
        ],
        Options: { Process: 'Verify' },
      }),
    });
    if (!res.ok) throw new Error(`Loqate verify ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as VerifyResponse;

    const match = data[0]?.Matches?.[0];
    if (!match) throw new Error('Loqate verify: no matches');

    const canonical: CanonicalAddress = {
      line1: clean(match.Address1),
      line2: clean(match.Address2) || undefined,
      cityArea: clean(match.Locality),
      state: clean(match.AdministrativeArea),
      postalCode: clean(match.PostalCode),
      country: clean(match.CountryName) || 'Nigeria',
      lat: parseCoord(match.Latitude),
      lng: parseCoord(match.Longitude),
    };
    return { canonical, raw: data };
  },
};