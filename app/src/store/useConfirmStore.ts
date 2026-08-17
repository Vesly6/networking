import { create } from 'zustand';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button red instead of the default accent color —
   * for anything that deletes/discards data. */
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (result: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  resolveConfirm: (result: boolean) => void;
}

/** Backs the app's own confirm modal (ConfirmDialog.tsx, mounted once in
 * App.tsx) — a drop-in replacement for `window.confirm()` on explicit
 * request, so every "are you sure?" in the app matches its own design
 * instead of the browser's native dialog chrome. Same call shape as
 * `window.confirm` (a string, or an options object for a custom
 * title/labels/danger styling), just async: `if (await confirmDialog(...))`
 * instead of `if (window.confirm(...))`. */
const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  resolveConfirm: (result) => {
    get().request?.resolve(result);
    set({ request: null });
  },
}));

export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === 'string' ? { message: options } : options;
  return new Promise<boolean>((resolve) => {
    useConfirmStore.setState({ request: { ...opts, resolve } });
  });
}

export { useConfirmStore };
