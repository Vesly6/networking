/** Picks readable text (near-black or near-white) for an arbitrary
 * background hex color, via the standard YIQ perceived-brightness
 * formula — the same general approach used everywhere this "which text
 * color reads on this background" problem comes up.
 *
 * Exists because of a real, reported bug the dark theme surfaced: cell
 * fill colors and dropdown "status" badge colors (PRESET_COLORS,
 * constants.ts) are all light pastels, chosen once and stored as literal
 * hex values completely independent of useThemeStore — they were always
 * meant to be read with dark text sitting on top. As long as the app was
 * light-only, the badge's text color (`color: var(--text)`, a plain CSS
 * variable) happened to be dark too, so this never actually needed its
 * own logic. The moment dark mode flips --text to a light color for
 * everything else, those same light pastel badges suddenly got light
 * text on a light background — the exact "статусы очень каряво
 * выглядят" (statuses look badly garbled) complaint. Computing a
 * contrasting text color *from the badge's own background*, independent
 * of the theme entirely, is what makes a colored badge correctly
 * readable in both themes at once — not just a dark-mode patch. */
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
