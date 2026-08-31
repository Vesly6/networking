import { useEffect, useState } from 'react';
import { fetchOwnBackups, type BackupSummary } from '../../utils/backupsApi';
import { BackupsPanel } from '../Admin/AdminView';

/** A company's own super_admin's view of their own flagged tables' daily
 * backups — reachable from WorkspaceView's "Duomenys" button (App.tsx's
 * `workspaceScreen === 'backups'`). Same BackupsPanel the owner's Admin
 * dashboard uses for its cross-company view, just admin=false so it hits
 * the caller's-own-company route family (see backupsApi.ts). */
export function OwnBackupsView() {
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [ready, setReady] = useState(false);

  const refresh = () => {
    void fetchOwnBackups().then((r) => {
      setBackups(r.backups);
      setReady(true);
    });
  };

  useEffect(() => {
    refresh();
    // Load once on mount only.
  }, []);

  if (!ready) return <p>Kraunama…</p>;
  return <BackupsPanel backups={backups} admin={false} onChanged={refresh} />;
}
