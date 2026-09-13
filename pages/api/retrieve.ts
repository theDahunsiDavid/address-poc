import type { NextApiRequest, NextApiResponse } from 'next';
import { getProvider } from '@/lib/providers';
import { keyStatus, type ProviderId } from '@/lib/config';
import { timeCall } from '@/lib/timing';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const providerId = String(req.query.provider ?? '');
  const provider = getProvider(providerId);
  if (!provider) {
    return res.status(400).json({ ok: false, error: `unknown provider: ${providerId}` });
  }

  const id = req.query.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'id parameter is required' });
  }

  if (keyStatus(providerId as ProviderId) === 'missing') {
    return res.status(200).json({ ok: false, error: 'trial key missing' });
  }

  try {
    const { result, serverMs } = await timeCall(() => provider.retrieve(id.trim()));
    return res.status(200).json({ ok: true, canonical: result.canonical, raw: result.raw, serverMs });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}