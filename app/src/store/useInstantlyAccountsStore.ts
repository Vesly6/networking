import { create } from 'zustand';
import {
  fetchInstantlyAccounts,
  createInstantlyAccount,
  pauseInstantlyAccount,
  resumeInstantlyAccount,
  setInstantlyWarmup,
  type InstantlyAccount,
  type NewInstantlyMailbox,
} from '../utils/instantlyApi';

interface InstantlyAccountsState {
  accounts: InstantlyAccount[];
  ready: boolean;
  error: string | null;
  refresh: () => Promise<void>;

  creating: boolean;
  createError: string | null;
  addMailbox: (mailbox: NewInstantlyMailbox) => Promise<boolean>;

  // Set, not a single email — same per-row-concurrency reasoning as every
  // other store in this app (see useInstantlyLeadsStore.unsubscribingIds).
  togglingEmails: Set<string>;
  togglePause: (account: InstantlyAccount) => Promise<void>;
  toggleWarmup: (account: InstantlyAccount) => Promise<void>;
}

export const useInstantlyAccountsStore = create<InstantlyAccountsState>((set) => ({
  accounts: [],
  ready: false,
  error: null,

  refresh: async () => {
    set({ error: null });
    try {
      // Auto-paginates through every page rather than trusting one
      // `limit: 50` call to return everything — confirmed live and
      // directly against Instantly's real API (bypassing this app's own
      // proxy entirely) that it doesn't reliably honor `limit`: it
      // returned all 9 connected mailboxes in one page earlier, then on a
      // later call returned only 1 item per page with a real
      // `next_starting_after` cursor for the rest, for the exact same
      // request. A connected-mailbox list is realistically small (tens,
      // not thousands), so paying for a few extra requests to always show
      // the true full list is worth it — capped at 40 pages purely as a
      // runaway-loop guard, not an expected real limit.
      const accounts: InstantlyAccount[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 40; page++) {
        const result = await fetchInstantlyAccounts({ limit: 50, starting_after: cursor });
        accounts.push(...result.items);
        if (!result.next_starting_after) break;
        cursor = result.next_starting_after;
      }
      set({ accounts, ready: true });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti pašto dėžučių', ready: true });
    }
  },

  creating: false,
  createError: null,
  addMailbox: async (mailbox) => {
    set({ creating: true, createError: null });
    try {
      const created = await createInstantlyAccount(mailbox);
      set((s) => ({ accounts: [created, ...s.accounts] }));
      return true;
    } catch (err) {
      set({ createError: err instanceof Error ? err.message : 'Nepavyko pridėti pašto dėžutės' });
      return false;
    } finally {
      set({ creating: false });
    }
  },

  togglingEmails: new Set(),
  togglePause: async (account) => {
    const { email, status } = account;
    set((s) => ({ togglingEmails: new Set(s.togglingEmails).add(email) }));
    try {
      // status 1 = Active (see ACCOUNT_STATUS_LABELS) — pause an active
      // mailbox, resume anything else.
      if (status === 1) await pauseInstantlyAccount(email);
      else await resumeInstantlyAccount(email);
      set((s) => ({ accounts: s.accounts.map((a) => (a.email === email ? { ...a, status: status === 1 ? 2 : 1 } : a)) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pakeisti pašto dėžutės būsenos' });
    } finally {
      set((s) => {
        const next = new Set(s.togglingEmails);
        next.delete(email);
        return { togglingEmails: next };
      });
    }
  },

  toggleWarmup: async (account) => {
    const { email, warmup_status } = account;
    set((s) => ({ togglingEmails: new Set(s.togglingEmails).add(email) }));
    try {
      const enable = warmup_status !== 1;
      await setInstantlyWarmup(email, enable);
      set((s) => ({ accounts: s.accounts.map((a) => (a.email === email ? { ...a, warmup_status: enable ? 1 : 0 } : a)) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pakeisti warmup būsenos' });
    } finally {
      set((s) => {
        const next = new Set(s.togglingEmails);
        next.delete(email);
        return { togglingEmails: next };
      });
    }
  },
}));
