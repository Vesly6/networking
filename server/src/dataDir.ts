import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the per-feature SQLite files (linkedin.sqlite, sms-inbox.sqlite,
 * table-data.sqlite) actually get written. Defaults to server/ itself
 * (this file's own parent) — matches every local-dev setup unchanged.
 *
 * On Render's free tier the whole filesystem is ephemeral and gets wiped
 * on every deploy AND on the free-tier idle-restart (documented elsewhere
 * for why there's no in-app password-change flow) — silently destroying
 * all three databases, including whatever's just been migrated up from a
 * browser's IndexedDB, whose entire point was to survive exactly that
 * kind of reset. Set DATA_DIR in Render's dashboard to a mounted
 * persistent Disk's path (e.g. /data) to fix this; local dev never needs
 * to set it. */
export function dataFilePath(filename: string): string {
  const dir = process.env.DATA_DIR ?? path.join(__dirname, '..');
  return path.join(dir, filename);
}
