import { localApiRequest } from './localApi';
import type { Column } from '../types';

export interface TimedReminderGroup {
  tableId: string;
  tableName: string;
  columns: Column[];
  rows: Array<{ id: string; cells: Record<string, string> }>;
}

/** GET /api/reminders/timed — every row, across every one of the user's
 * tables, whose next-action-date column has an opted-in time component
 * (see types.ts's Row.cells / CLAUDE.md's "Optional time" section). No
 * due-time filtering happens server-side — see findTimedNextActionRows'
 * own doc comment (server/src/tableData/db.ts) for why that comparison
 * has to happen here, in the browser's own local timezone, instead. */
export async function fetchTimedReminders(): Promise<TimedReminderGroup[]> {
  const { groups } = await localApiRequest<{ groups: TimedReminderGroup[] }>('/api/reminders/timed');
  return groups;
}
