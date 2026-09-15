import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { CAPTURE_PROVIDERS, type ProviderId } from '@/lib/providers/meta';
import type { CanonicalAddress, Suggestion } from '@/lib/schema';

// Leaflet touches window — must never run on the server.
const MapPin = dynamic(() => import('@/components/MapPin'), { ssr: false });

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

interface LogResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

// A successful capture selection, handed to the parent so the Verify column
// can pre-fill its form and link back to this capture event.
export interface CapturePick {
  canonical: CanonicalAddress;
  captureEventId?: string;
}

type Verdict = 'correct' | 'incorrect' | null;

// Minimum meaningful query length for a dismissal to count as a miss.
const MIN_MISS_LENGTH = 3;

export default function CaptureColumn({ onPick }: { onPick: (pick: CapturePick) => void }) {
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
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [acLat, setAcLat] = useState<{ server?: number; e2e?: number }>({});
  const [rtLat, setRtLat] = useState<{ server?: number; e2e?: number }>({});
  const seq = useRef(0);
  const lastPick = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Interaction bookkeeping (one log event per interaction: pick or miss).
  const searchedRef = useRef(false); // an ok autocomplete response landed
  const listQueryRef = useRef(''); // query that produced the current list
  const suggestionsRef = useRef<Suggestion[]>([]); // list snapshot for miss output
  const pickingRef = useRef(false); // suggestion mousedown — suppress the blur miss
  const captureEventIdRef = useRef<string | null>(null);

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
    setOpenRaw(false);
    setVerdict(null);
    setAcLat({});
    setRtLat({});
    lastPick.current = '';
    searchedRef.current = false;
    listQueryRef.current = '';
    suggestionsRef.current = [];
    captureEventIdRef.current = null;
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
          // Even an empty list counts as "searched": dismissing it is a miss.
          searchedRef.current = true;
          listQueryRef.current = query.trim();
          suggestionsRef.current = res.suggestions ?? [];
        } else {
          setNotice(res.error ?? 'autocomplete failed');
        }
      } catch {
        if (seq.current === call) setNotice('autocomplete request failed');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, provider, statusMap]);

  // Dismissal without a pick = a miss (only when a real search landed).
  function logMiss() {
    if (pickingRef.current || !searchedRef.current) return;
    const typed = inputRef.current?.value ?? '';
    if (typed.trim().length < MIN_MISS_LENGTH) {
      searchedRef.current = false;
      return;
    }
    searchedRef.current = false;
    const listQuery = listQueryRef.current || typed;
    postJson('/api/log', {
      kind: 'capture',
      event: {
        typed_text: typed,
        list_query: listQuery,
        suggestion_label: null,
        selected: false,
        provider,
        output: suggestionsRef.current,
        user_verified: null,
      },
    });
  }

  async function handlePick(s: Suggestion) {
    pickingRef.current = false;
    const typed = inputRef.current?.value ?? '';
    const listQuery = listQueryRef.current || typed;
    searchedRef.current = false;
    setQuery(s.label);
    setOptions([]);
    lastPick.current = s.label;
    const start = performance.now();
    setLoading(true);
    setNotice(null);
    try {
      const res = await getJson<RetrieveResponse>(
        `/api/retrieve?provider=${provider}&id=${encodeURIComponent(s.providerId)}`,
      );
      if (res.ok && res.canonical) {
        setSelected(res.canonical);
        setRaw(res.raw ?? null);
        setVerdict(null);
        setRtLat({ server: res.serverMs, e2e: Math.round(performance.now() - start) });
        const logged = await postJson<LogResponse>('/api/log', {
          kind: 'capture',
          event: {
            typed_text: typed,
            list_query: listQuery,
            suggestion_label: s.label,
            selected: true,
            provider,
            output: res.raw ?? null,
            user_verified: null,
          },
        });
        if (logged.ok && logged.id) captureEventIdRef.current = logged.id;
        onPick({
          canonical: res.canonical,
          captureEventId: logged.ok && logged.id ? logged.id : undefined,
        });
      } else {
        setNotice(res.error ?? 'retrieve failed');
      }
    } catch {
      setNotice('retrieve request failed');
    } finally {
      setLoading(false);
    }
  }

  function markVerdict(v: Exclude<Verdict, null>) {
    setVerdict((prev) => {
      const next = prev === v ? null : v;
      if (captureEventIdRef.current) {
        postJson('/api/log', {
          action: 'update',
          kind: 'capture',
          id: captureEventIdRef.current,
          user_verified: next === null ? null : next === 'correct',
        });
      }
      return next;
    });
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
        ref={inputRef}
        type="text"
        placeholder="Type an address…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={logMiss}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            logMiss();
            setOptions([]);
          }
        }}
      />

      {options.length > 0 && (
        <ul className="suggestions">
          {options.map((s, i) => (
            <li key={i}>
              <button
                onMouseDown={() => {
                  pickingRef.current = true;
                }}
                onClick={() => handlePick(s)}
              >
                {s.label}
              </button>
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
          <div className="verdict">
            <span>output correct?</span>
            <button
              type="button"
              className={verdict === 'correct' ? 'on-correct' : ''}
              onClick={() => markVerdict('correct')}
            >
              ✓ correct
            </button>
            <button
              type="button"
              className={verdict === 'incorrect' ? 'on-incorrect' : ''}
              onClick={() => markVerdict('incorrect')}
            >
              ✗ incorrect
            </button>
          </div>
          <MapPin address={selected} />
          <button type="button" className="link" onClick={() => setOpenRaw(!openRaw)}>
            {openRaw ? 'hide raw output' : 'raw output'}
          </button>
          {openRaw && raw != null && <pre className="raw">{JSON.stringify(raw, null, 2)}</pre>}
        </>
      )}
    </section>
  );
}