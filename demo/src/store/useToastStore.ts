// Copied as-is from app/src/store/useToastStore.ts — a plain,
// credential-free UI utility store.
import { create } from 'zustand';

interface ToastState {
  message: string | null;
  show: (message: string) => void;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  show: (message) => {
    if (timer) clearTimeout(timer);
    set({ message });
    timer = setTimeout(() => set({ message: null }), 4000);
  },
  clear: () => set({ message: null }),
}));
