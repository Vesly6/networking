import { loadTablesFromIndexedDB, loadRowsForTableFromIndexedDB, saveTable, saveRows } from '../db/db';

export interface MigrationResult {
  tablesMigrated: number;
  rowsMigrated: number;
}

/** One-time move of whatever tables/rows exist in this browser's own
 * IndexedDB up to the server (server/src/tableData/db.ts) — see
 * CLAUDE.md's own section on this migration for why it exists at all
 * (IndexedDB is per-browser/per-device, so a phone opening the app never
 * had any of this data to begin with). `saveTable`/`saveRows` here are
 * db.ts's *current*, server-backed exports (not the IndexedDB versions —
 * those are the `FromIndexedDB` ones being read from), so this genuinely
 * writes to the server, the same call path any other table-data write in
 * the app now goes through. The old IndexedDB data is left in place
 * afterward, untouched — this only ever adds to the server, never deletes
 * the local copy, so a failed or partial run can just be re-run safely
 * (every write here is a plain upsert, keyed by the same ids). */
export async function migrateLocalDataToServer(): Promise<MigrationResult> {
  const tables = await loadTablesFromIndexedDB();
  let rowsMigrated = 0;
  for (const table of tables) {
    await saveTable(table);
    const rows = await loadRowsForTableFromIndexedDB(table.id);
    if (rows.length > 0) {
      await saveRows(rows);
      rowsMigrated += rows.length;
    }
  }
  return { tablesMigrated: tables.length, rowsMigrated };
}
