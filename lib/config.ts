// Provider keys. Server-only module: reads process.env, so never import this
// from client components, or the keys ship to the browser. Client-safe
// provider metadata lives in ./providers/meta.ts.

import { PROVIDERS, type ProviderId } from './providers/meta';

const KEY_ENV: Record<ProviderId, string> = {
  google: 'GOOGLE_PLACES_API_KEY',
  melissa: 'MELISSA_API_KEY',
  precisely: 'PRECISELY_API_KEY',
  loqate: 'LOQATE_API_KEY',
  postgrid: 'POSTGRID_API_KEY',
  smarty: 'SMARTY_AUTH_ID',
  geoapify: 'GEOAPIFY_API_KEY',
  postcoder: 'POSTCODER_API_KEY',
  placekit: 'PLACEKIT_API_KEY',
};

// Precisely authenticates via OAuth2 client_credentials; the trial dashboard
// issues an API key + secret pair used as the OAuth client id + secret.
// Smarty uses a "secret key" pair: auth-id (disclosure-safe) + auth-token
// (secret) — same two-half shape, different transport (query params).
const SECRET_ENV: Partial<Record<ProviderId, string>> = {
  precisely: 'PRECISELY_API_SECRET',
  smarty: 'SMARTY_AUTH_TOKEN',
};

export { PROVIDERS };
export type { ProviderId } from './providers/meta';

export function getKey(id: ProviderId): string {
  return process.env[KEY_ENV[id]] ?? '';
}

export function getSecret(id: ProviderId): string {
  const env = SECRET_ENV[id];
  return (env ? process.env[env] : '') ?? '';
}

/** 'missing' feeds the UI's "trial key missing" notice on provider select. */
export function keyStatus(id: ProviderId): 'configured' | 'missing' {
  if (id === 'precisely' || id === 'smarty') {
    // Both vendors key off a two-half credential; a lone half would fail
    // auth before any request helps.
    return getKey(id) && getSecret(id) ? 'configured' : 'missing';
  }
  return getKey(id) ? 'configured' : 'missing';
}