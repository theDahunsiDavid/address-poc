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