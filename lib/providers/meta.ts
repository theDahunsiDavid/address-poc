// Client-safe provider metadata — safe to import from components AND server
// routes. No secrets here; key lookup lives in lib/config.ts (server-only).

export type ProviderId =
  | 'google'
  | 'melissa'
  | 'precisely'
  | 'loqate'
  | 'postgrid'
  | 'smarty'
  | 'geoapify'
  | 'postcoder'
  | 'placekit';
export type ProviderKind = 'capture' | 'verify' | 'both';

/**
 * Which sub-category of verification a verify-capable provider performs.
 * A UI taxonomy, not an engine change: "the postal/reference database
 * confirms it" (postal) and "there is plausibly a matching location on a
 * map" (geocoded) claim different things, so the Verify column groups
 * them under separate headers. Absent for capture-only providers.
 */
export type VerifyCategory = 'postal' | 'geocoded';

export interface ProviderMeta {
  id: ProviderId;
  /** Display name for the UI dropdown. */
  name: string;
  /** Which column(s) this provider appears in. */
  kind: ProviderKind;
  /** Verify-column sub-category — see VerifyCategory. */
  verifyCategory?: VerifyCategory;
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
    verifyCategory: 'postal',
    freeTier: '',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  loqate: {
    id: 'loqate',
    name: 'Loqate',
    kind: 'both',
    verifyCategory: 'postal',
    freeTier: '',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  postgrid: {
    id: 'postgrid',
    name: 'PostGrid',
    kind: 'both',
    verifyCategory: 'postal',
    freeTier: '',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  smarty: {
    id: 'smarty',
    name: 'Smarty',
    kind: 'both',
    verifyCategory: 'postal',
    freeTier: '42-day free trial (free testing accounts)',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  geoapify: {
    id: 'geoapify',
    name: 'Geoapify',
    kind: 'both',
    verifyCategory: 'geocoded',
    // https://www.geoapify.com/pricing — free tier is 3,000 credits/day;
    // capture/verify consume different credit amounts. Fill perLookupPrice
    // from their pricing page when known.
    freeTier: '3,000 credits/day (free tier)',
    perLookupPrice: '',
    minimumCommitment: '',
  },
  postcoder: {
    id: 'postcoder',
    name: 'Postcoder',
    kind: 'capture',
    // Address autocomplete only — Postcoder has no verify/cleanse product
    // (docs sitemap: address lookup, bank/email/mobile validation, OTP).
    // Pricing (credit-costs page): autocomplete/find is 0 credits;
    // autocomplete/retrieve is 2 credits rest-of-world (2.4 with addtags).
    freeTier: 'autocomplete/find free (0 credits)',
    perLookupPrice: '2 credits per retrieve (rest of world)',
    minimumCommitment: 'credit packs or monthly plans',
  },
  placekit: {
    id: 'placekit',
    name: 'PlaceKit',
    kind: 'capture',
    // Search/reverse geocoding only — PlaceKit has no verify/cleanse product.
    // Pricing (placekit.io/pricing): first 10,000 requests are free every
    // month; $0.0030 each from 10k to 50k; custom volume plans beyond.
    freeTier: '10,000 requests/month free (every month)',
    perLookupPrice: '$0.0030 per request (10k-50k tier)',
    minimumCommitment: 'pay-as-you-go; custom volume plans',
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