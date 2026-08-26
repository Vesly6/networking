import { create } from 'zustand';

export interface TypeToConfirmOptions {
  title?: string;
  message: string;
  /** The exact text the user must type before the confirm button enables —
   * an ordinary confirmDialog() button-click is too easy to hit on
   * autopilot for the one action in the app with genuinely zero recovery
   * path (see confirmDeleteTable.ts's own doc comment on why table
   * deletion specifically gets this treatment, on explicit request). */
  requiredText: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface TypeToConfirmRequest extends TypeToConfirmOptions {
  resolve: (result: boolean) => void;
}

interface TypeToConfirmState {
  request: TypeToConfirmRequest | null;
  resolveTypeToConfirm: (result: boolean) => void;
}

/** Backs TypeToConfirmDialog.tsx (mounted once in App.tsx, alongside the
 * plain ConfirmDialog) — same async call-and-await shape as
 * useConfirmStore's confirmDialog, kept as a separate store/component
 * rather than extending ConfirmDialog itself, since every other confirm in
 * this app is a plain two-button yes/no and doesn't need the extra local
 * input state or match-checking this one requires. */
const useTypeToConfirmStore = create<TypeToConfirmState>((set, get) => ({
  request: null,
  resolveTypeToConfirm: (result) => {
    get().request?.resolve(result);
    set({ request: null });
  },
}));

export function typeToConfirmDialog(options: TypeToConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useTypeToConfirmStore.setState({ request: { ...options, resolve } });
  });
}

export { useTypeToConfirmStore };
