// Copied as-is from app/src/utils/link.ts — a stored link value is kept
// exactly as typed ("google.com", no protocol); this only adds https://
// at the point of actually forming the href, so the raw value isn't
// silently rewritten into something the user didn't type.
export function ensureProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
