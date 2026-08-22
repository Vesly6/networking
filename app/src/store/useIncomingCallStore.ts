import { create } from 'zustand';

/** A "somebody is calling right now" match against the active table —
 * fed by utils/incomingCallBridge.ts (watches the Zadarma widget's own
 * DOM for a ringing call's caller-id number), read by
 * IncomingCallBanner.tsx (App.tsx, mounted globally so it shows
 * regardless of which tab is open). Global store, not component state,
 * for the identical reason usePendingPhoneSearchStore is: the thing
 * producing this (a live phone call) has nothing to do with which tab
 * happens to be mounted, so the state announcing it can't live inside
 * any one tab's own component tree either. */
export type IncomingCallMatch =
  | { kind: 'row'; rowId: string; label: string }
  | { kind: 'contact'; rowId: string; columnId: string; contactId: string; label: string }
  | null;

interface IncomingCallState {
  /** The raw number as shown in the widget, or null when no call is
   * currently ringing/active. Kept even when there's no match, so the
   * banner can still show "Skambina: +370..." for an unrecognized number
   * instead of showing nothing at all. */
  callerNumber: string | null;
  match: IncomingCallMatch;
  setIncomingCall: (callerNumber: string, match: IncomingCallMatch) => void;
  clear: () => void;
}

export const useIncomingCallStore = create<IncomingCallState>((set) => ({
  callerNumber: null,
  match: null,
  setIncomingCall: (callerNumber, match) => set({ callerNumber, match }),
  clear: () => set({ callerNumber: null, match: null }),
}));
