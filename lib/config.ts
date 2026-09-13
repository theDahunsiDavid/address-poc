// Provider keys. Server-only module: reads process.env, so never import this
// from client components, or the keys ship to the browser. Client-safe
// provider metadata lives in ./providers/meta.ts.

import { PROVIDERS, type ProviderId } from './providers/meta';

const KEY_ENV: Record<ProviderId, string> = {
  google: 'GOOGLE_PLACES_API_KEY',
  melissa: 'MELISSA_API_KEY',
  precisely: 'PRECISELY_API_KEY',
  loqate: 'LOQATE_API_KEY',
};

export { PROVIDERS };
export type { ProviderId } from './providers/meta';

export function getKey(id: ProviderId): string {
  return process.env[KEY_ENV[id]] ?? '';
}

/** 'missing' feeds the UI's "trial key missing" notice on provider select. */
export function keyStatus(id: ProviderId): 'configured' | 'missing' {
  return getKey(id) ? 'configured' : 'missing';
}