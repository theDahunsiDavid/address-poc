import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { VERIFY_PROVIDERS, type ProviderId, type VerifyCategory } from '@/lib/providers/meta';
import type { CanonicalAddress } from '@/lib/schema';
import type { ProviderStatus } from '@/lib/verdict';
import type { CapturePick } from './CaptureColumn';

// Leaflet touches window — must never run on the server.
const MapPin = dynamic(() => import('@/components/MapPin'), { ssr: false });

// Verify providers are grouped by the claim their result makes: a
// postal/reference-database verdict (A) vs a geocoded heuristic match (B) —
// "the postal DB confirms it" and "there is plausibly a matching location on
// a map" are different forms of truth, so they get separate headers.
const VERIFY_GROUP_LABELS: { cat: VerifyCategory; label: string }[] = [
  { cat: 'postal', label: 'A — Postal / database verification' },
  { cat: 'geocoded', label: 'B — Geocoded / heuristic validation' },
];
const UNCATEGORIZED_VERIFY = VERIFY_PROVIDERS.filter((p) => !p.verifyCategory);

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

interface VerifyResponse {
  ok: boolean;
  canonical?: CanonicalAddress;
  raw?: unknown;
  serverMs?: number;
  providerStatus?: ProviderStatus;
  error?: string;
}

interface LogResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

