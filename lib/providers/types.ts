import type { NormalizedResult, Suggestion } from '../schema';

// Input to a verify call. Capture is free-form text; verify benefits from
// structured fields. Lat/lng are deliberately absent — neither verify
// provider accepts coordinates as input.
export interface VerifyInput {
  line1: string;
  line2?: string;
  cityArea?: string;
  state?: string;
  postalCode?: string;
  // Fixed to Nigeria for this POC, but carried through as a field.
  country: string;
}

export type ProviderKind = 'capture' | 'verify' | 'both';

// Shared adapter interface. Capture and verify are separate vendor products,
// so providers advertise which capabilities they implement.
export interface AddressProvider {
  id: string;
  kind: ProviderKind;

  /** Typeahead suggestions for the capture column. */
  autocomplete(query: string): Promise<Suggestion[]>;

  /** Full details for a selected suggestion. */
  retrieve(providerId: string): Promise<NormalizedResult>;

  /** Address verification. Only verify-capable providers implement this. */
  verify?(input: VerifyInput): Promise<NormalizedResult>;
}