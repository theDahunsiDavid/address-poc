import type { AddressProvider } from './types';
import { google } from './google';

// Adapters keyed by provider id. API routes look up by the provider query
// param; new adapters register here.

export const providers: Record<string, AddressProvider> = {
  google,
};

export function getProvider(id: string): AddressProvider | undefined {
  return providers[id];
}