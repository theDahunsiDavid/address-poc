// Server-side latency helper. Measures only the upstream provider call;
// end-to-end latency is measured in the browser around the fetch.

export interface TimedResult<T> {
  result: T;
  /** Milliseconds spent in the wrapped call (server-side). */
  serverMs: number;
}

export async function timeCall<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const result = await fn();
  return { result, serverMs: Math.round(performance.now() - start) };
}