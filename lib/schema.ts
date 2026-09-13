// Canonical output schema — the normalized field model every provider adapter
// maps its raw response into. Not whatever each provider happens to return.

export interface CanonicalAddress {
  line1: string;
  line2?: string;
  cityArea: string;
  state: string;
  postalCode: string;
  country: string;
  // Present only when the provider returns coordinates.
  lat?: number;
  lng?: number;
  // Stable provider-side id, captured when available.
  providerId?: string;
}

// One suggestion row in the capture typeahead.
export interface Suggestion {
  /** Text shown in the typeahead list. */
  label: string;
  /** Provider-side id passed to retrieve() to fetch full details. */
  providerId: string;
  /** Provider's raw suggestion payload, kept for the raw JSON panel. */
  raw: unknown;
}

// The normalized result of a retrieve or verify call.
export interface NormalizedResult {
  canonical: CanonicalAddress;
  /** Raw provider response, persisted verbatim for later coverage analysis. */
  raw: unknown;
}