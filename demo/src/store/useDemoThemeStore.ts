import { create } from 'zustand';

export type Theme = 'light' | 'dark';

// Deliberately its own storage key, distinct from production's
// "cold-crm:theme" — the demo is served from the same origin as
// production (app.irms.io/demo/), so localStorage is shared per-origin,
// not per-path. A demo-specific key keeps this UI preference from ever
// reading or writing anything production also touches, preserving the
// "Demo has its own, fully separate context" boundary even for something
// as harmless-seeming as a light/dark toggle.
const STORAGE_KEY = 'irms-demo:theme';

/** Same "apply before first paint" approach as production's own
 * useThemeStore.ts — called synchronously in main.tsx so a returning
 * visitor who picked dark never sees a one-frame flash of the light
 * theme. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

function loadInitialTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

interface DemoThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

export const useDemoThemeStore = create<DemoThemeState>((set, get) => ({
  theme: loadInitialTheme(),
  toggleTheme: () => {
    const next: Theme = get().theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-browsing/blocked storage — theme still applies for this
      // page view, it just won't be remembered next visit.
    }
    applyTheme(next);
    set({ theme: next });
  },
}));
