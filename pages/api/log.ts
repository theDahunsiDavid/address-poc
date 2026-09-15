import type { NextApiRequest, NextApiResponse } from 'next';
import { getDb } from '@/lib/db';
import { PROVIDER_STATUSES, type ProviderStatus } from '@/lib/verdict';

// POST /api/log — writes interaction events to Supabase (server-only; the
// service-role key never leaves the server).
//   { kind: 'capture', event: {...} }         -> insert capture_events
//   { kind: 'verify',  event: {...} }         -> insert verify_events
//   { action: 'update', kind, id, user_verified } -> set user_verified on a row
// Logging is fire-and-forget from the client and must never break the UI:
// every failure returns { ok: false } over HTTP 200/400 rather than throwing.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= maxLen ? t : undefined;
}

function optStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function jsonSafe(v: unknown): boolean {
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed (POST only)' });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  try {
    // --- Verdict update: set user_verified on an existing event row. ---
    if (body.action === 'update') {
      const kind = body.kind;
      if (kind !== 'capture' && kind !== 'verify') {
        return res.status(400).json({ ok: false, error: 'kind must be capture|verify' });
      }
      const id = str(body.id, 64);
      if (!id || !UUID_RE.test(id)) {
        return res.status(400).json({ ok: false, error: 'id must be an event uuid' });
      }
      const uv = body.user_verified;
      if (uv !== null && typeof uv !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'user_verified must be boolean or null' });
      }
      const { error } = await getDb()
        .from(kind === 'capture' ? 'capture_events' : 'verify_events')
        .update({ user_verified: uv })
        .eq('id', id);
      if (error) return res.status(200).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    // --- Event insert. ---
    const kind = body.kind;
    if (kind !== 'capture' && kind !== 'verify') {
      return res.status(400).json({ ok: false, error: 'kind must be capture|verify' });
    }
    const ev = (body.event ?? {}) as Record<string, unknown>;

    const provider = str(ev.provider, 64);
    if (!provider) return res.status(400).json({ ok: false, error: 'event.provider required' });
    if (!jsonSafe(ev.output)) {
      return res.status(400).json({ ok: false, error: 'event.output must be JSON-serializable' });
    }
    if (ev.user_verified !== undefined && ev.user_verified !== null && typeof ev.user_verified !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'event.user_verified must be boolean or null' });
    }
    if (ev.provider_status !== undefined && ev.provider_status !== null) {
      if (!PROVIDER_STATUSES.includes(ev.provider_status as ProviderStatus)) {
        return res.status(400).json({ ok: false, error: 'event.provider_status must be verified|partial|ambiguous|none' });
      }
    }

    if (kind === 'capture') {
      const typedText = str(ev.typed_text, 1000);
      const listQuery = str(ev.list_query, 1000);
      if (!typedText || !listQuery) {
        return res.status(400).json({ ok: false, error: 'typed_text and list_query required' });
      }
      if (typeof ev.selected !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'selected must be boolean' });
      }
      const row = {
        typed_text: typedText,
        list_query: listQuery,
        suggestion_label: optStr(ev.suggestion_label) ?? null,
        selected: ev.selected,
        provider,
        output: ev.output,
        user_verified: ev.user_verified === undefined ? null : ev.user_verified,
      };
      const { data, error } = await getDb()
        .from('capture_events')
        .insert([row])
        .select('id')
        .single();
      if (error) return res.status(200).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, id: (data as { id: string }).id });
    }

    // kind === 'verify'
    if (!jsonSafe(ev.input)) {
      return res.status(400).json({ ok: false, error: 'event.input must be JSON-serializable' });
    }
    const captureEventId = optStr(ev.capture_event_id);
    if (captureEventId && !UUID_RE.test(captureEventId)) {
      return res.status(400).json({ ok: false, error: 'capture_event_id must be a uuid' });
    }
    const row = {
      input: ev.input,
      provider,
      output: ev.output,
      provider_status: (ev.provider_status as ProviderStatus | undefined) ?? null,
      user_verified: ev.user_verified === undefined ? null : ev.user_verified,
      capture_event_id: captureEventId ?? null,
    };
    const { data, error } = await getDb()
      .from('verify_events')
      .insert([row])
      .select('id')
      .single();
    if (error) return res.status(200).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, id: (data as { id: string }).id });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : 'log failed' });
  }
}