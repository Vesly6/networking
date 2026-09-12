// Copied verbatim from app/src/utils/color.ts.

/** Picks readable text (near-black or near-white) for an arbitrary
 * background hex color, via the standard YIQ perceived-brightness
 * formula — so a colored cell/badge stays readable in both light and
 * dark theme, independent of the theme itself. */
export function contrastTextColor(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const r = parseInt(match[1].slice(0, 2), 16);
  const g = parseInt(match[1].slice(2, 4), 16);
  const b = parseInt(match[1].slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#1c2128' : '#ececea';
}
