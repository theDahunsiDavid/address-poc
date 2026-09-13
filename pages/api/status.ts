import type { NextApiRequest, NextApiResponse } from 'next';
import { keyStatus, PROVIDERS } from '@/lib/config';
import { providers } from '@/lib/providers';

// Feeds the UI's key-status notice and the toggled provider-details panel.
// Needed because keys live server-side — the browser can't know them.

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const rows = Object.values(PROVIDERS).map((m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    supported: m.id in providers,
    status: keyStatus(m.id),
    details: {
      freeTier: m.freeTier,
      perLookupPrice: m.perLookupPrice,
      minimumCommitment: m.minimumCommitment,
    },
  }));
  res.status(200).json({ providers: rows });
}