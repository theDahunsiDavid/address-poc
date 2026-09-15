// Server-side fetch wrapper with one network-layer retry.
//
// Vendor edges occasionally kill idle keep-alive sockets, so a request can
// fail at the TCP/TLS layer even though the API is healthy (observed twice:
// PostGrid connection-reset, Precisely "fetch failed" — both recovered on an
// immediate manual retry). For a measurement POC a hiccup corrupts one
// comparison row, so we retry once with a fresh connection.
//
// IMPORTANT: we retry ONLY when fetch itself rejects (no response bytes
// arrived — undici throws TypeError "fetch failed" with a cause). We never
// retry once a response has been received: a mid-body failure could mean the
// vendor already billed the lookup (PostGrid/Smarty bill per lookup), and
// HTTP error responses (401/402/429...) are normal outcomes the adapters
// handle themselves — retrying those would double-bill or mask real statuses.

const RETRY_DELAY_MS = 250;

export function isNetworkError(err: unknown): boolean {
  // undici wraps network failures (DNS, TCP reset, TLS) in TypeError with an
  // Error cause; aborts are DOMException 'AbortError' and never match.
  return err instanceof TypeError && err.cause instanceof Error;
}

export async function fetchWithRetry(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return fetch(url, init);
  }
}