import { create } from 'zustand';
import { fetchTimedReminders } from '../utils/remindersApi';
import { getPrimaryLabel, getLinkedContactName, getNextActionColumn } from '../utils/row';
import { playReminderSound } from '../utils/notificationSound';
import { useToastStore } from './useToastStore';
import type { Row } from '../types';

const NOTIFIED_KEYS_STORAGE_KEY = 'cold-crm:reminder-notified-keys';
// Cap how far back a missed reminder still gets surfaced — long enough
// that closing the tab for a lunch break or a short meeting doesn't
// silently swallow a reminder, short enough that reopening the app the
// next morning doesn't dump a flood of yesterday's stale ones.
const CATCH_UP_WINDOW_MS = 60 * 60 * 1000;
// Only kept so the persisted set doesn't grow forever across months of
// use — far more than could plausibly still be within CATCH_UP_WINDOW_MS
// at once, this is purely a sanity ceiling.
const MAX_TRACKED_KEYS = 500;

function loadNotifiedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEYS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k): k is string => typeof k === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveNotifiedKeys(keys: Set<string>) {
  try {
    const arr = [...keys].slice(-MAX_TRACKED_KEYS);
    localStorage.setItem(NOTIFIED_KEYS_STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // localStorage can throw (quota, private browsing) — de-dupe across
    // reloads is a nice-to-have, not required for reminders to keep firing
    // within a single session.
  }
}

type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

interface ReminderState {
  permission: BrowserNotificationPermission;
  requestPermission: () => Promise<void>;
  /** Fetches every timed next-action row across every table, fires a
   * notification (native browser Notification + in-app toast + sound)
   * for any that just became due and haven't already been shown, and
   * records them so a later poll (or a page reload) doesn't repeat them.
   * Meant to be called on an interval — see App.tsx's own poller. */
  poll: () => Promise<void>;
}

export const useReminderStore = create<ReminderState>((set) => {
  const notifiedKeys = loadNotifiedKeys();

  return {
    permission:
      typeof window === 'undefined' || typeof Notification === 'undefined'
        ? 'unsupported'
        : (Notification.permission as BrowserNotificationPermission),

    requestPermission: async () => {
      if (typeof Notification === 'undefined') {
        set({ permission: 'unsupported' });
        return;
      }
      const result = await Notification.requestPermission();
      set({ permission: result as BrowserNotificationPermission });
    },

    poll: async () => {
      let groups;
      try {
        groups = await fetchTimedReminders();
      } catch {
        // A failed poll (server briefly unreachable, etc.) just tries
        // again on the next tick — nothing to surface to the user for a
        // background check like this.
        return;
      }

      const now = Date.now();
      for (const group of groups) {
        const dateColumn = getNextActionColumn(group.columns);
        if (!dateColumn) continue;
        for (const rowData of group.rows) {
          const value = rowData.cells[dateColumn.id];
          if (!value) continue;
          const dueAt = new Date(value).getTime();
          if (Number.isNaN(dueAt)) continue;
          const key = `${rowData.id}:${value}`;
          if (notifiedKeys.has(key)) continue;
          const msSinceDue = now - dueAt;
          // Not due yet, or due so long ago it's outside the catch-up
          // window — neither should notify (the latter matches this
          // feature's own explicit scope: only rows with a *time* set,
          // and only ones actually close to that time, not a general
          // "everything overdue" digest — that's what the calendar/task
          // list already covers).
          if (msSinceDue < 0 || msSinceDue > CATCH_UP_WINDOW_MS) continue;

          const row: Row = { id: rowData.id, tableId: group.tableId, cells: rowData.cells, order: 0, createdAt: 0, updatedAt: 0 };
          const label = getPrimaryLabel(row, group.columns);
          const contactName = getLinkedContactName(row, group.columns);
          const title = 'Laikas skambinti';
          const body = contactName ? `${label} — ${contactName}` : label;

          notifiedKeys.add(key);

          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              const notification = new Notification(title, { body, tag: key });
              notification.onclick = () => {
                window.focus();
                notification.close();
              };
            } catch {
              // Some browsers throw constructing Notification outside a
              // fully-focused context in rare edge cases — the in-app
              // toast/sound below still cover it either way.
            }
          }
          useToastStore.getState().show(`${title}: ${body}`);
          playReminderSound();
        }
      }
      saveNotifiedKeys(notifiedKeys);
    },
  };
});
