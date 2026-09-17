import type { AddressProvider } from './types';
import { google } from './google';
import { melissa } from './melissa';
import { precisely } from './precisely';
import { loqate } from './loqate';
import { postgrid } from './postgrid';
import { smarty } from './smarty';
import { geoapify } from './geoapify';
import { postcoder } from './postcoder';

// Adapters keyed by provider id. API routes look up by the provider query
// param; new adapters register here.

export const providers: Record<string, AddressProvider> = {
  google,
  melissa,
  precisely,
  loqate,
  postgrid,
  smarty,
  geoapify,
  postcoder,
};

export function getProvider(id: string): AddressProvider | undefined {
  return providers[id];
}