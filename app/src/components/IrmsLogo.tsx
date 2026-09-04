import { useThemeStore } from '../store/useThemeStore';

// Two pre-rendered variants (public/irms-logo-light.svg, black fill;
// public/irms-logo-dark.svg, #ececea fill matching this theme's own
// --text token) rather than one SVG recolored via CSS — the source file
// (1.svg, provided directly) draws the wordmark as filled vector paths
// with the color baked into each path's own fill attribute, not a
// currentColor-friendly shape, so swapping the whole asset per theme is
// simpler than fighting that. Both are the same file cropped to a tight
// viewBox around the actual glyphs — the original had a large empty
// margin baked into its own canvas that made it render tiny/off-center
// at any normal logo height otherwise.
const LOGO_SRC = { light: '/irms-logo-light.svg', dark: '/irms-logo-dark.svg' } as const;

/** Replaces the plain "Darbo sritis" text heading on the Workspace
 * screen, on explicit request. Theme-aware — swaps to the light-fill
 * variant automatically so it stays legible against this app's dark
 * background (#2e2e2c), not just white. */
export function IrmsLogo() {
  const theme = useThemeStore((s) => s.theme);
  return <img src={LOGO_SRC[theme]} alt="IRMS" className="irms-logo" />;
}
