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
}

export const usePendingPhoneSearchStore = create<PendingPhoneSearchState>((set) => ({
  count: 0,
  start: () => set((s) => ({ count: s.count + 1 })),
  finish: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));
