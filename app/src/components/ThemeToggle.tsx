import { useThemeStore } from '../store/useThemeStore';

/** Mounted twice — once in App.tsx's table-screen header, once in
 * WorkspaceView's own header — since those two screens each have their
 * own, differently-laid-out header and this needs to be reachable from
 * both without a fixed-position overlay risking a visual collision with
 * whichever header's own right-aligned button cluster is there. */
export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  return (
    <button
      type="button"
      className="theme-toggle"
      title={theme === 'dark' ? 'Šviesus dizainas' : 'Tamsus dizainas'}
      onClick={toggleTheme}
    >
      {/* Plain inline SVG, not an emoji or an icon-library dependency —
          matches this app's own "no heavy UI dependencies" convention
          (CallsStatsView's hand-rolled SVG bar chart, LinkedIn's own
          activity chart, both for the identical reason). */}
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.5" />
          <line x1="12" y1="1.5" x2="12" y2="4" />
          <line x1="12" y1="20" x2="12" y2="22.5" />
          <line x1="4.2" y1="4.2" x2="5.9" y2="5.9" />
          <line x1="18.1" y1="18.1" x2="19.8" y2="19.8" />
          <line x1="1.5" y1="12" x2="4" y2="12" />
          <line x1="20" y1="12" x2="22.5" y2="12" />
          <line x1="4.2" y1="19.8" x2="5.9" y2="18.1" />
          <line x1="18.1" y1="5.9" x2="19.8" y2="4.2" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M20.5 14.5a8.5 8.5 0 0 1-10-10 8.5 8.5 0 1 0 10 10z" />
        </svg>
      )}
    </button>
  );
}
