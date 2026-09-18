// Provider errors can carry HTML error pages (e.g. Loqate's ASP.NET 404
// page), and Node fetch failures bury the real reason (DNS, TCP, TLS) in
// `cause` chains. Flatten both to one readable line for the UI notice.

export function errorMessage(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<Error>();
  let current = err;
  while (current instanceof Error && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    if (current.message && !parts.includes(current.message)) parts.push(current.message);
    current = current.cause;
  }
  if (parts.length === 0) parts.push(String(err));

  const raw = parts.join(' — ');
  const stripped = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 240 ? `${stripped.slice(0, 240)}…` : stripped;
}

// Machine-readable codes attached to thrown errors. The compare runner uses
// `code` to separate coverage misses (a genuine no-match, counted against the
// provider's coverage tally) from transport/config failures (anything untagged
// — HTTP errors, network resets, auth/quota) which are retried or flagged.
// Code and message stay together: the API surfaces both, the runner reads the
// code off the caught Error directly.
export type VerifyErrorCode = 'no-match';

export interface CodedError extends Error {
  code?: VerifyErrorCode;
}

/** Throws that mean "address not found" — the provider answered, and the
 *  answer is no-match. These are not retried and count as coverage misses. */
export function noMatchError(message: string): Error {
  const err = new Error(message) as CodedError;
  err.code = 'no-match';
  return err;
}