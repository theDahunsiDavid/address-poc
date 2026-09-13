import { useEffect, useRef, useState } from 'react';
import { CAPTURE_PROVIDERS, type ProviderId } from '@/lib/providers/meta';
import type { CanonicalAddress, Suggestion } from '@/lib/schema';

interface StatusRow {
  id: ProviderId;
  name: string;
  kind: string;
  supported: boolean;
  status: 'configured' | 'missing';
  details: { freeTier: string; perLookupPrice: string; minimumCommitment: string };
}

interface StatusResponse {
  providers: StatusRow[];
}

interface AutocompleteResponse {
  ok: boolean;
  suggestions?: Suggestion[];
  serverMs?: number;
  error?: string;
}

interface RetrieveResponse {
  ok: boolean;
  canonical?: CanonicalAddress;
  raw?: unknown;
  serverMs?: number;
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

export default function CaptureColumn() {
  const [provider, setProvider] = useState<ProviderId>('google');
  const [statusMap, setStatusMap] = useState<Record<string, StatusRow> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CanonicalAddress | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [openRaw, setOpenRaw] = useState(false);
  const [acLat, setAcLat] = useState<{ server?: number; e2e?: number }>({});
  const [rtLat, setRtLat] = useState<{ server?: number; e2e?: number }>({});
  const seq = useRef(0);
  const lastPick = useRef('');

  // Key status for all providers; fetched once.
  useEffect(() => {
    getJson<StatusResponse>('/api/status')
      .then((res) => setStatusMap(Object.fromEntries(res.providers.map((p) => [p.id, p]))))
      .catch(() => setNotice('failed to load provider status'));
  }, []);

  // Reset state and show the key-status notice immediately on provider select.
  useEffect(() => {
    setNotice(null);
    setQuery('');
    setOptions([]);
    setSelected(null);
    setRaw(null);
    setAcLat({});
    setRtLat({});
    lastPick.current = '';
    const st = statusMap?.[provider];
    if (st && !st.supported) setNotice('provider adapter not wired yet');
    else if (st && st.status === 'missing') setNotice('trial key missing');
  }, [provider, statusMap]);

  // Debounced typeahead.
  useEffect(() => {
    const st = statusMap?.[provider];
    if (!query.trim() || !st?.supported || st.status === 'missing' || query.trim() === lastPick.current) {
      setOptions([]);
      return;
    }
    const timer = setTimeout(async () => {
      const call = ++seq.current;
      const start = performance.now();
      try {
        const res = await getJson<AutocompleteResponse>(
          `/api/autocomplete?provider=${provider}&q=${encodeURIComponent(query.trim())}`,
        );
        if (seq.current !== call) return;
        if (res.ok) {
          setOptions(res.suggestions ?? []);
          setAcLat({ server: res.serverMs, e2e: Math.round(performance.now() - start) });
        } else {
          setNotice(res.error ?? 'autocomplete failed');
        }
      } catch {
        if (seq.current === call) setNotice('autocomplete request failed');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, provider, statusMap]);

  async function handlePick(s: Suggestion) {
    setQuery(s.label);
    setOptions([]);
    lastPick.current = s.label;
    const start = performance.now();
    setLoading(true);
    try {
      const res = await getJson<RetrieveResponse>(
        `/api/retrieve?provider=${provider}&id=${encodeURIComponent(s.providerId)}`,
      );
      if (res.ok && res.canonical) {
        setSelected(res.canonical);
        setRaw(res.raw ?? null);
        setRtLat({ server: res.serverMs, e2e: Math.round(performance.now() - start) });
      } else {
        setNotice(res.error ?? 'retrieve failed');
      }
    } catch {
      setNotice('retrieve request failed');
    } finally {
      setLoading(false);
    }
  }

  const status = statusMap?.[provider];

  return (
    <section className="column">
      <h2>Capture</h2>

      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
          {CAPTURE_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {notice && <p className="notice">{notice}</p>}

      {status && (
        <button type="button" className="link" onClick={() => setShowDetails(!showDetails)}>
          {showDetails ? 'hide provider details' : 'provider details'}
        </button>
      )}
      {showDetails && status && (
        <dl className="blob">
          <dt>free tier</dt>
          <dd>{status.details.freeTier || '—'}</dd>
          <dt>per lookup</dt>
          <dd>{status.details.perLookupPrice || '—'}</dd>
          <dt>minimum commitment</dt>
          <dd>{status.details.minimumCommitment || '—'}</dd>
        </dl>
      )}

      <input
        type="text"
        placeholder="Type an address…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {options.length > 0 && (
        <ul className="suggestions">
          {options.map((s, i) => (
            <li key={i}>
              <button onClick={() => handlePick(s)}>{s.label}</button>
            </li>
          ))}
        </ul>
      )}

      <p className="muted">
        autocomplete lat: {acLat.server != null ? `${acLat.server} ms server / ${acLat.e2e} ms e2e` : '—'}
      </p>
      <p className="muted">
        retrieve lat:{' '}
        {loading ? '…' : rtLat.server != null ? `${rtLat.server} ms server / ${rtLat.e2e} ms e2e` : '—'}
      </p>

      {selected && (
        <>
          <dl className="blob">
            <dt>line1</dt>
            <dd>{selected.line1 || '—'}</dd>
            <dt>line2</dt>
            <dd>{selected.line2 || '—'}</dd>
            <dt>city/area</dt>
            <dd>{selected.cityArea || '—'}</dd>
            <dt>state</dt>
            <dd>{selected.state || '—'}</dd>
            <dt>postal code</dt>
            <dd>{selected.postalCode || '—'}</dd>
            <dt>country</dt>
            <dd>{selected.country || '—'}</dd>
            <dt>lat / lng</dt>
            <dd>{selected.lat != null ? `${selected.lat} / ${selected.lng}` : '—'}</dd>
            <dt>provider id</dt>
            <dd>{selected.providerId || '—'}</dd>
          </dl>
          <button type="button" className="link" onClick={() => setOpenRaw(!openRaw)}>
            {openRaw ? 'hide raw output' : 'raw output'}
          </button>
          {openRaw && raw != null && <pre className="raw">{JSON.stringify(raw, null, 2)}</pre>}
        </>
      )}
    </section>
  );
}