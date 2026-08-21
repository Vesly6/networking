import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cold-crm:theme';

/** Applied via a `data-theme` attribute on <html> — App.css's dark
 * overrides are scoped to `:root[data-theme="dark"]`, same "attribute
 * selector on the root element" approach as every CSS-variable-driven
 * theme system. Kept outside the store so it can run once, synchronously,
 * before the first paint (see main.tsx) — reading it back out of
 * localStorage only inside a React effect would flash the light theme
 * for one frame on every reload for a user who picked dark. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

function loadInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'dark' ? 'dark' : 'light';
}

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: loadInitialTheme(),
  toggleTheme: () => {
    const next: Theme = get().theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    set({ theme: next });
  },
}));
