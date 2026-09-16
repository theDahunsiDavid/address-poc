import type { NextApiRequest, NextApiResponse } from 'next';
import { getProvider } from '@/lib/providers';
import { keyStatus, type ProviderId } from '@/lib/config';
import { timeCall } from '@/lib/timing';
import { errorMessage } from '@/lib/errors';
import { providerStatus } from '@/lib/verdict';
import type { VerifyInput } from '@/lib/providers/types';

// Proxy for the Verify column. Only providers implementing verify() are
// accepted (loqate, precisely, postgrid, smarty, geoapify). Coordinates are
// NOT inputs — vendors don't accept them; they only come back in the output.

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed (POST only)' });
  }

  const providerId = String(req.query.provider ?? '');
  const provider = getProvider(providerId);
  if (!provider) {
    return res.status(400).json({ ok: false, error: `unknown provider: ${providerId}` });
  }
  if (!provider.verify) {
    return res.status(400).json({ ok: false, error: `${providerId} does not support verification` });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const line1 = optionalString(body.line1);
  if (!line1) {
    return res.status(400).json({ ok: false, error: 'line1 is required' });
  }
  if (line1.length > 300) {
    return res.status(400).json({ ok: false, error: 'line1 too long' });
  }

  if (keyStatus(providerId as ProviderId) === 'missing') {
    return res.status(200).json({ ok: false, error: 'trial key missing' });
  }

  const input: VerifyInput = {
    line1,
    line2: optionalString(body.line2),
    cityArea: optionalString(body.cityArea),
    state: optionalString(body.state),
    postalCode: optionalString(body.postalCode),
    country: 'Nigeria', // fixed for this POC
  };

  try {
    const { result, serverMs } = await timeCall(() => provider.verify!(input));
    return res.status(200).json({
      ok: true,
      canonical: result.canonical,
      raw: result.raw,
      serverMs,
      providerStatus: providerStatus(providerId, result.raw),
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: errorMessage(err) });
  }
}