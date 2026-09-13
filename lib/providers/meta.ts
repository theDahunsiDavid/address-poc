// Client-safe provider metadata — safe to import from components AND server
// routes. No secrets here; key lookup lives in lib/config.ts (server-only).

export type ProviderId = 'google' | 'melissa' | 'precisely' | 'loqate';
export type ProviderKind = 'capture' | 'verify' | 'both';

export interface ProviderMeta {
  id: ProviderId;
  /** Display name for the UI dropdown. */
  name: string;
  /** Which column(s) this provider appears in. */
  kind: ProviderKind;
  // Free-tier limits / per-lookup price / minimum commitment are recorded
  // for reference only (shown in the toggled provider-details panel).
  // Fill these from the trial account / vendor terms when known.
  freeTier: string;
  perLookupPrice: string;
  minimumCommitment: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  google: {
    id: 'google',
    name: 'Google (Places)',
    kind: 'capture',
    freeTier: '',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  melissa: {
    id: 'melissa',
    name: 'Melissa',
    kind: 'capture',
    freeTier: '',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  precisely: {
    id: 'precisely',
    name: 'Precisely',
    kind: 'both',
    freeTier: '',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  loqate: {
    id: 'loqate',
    name: 'Loqate',
    kind: 'both',
    freeTier: '',
    perLookupPrice: '',
    minimumCommitment: '',
  },
};

/** Providers that appear in the Capture column. */
export const CAPTURE_PROVIDERS: ProviderMeta[] = Object.values(PROVIDERS).filter(
  (p) => p.kind !== 'verify',
);

/** Providers that appear in the Verify column. */
export const VERIFY_PROVIDERS: ProviderMeta[] = Object.values(PROVIDERS).filter(
  (p) => p.kind !== 'capture',
);