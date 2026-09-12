import { useDemoThemeStore } from '../store/useDemoThemeStore';

// Mirrors production's IrmsLogo.tsx: two pre-rendered variants (black
// fill for a light background, light fill for a dark one), swapped by
// theme rather than relying on the SVG to somehow work on both. Both
// files were already copied into demo/public/ for the P1 pass, but
// nothing read the dark one until this theme toggle existed.
const LOGO_SRC = { light: 'irms-logo-light.svg', dark: 'irms-logo-dark.svg' } as const;

export function DemoLogo() {
  const theme = useDemoThemeStore((s) => s.theme);
  return <img src={`${import.meta.env.BASE_URL}${LOGO_SRC[theme]}`} alt="IRMS" className="demo-logo" />;
}