interface VerifiedResult {
  canonical: CanonicalAddress;
  raw: unknown;
  serverMs: number;
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

type Verdict = 'correct' | 'incorrect' | null;

// Verify column. Input = one address line (required) + optional structured
// fields; country is fixed to Nigeria. Capture selections pre-fill the form
// (prefill prop); results can be judged correct/incorrect, which updates the
// logged verify event in place.

export default function VerifyColumn({ prefill }: { prefill: CapturePick | null }) {
  const [provider, setProvider] = useState<ProviderId>('loqate');
  const [statusMap, setStatusMap] = useState<Record<string, StatusRow> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [cityArea, setCityArea] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [showOptional, setShowOptional] = useState(false);
  const [result, setResult] = useState<VerifiedResult | null>(null);
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [verifying, setVerifying] = useState(false);
  const [openRaw, setOpenRaw] = useState(false);
  const [vLat, setVLat] = useState<{ server?: number; e2e?: number }>({});
  const eventIdRef = useRef<string | null>(null);

  // Key status for all providers; fetched once.
  useEffect(() => {
    getJson<StatusResponse>('/api/status')
      .then((res) => setStatusMap(Object.fromEntries(res.providers.map((p) => [p.id, p]))))
      .catch(() => setNotice('failed to load provider status'));
  }, []);

  // Reset result/notice on provider change; keep what the user typed.
  useEffect(() => {
    setNotice(null);
    setResult(null);
    setVerdict(null);
    setOpenRaw(false);
    setVLat({});
    eventIdRef.current = null;
    const st = statusMap?.[provider];
    if (st && !st.supported) setNotice('provider adapter not wired yet');
    else if (st && st.status === 'missing') setNotice('trial key missing');
  }, [provider, statusMap]);

  // Capture selection pre-fills the form; a fresh object per pick re-runs this.
  useEffect(() => {
    if (!prefill) return;
    const c = prefill.canonical;
    setLine1(c.line1);
    setLine2(c.line2 ?? '');
    setCityArea(c.cityArea);
    setState(c.state);
    setPostalCode(c.postalCode);
    setShowOptional(Boolean(c.line2 || c.cityArea || c.state || c.postalCode));
    setResult(null);
    setVerdict(null);
    setNotice(null);
    setOpenRaw(false);
    eventIdRef.current = null;
  }, [prefill]);

  /** True while the form still holds exactly the capture's canonical fields. */
  function matchesPrefill(): boolean {
    const c = prefill?.canonical;
    if (!c) return false;
    return (
      line1.trim() === c.line1 &&
      (line2.trim() || '') === (c.line2 ?? '') &&
      (cityArea.trim() || '') === (c.cityArea ?? '') &&
      (state.trim() || '') === (c.state ?? '') &&
      (postalCode.trim() || '') === (c.postalCode ?? '')
    );
  }

  function enteredFields(): Record<string, string> {
    return {
      line1: line1.trim(),
      ...(line2.trim() ? { line2: line2.trim() } : {}),
      ...(cityArea.trim() ? { cityArea: cityArea.trim() } : {}),
      ...(state.trim() ? { state: state.trim() } : {}),
      ...(postalCode.trim() ? { postalCode: postalCode.trim() } : {}),
    };
  }

  async function runVerify() {
    const l1 = line1.trim();
    if (!l1) {
      setNotice('line1 is required');
      return;
    }
    const captureEventId = matchesPrefill() ? (prefill?.captureEventId ?? undefined) : undefined;
    const input = enteredFields();
    const start = performance.now();
    setVerifying(true);
    setNotice(null);
    try {
      const res = await postJson<VerifyResponse>(`/api/verify?provider=${provider}`, {
        line1,
        line2,
        cityArea,
        state,
        postalCode,
      });
      if (res.ok && res.canonical) {
        setResult({ canonical: res.canonical, raw: res.raw ?? null, serverMs: res.serverMs ?? 0 });
        setVLat({ server: res.serverMs, e2e: Math.round(performance.now() - start) });
        setVerdict(null);
        const logged = await postJson<LogResponse>('/api/log', {
          kind: 'verify',
          event: {
            input,
            provider,
            output: res.raw ?? null,
            provider_status: res.providerStatus ?? 'none',
            user_verified: null,
            capture_event_id: captureEventId,
          },
        });
        if (logged.ok && logged.id) eventIdRef.current = logged.id;
      } else {
        setNotice(res.error ?? 'verify failed');
        // Log failures too — vendor errors are analysis data (e.g. Precisely's
        // OAuth rejection shows up in verify_events, not just the console).
        postJson('/api/log', {
          kind: 'verify',
          event: {
            input,
            provider,
            output: { error: res.error ?? 'verify failed' },
            provider_status: 'none',
            user_verified: null,
            capture_event_id: captureEventId,
          },
        });
      }
    } catch {
      setNotice('verify request failed');
    } finally {
      setVerifying(false);
    }
  }

  function markVerdict(v: Exclude<Verdict, null>) {
    setVerdict((prev) => {
      const next = prev === v ? null : v;
      if (eventIdRef.current) {
        postJson('/api/log', {
          action: 'update',
          kind: 'verify',
          id: eventIdRef.current,
          user_verified: next === null ? null : next === 'correct',
        });
      }
      return next;
    });
  }

  const status = statusMap?.[provider];

  return (
    <section className="column">
      <h2>Verify</h2>

      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
          {VERIFY_GROUP_LABELS.map((g) => (
            <optgroup key={g.cat} label={g.label}>
              {VERIFY_PROVIDERS.filter((p) => p.verifyCategory === g.cat).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
          {UNCATEGORIZED_VERIFY.length > 0 && (
            <optgroup label="Other">
              {UNCATEGORIZED_VERIFY.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <p className="muted">
        A: database/postal verification · B: geocoded/heuristic (a plausible location on a map, not a
        deliverability guarantee)
      </p>

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
        placeholder="Enter an address line…"
        value={line1}
        onChange={(e) => setLine1(e.target.value)}
      />

      <button type="button" className="link" onClick={() => setShowOptional(!showOptional)}>
        {showOptional ? 'hide optional fields' : 'optional fields (better matches)'}
      </button>
      {showOptional && (
        <div className="verify-fields">
          <label>
            <span>line2</span>
            <input type="text" value={line2} onChange={(e) => setLine2(e.target.value)} />
          </label>
          <label>
            <span>city / area</span>
            <input type="text" value={cityArea} onChange={(e) => setCityArea(e.target.value)} />
          </label>
          <label>
            <span>state</span>
            <input type="text" value={state} onChange={(e) => setState(e.target.value)} />
          </label>
          <label>
            <span>postal code</span>
            <input type="text" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </label>
        </div>
      )}

      <button
        type="button"
        className="btn"
        onClick={runVerify}
        disabled={verifying || (status ? status.status === 'missing' || !status.supported : false)}
      >
        {verifying ? 'verifying…' : 'Verify'}
      </button>

      <p className="muted">
        verify lat: {verifying ? '…' : vLat.server != null ? `${vLat.server} ms server / ${vLat.e2e} ms e2e` : '—'}
      </p>

      {result && (
        <>
          <dl className="blob">
            <dt>line1</dt>
            <dd>{result.canonical.line1 || '—'}</dd>
            <dt>line2</dt>
            <dd>{result.canonical.line2 || '—'}</dd>
            <dt>city/area</dt>
            <dd>{result.canonical.cityArea || '—'}</dd>
            <dt>state</dt>
            <dd>{result.canonical.state || '—'}</dd>
            <dt>postal code</dt>
            <dd>{result.canonical.postalCode || '—'}</dd>
            <dt>country</dt>
            <dd>{result.canonical.country || '—'}</dd>
            <dt>lat / lng</dt>
            <dd>
              {result.canonical.lat != null ? `${result.canonical.lat} / ${result.canonical.lng}` : '—'}
            </dd>
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
          <MapPin address={result.canonical} />
          <button type="button" className="link" onClick={() => setOpenRaw(!openRaw)}>
            {openRaw ? 'hide raw output' : 'raw output'}
          </button>
          {openRaw && <pre className="raw">{JSON.stringify(result.raw, null, 2)}</pre>}
        </>
      )}
    </section>
  );
}