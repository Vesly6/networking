import { create } from 'zustand';

const STORAGE_KEY = 'cold-crm:softphone-hidden';

/** Whether Zadarma's own floating softphone widget (Softphone.tsx) is
 * hidden right now — a real, requested feature: the user wants to be able
 * to show/hide the widget on demand without touching Zadarma's own code
 * or styling at all ("нам не нужен их код... изменить когда именно я хочу
 * его видеть"). This never reaches into the widget's own DOM/JS — it's a
 * pure CSS toggle layered on top (see applySoftphoneHidden below and
 * App.css's `:root[data-softphone-hidden="true"] .zdrm-webphone` rule),
 * same "attribute on <html>, CSS variables/selectors do the rest"
 * architecture useThemeStore already uses for light/dark.
 *
 * A personal, persistent preference — not per-component state that resets
 * on unmount/remount or on switching tables — so it survives navigating
 * around the app and reloading the page, same STORAGE_KEY-in-localStorage
 * pattern as the theme choice. */
export function applySoftphoneHidden(hidden: boolean): void {
  document.documentElement.setAttribute('data-softphone-hidden', String(hidden));
}

function loadInitialHidden(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

interface SoftphoneVisibilityState {
  hidden: boolean;
  toggle: () => void;
}

export const useSoftphoneVisibilityStore = create<SoftphoneVisibilityState>((set, get) => ({
  hidden: loadInitialHidden(),
  toggle: () => {
    const next = !get().hidden;
    localStorage.setItem(STORAGE_KEY, String(next));
    applySoftphoneHidden(next);
    set({ hidden: next });
  },
}));
