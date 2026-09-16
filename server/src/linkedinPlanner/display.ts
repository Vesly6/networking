import { getRowById, getTable } from '../tableData/db.js';
import { findLinkedinUrl, parseContactEntriesForPlanner, splitPersonFields } from './contactParsing.js';
import type { PlannerTask } from './db.js';

export interface PlannerTaskDisplay {
  name: string | null;
  jobTitle: string | null;
  companyName: string | null;
  /** The real, un-normalized URL — what "Atidaryti" actually opens.
   * Falls back to the task's own normalized URL (with https:// restored)
   * if the live source can no longer be found (row/contact deleted) —
   * still a valid, openable link even once a task is `removed`. */
  linkedinUrl: string;
  /** The table this task's primary occurrence currently lives in — null
   * only if that table itself no longer exists. Lets a worker with access
   * to several tables tell which one a given lead came from. */
  sourceTableName: string | null;
}

interface ColumnLike {
  id: string;
  type: string;
}

/** Always reads the CURRENT row/contact data fresh — this is the "never
 * snapshot, always live-read" rule from the feature's own design: a
 * contact's job title changing in the table shows up here on the very
 * next read, with no sync step involved at all. Only creation/removal of
 * the underlying link needs sync.ts's reconciliation; everything else
 * (name, title, company) is resolved on demand, right here. */
export function resolveTaskDisplay(task: PlannerTask, companyId: string): PlannerTaskDisplay {
  const fallbackUrl = `https://${task.normalizedLinkedinUrl}`;
  const table = getTable(task.primaryTableId, companyId);
  const row = getRowById(task.primaryRowId, companyId);
  if (!table || !row) return { name: null, jobTitle: null, companyName: null, linkedinUrl: fallbackUrl, sourceTableName: null };

  const columns = table.columns as ColumnLike[];
  const companyColumn = columns.find((c) => c.type === 'company');
  const companyName = companyColumn ? row.cells[companyColumn.id] || null : null;

  if (task.primaryContactId) {
    const contactColumn = columns.find((c) => c.type === 'contact');
    if (contactColumn) {
      const entry = parseContactEntriesForPlanner(row.cells[contactColumn.id] ?? '').find((e) => e.id === task.primaryContactId);
      if (entry) {
        const fields = splitPersonFields(entry.text);
        return {
          name: fields.name || null,
          jobTitle: fields.title,
          companyName: fields.company ?? companyName,
          linkedinUrl: findLinkedinUrl(entry.text) ?? fallbackUrl,
          sourceTableName: table.name,
        };
      }
    }
    return { name: null, jobTitle: null, companyName, linkedinUrl: fallbackUrl, sourceTableName: table.name };
  }

  // Sourced from a `link`-type column instead of a contact entry (a
  // company page, or a person whose LinkedIn lives in a dedicated
  // column) — no per-person name/title to read, just the row's own
  // company value.
  const linkColumn = columns.find((c) => c.type === 'link');
  const linkedinUrl = (linkColumn && findLinkedinUrl(row.cells[linkColumn.id] ?? '')) || fallbackUrl;
  return { name: companyName, jobTitle: null, companyName, linkedinUrl, sourceTableName: table.name };
}
