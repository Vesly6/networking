// Copied as-is from app/src/store/useConfirmStore.ts.
import { create } from 'zustand';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (result: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  resolveConfirm: (result: boolean) => void;
}

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
