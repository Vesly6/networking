/** For `link`-type cells: the stored value is kept exactly as typed (e.g.
 * "google.com", no protocol) — this only adds `https://` at the point of
 * actually forming a URL to open, so a plain-looking value in the cell/CSV
 * export isn't silently rewritten into something the user didn't type. */
export function ensureProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
