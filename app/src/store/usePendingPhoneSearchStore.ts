import { create } from 'zustand';

/** Tracks Apollo phone-reveal lookups still in flight, globally — not
 * component-local state. A real, reported bug: ApolloContactSearchModal's
 * own poll loop (enrichPerson → poll GET /webhook_result, "can take
 * several minutes" per Apollo's own docs) is deliberately fire-and-poll,
 * not awaited, so it correctly keeps running in the background after the
 * modal closes (see its own doc comment — refs, not component state, back
 * the actual side effect). But the *visible* "🕐 Ieškoma N telefono
 * numerio fone" indicator was plain `useState` inside that same modal
 * component, so it vanished the instant the modal unmounted — from the
 * user's side, closing the search window made it look like the search
 * had silently broken/stopped ("когда я ухожу из окошка поиска ... оно
 * сбивается и вообще не ищет"), even though it was still working. Moving
 * the *count* into this global store (App.tsx renders a small persistent
 * indicator off it, visible from any tab) is what actually fixes that —
 * the underlying poll loop itself didn't need to change, only where its
 * "still working" signal is shown. */
interface PendingPhoneSearchState {
  count: number;
  start: () => void;
  finish: () => void;
  /** Keyed variant for CellHoverEditor.tsx's per-contact "find phone"
   * button — CRITICAL that this lives here, not in component state.
   * Unlike ApolloContactSearchModal.tsx's search results (which disappear
   * from the list the instant they're added, structurally preventing a
   * second click on the same person), a CRM contact entry never
   * disappears — it stays in the cell forever until it has a phone. A
   * local useState<Set<string>> guard would re-enable the button the
   * instant enrichPerson()'s synchronous call returns, while the up-to-
   * 5-minute background poll for that exact same person is still
   * running — a second click (or just closing/reopening this cell's
   * popup, which resets local state entirely) would fire a second, fully
   * redundant, up-to-9-credit lookup. Keying into this already-global
   * store fixes both: it survives remounts, and start/finish still drive
   * the same persistent count-based indicator every other phone search
   * already does. */
  pendingContactIds: Set<string>;
  startFor: (id: string) => void;
  finishFor: (id: string) => void;
  isPending: (id: string) => boolean;
}

export const usePendingPhoneSearchStore = create<PendingPhoneSearchState>((set, get) => ({
  count: 0,
  start: () => set((s) => ({ count: s.count + 1 })),
  finish: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
  pendingContactIds: new Set(),
  startFor: (id) => {
    get().start();
    set((s) => ({ pendingContactIds: new Set(s.pendingContactIds).add(id) }));
  },
  finishFor: (id) => {
    get().finish();
    set((s) => {
      const next = new Set(s.pendingContactIds);
      next.delete(id);
      return { pendingContactIds: next };
    });
  },
  isPending: (id) => get().pendingContactIds.has(id),
}));
