import { useEffect, useState } from 'react';
import { useAuthStore, type UserPermissions } from '../../store/useAuthStore';
import { useWorkersStore, type Worker, type WorkerActionLogEntry, type WorkerActionType } from '../../store/useWorkersStore';
import { useToastStore } from '../../store/useToastStore';
import { typeToConfirmDialog } from '../../store/useTypeToConfirmStore';
import { formatHistoryTimestamp } from '../../utils/date';
import { TAB_LABELS } from '../../utils/tabLabels';
import { ArrowRight, Key } from 'lucide-react';

const PERMISSION_LABELS: Array<{ key: keyof UserPermissions; label: string }> = [
  { key: 'canDeleteRows', label: 'Trinti eilutes' },
  { key: 'canDeleteColumns', label: 'Trinti stulpelius' },
  { key: 'canDeleteNotes', label: 'Trinti/redaguoti komentarus' },
  { key: 'canEditContacts', label: 'Redaguoti kontaktus' },
  { key: 'canDeleteContacts', label: 'Trinti kontaktus' },
  { key: 'canExportImport', label: 'CSV eksportas/importas' },
  { key: 'canInsertRows', label: 'Įterpti eilutes (virš/žemiau)' },
  { key: 'canInsertColumns', label: 'Įterpti stulpelius (kairėje/dešinėje)' },
  { key: 'canHideRowsColumns', label: 'Slėpti eilutes/stulpelius' },
  { key: 'canClearContent', label: 'Išvalyti langelių turinį' },
];

// Not togglable — every one of these applies to every worker regardless
// of the checkboxes above, enforced both client-side and (where the write
// actually goes through a checkable endpoint) server-side too. Shown here
// purely so a super-admin setting up a worker can see the full picture in
// one place, on explicit request — before this, only the 10 togglable
// permissions were visible here, with no indication these other
// restrictions exist at all.
const ALWAYS_RESTRICTED: string[] = [
  'Negali perrašyti jau užpildyto teksto/telefono/įmonės/nuorodos langelio (gali pildyti tik tuščią)',
  'Negali keisti stulpelio tipo',
  'Negali kurti, pervadinti, dubliuoti ar trinti lentelių',
  'Negali valdyti kitų darbuotojų',
];

const ACTION_TYPE_LABELS: Record<WorkerActionType, string> = {
  row_created: 'Pridėjo eilutę',
  cell_edited: 'Pakeitė langelį',
  note_added: 'Pridėjo pastabą',
  contact_added: 'Pridėjo kontaktą',
};

/** One worker's own activity feed — on explicit request, so a super-admin
 * can see what a worker actually did (not just have their mistakes
 * silently reverted by the write restrictions elsewhere in this app) and
 * jump straight to the row/contact in question with one click. Fetched
 * fresh every time it's opened (not cached across workers) since this is
 * the kind of panel that's opened rarely and should always show the
 * latest, not a stale snapshot from whenever it was last expanded. */
function WorkerActivityPanel({
  worker,
  onJumpToRow,
  onJumpToContact,
}: {
  worker: Worker;
  onJumpToRow: (tableId: string, rowId: string) => void;
  onJumpToContact: (tableId: string, rowId: string, columnId: string, contactId: string) => void;
}) {
  const actions = useWorkersStore((s) => s.actions);
  const actionsLoading = useWorkersStore((s) => s.actionsLoading);
  const loadActions = useWorkersStore((s) => s.loadActions);

  useEffect(() => {
    void loadActions(worker.id);
  }, [worker.id, loadActions]);

  const jump = (a: WorkerActionLogEntry) => {
    if (a.columnId && a.contactId) onJumpToContact(a.tableId, a.rowId, a.columnId, a.contactId);
    else onJumpToRow(a.tableId, a.rowId);
  };

  return (
    <div className="worker-activity-panel">
      {actionsLoading && actions.length === 0 && <p>Kraunama…</p>}
      {!actionsLoading && actions.length === 0 && <p className="empty-state">Kol kas nėra užregistruotų veiksmų.</p>}
      {actions.length > 0 && (
        <ul className="worker-activity-list">
          {actions.map((a) => (
            <li key={a.id} className="worker-activity-entry">
              <div className="worker-activity-entry-main">
                <span className="worker-activity-entry-type">{ACTION_TYPE_LABELS[a.actionType]}</span>
                <span className="worker-activity-entry-detail">{a.detail}</span>
                <span className="worker-activity-entry-meta">
                  {a.tableName} · {formatHistoryTimestamp(a.createdAt)}
                </span>
              </div>
              <button type="button" className="worker-activity-jump" title="Pereiti prie langelio" onClick={() => jump(a)}>
                <ArrowRight className="icon" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A worker has no self-service password reset (no email on file, no
 * recovery question — same gap the login gate's own AUTH_RECOVERY_PASSWORD
 * doc comment notes for the shared owner account, except a worker doesn't
 * even get that second password), so the super-admin who created the
 * account is the only way back in if one is forgotten. Deliberately a
 * separate small form from WorkerForm above (tabs/permissions) rather than
 * folded into it — changing a password is a one-off, occasional action,
 * not something that should be re-submitted every time tabs/permissions
 * are edited. */
function WorkerPasswordForm({ onSubmit, onCancel }: { onSubmit: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  return (
    <div className="worker-password-form">
      <label className="popover-field">
        <span>Naujas slaptažodis</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
        />
      </label>
      <div className="worker-form-actions">
        <button type="button" className="primary" disabled={!password} onClick={() => onSubmit(password)}>
          Išsaugoti
        </button>
        <button type="button" onClick={onCancel}>
          Atšaukti
        </button>
      </div>
    </div>
  );
}

const EMPTY_PERMISSIONS: UserPermissions = {
  canDeleteRows: false,
  canDeleteColumns: false,
  canDeleteNotes: false,
  canEditContacts: false,
  canDeleteContacts: false,
  canExportImport: false,
  canInsertRows: false,
  canInsertColumns: false,
  canHideRowsColumns: false,
  canClearContent: false,
};

function WorkerForm({
  companyTabs,
  initialTabs,
  initialPermissions,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  companyTabs: string[];
  initialTabs: string[];
  initialPermissions: UserPermissions;
  submitLabel: string;
  onSubmit: (tabs: string[], permissions: UserPermissions) => void;
  onCancel?: () => void;
}) {
  const [tabs, setTabs] = useState<string[]>(initialTabs);
  const [permissions, setPermissions] = useState<UserPermissions>(initialPermissions);

  const toggleTab = (t: string) => setTabs((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  const togglePermission = (key: keyof UserPermissions) => setPermissions((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="worker-form-permissions">
      <div className="worker-form-section">
        <span className="worker-form-section-label">Matomos skiltys</span>
        <div className="worker-form-chips">
          {companyTabs.map((t) => (
            <button
              key={t}
              type="button"
              className={`search-filter-chip ${tabs.includes(t) ? 'search-filter-chip-active' : ''}`}
              onClick={() => toggleTab(t)}
            >
              {TAB_LABELS[t] ?? t}
            </button>
          ))}
        </div>
      </div>
      <div className="worker-form-section">
        <span className="worker-form-section-label">Leidimai</span>
        <div className="worker-form-permission-list">
          {PERMISSION_LABELS.map((p) => (
            <label key={p.key} className="search-filter-checkbox">
              <input type="checkbox" checked={permissions[p.key]} onChange={() => togglePermission(p.key)} />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="worker-form-section worker-form-always-restricted">
        <span className="worker-form-section-label">Visada apribota (nepriklausomai nuo varnelių)</span>
        <ul>
          {ALWAYS_RESTRICTED.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </div>
      <div className="worker-form-actions">
        <button type="button" className="primary" onClick={() => onSubmit(tabs, permissions)}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Atšaukti
          </button>
        )}
      </div>
    </div>
  );
}

interface WorkersViewProps {
  /** Threaded from App.tsx's jumpToTableRow/jumpToTableContact — unlike
   * the Calls/SMS tabs' own onJumpToRow, these are table-aware (a
   * worker's logged actions can reference any table they've touched, not
   * just whatever happens to be open right now), so WorkersView doesn't
   * get to reuse the plain single-table callback every other jump-to-row
   * caller in this app uses. */
  onJumpToRow: (tableId: string, rowId: string) => void;
  onJumpToContact: (tableId: string, rowId: string, columnId: string, contactId: string) => void;
}

/** Super-admin (or owner, viewing their own company) manages the workers
 * under their own company — App.tsx only ever renders this tab's nav
 * button for those two roles (see AppScreen's own doc comment there for
 * why "manage workers" isn't a Tab/enabledFeatures-gated concept the same
 * way Calls/LinkedIn/Search are). */
export function WorkersView({ onJumpToRow, onJumpToContact }: WorkersViewProps) {
  const user = useAuthStore((s) => s.user);
  const workers = useWorkersStore((s) => s.workers);
  const loading = useWorkersStore((s) => s.loading);
  const error = useWorkersStore((s) => s.error);
  const actionsError = useWorkersStore((s) => s.actionsError);
  const load = useWorkersStore((s) => s.load);
  const create = useWorkersStore((s) => s.create);
  const update = useWorkersStore((s) => s.update);
  const remove = useWorkersStore((s) => s.remove);
  const showToast = useToastStore((s) => s.show);

  const [addingOpen, setAddingOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activityOpenId, setActivityOpenId] = useState<string | null>(null);
  const [passwordOpenId, setPasswordOpenId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  useEffect(() => {
    if (actionsError) showToast(actionsError);
  }, [actionsError, showToast]);

  const companyTabs = user?.company?.enabledFeatures ?? [];

  const handleCreate = async (tabs: string[], permissions: UserPermissions) => {
    if (!username.trim() || !password || !firstName.trim()) {
      showToast('Užpildykite vardą, slaptažodį ir vardą');
      return;
    }
    try {
      await create({ username: username.trim(), password, firstName: firstName.trim(), lastName: lastName.trim(), visibleTabs: tabs, permissions });
      setUsername('');
      setPassword('');
      setFirstName('');
      setLastName('');
      setAddingOpen(false);
      showToast('Darbuotojas pridėtas');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko pridėti darbuotojo');
    }
  };

  const handleUpdate = async (worker: Worker, tabs: string[], permissions: UserPermissions) => {
    try {
      await update(worker.id, { visibleTabs: tabs, permissions });
      setEditingId(null);
      showToast('Išsaugota');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko išsaugoti');
    }
  };

  const handlePasswordChange = async (worker: Worker, password: string) => {
    try {
      await update(worker.id, { password });
      setPasswordOpenId(null);
      showToast('Slaptažodis pakeistas');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko pakeisti slaptažodžio');
    }
  };

  // Type-to-confirm, not a plain confirmDialog click — on explicit
  // request, same reasoning as confirmDeleteTable.ts's own doc comment:
  // an ordinary yes/no button is too easy to hit on autopilot for an
  // action with no undo path.
  const handleDelete = async (worker: Worker) => {
    const ok = await typeToConfirmDialog({
      message: `Ištrinti darbuotoją ${worker.firstName} ${worker.lastName}? Šio veiksmo anuliuoti negalėsite.`,
      requiredText: 'istrinti darbuotoja',
      confirmLabel: 'Ištrinti negrįžtamai',
    });
    if (!ok) return;
    try {
      await remove(worker.id);
      showToast('Darbuotojas ištrintas');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko ištrinti');
    }
  };

  return (
    <div className="workers-view">
      <div className="workers-header">
        <h2>Darbuotojai</h2>
        <button type="button" className="primary" onClick={() => setAddingOpen((v) => !v)}>
          {addingOpen ? 'Atšaukti' : '+ Pridėti darbuotoją'}
        </button>
      </div>

      {addingOpen && (
        <div className="worker-card worker-card-new">
          <div className="worker-form-fields">
            <label className="popover-field">
              <span>Vartotojo vardas</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label className="popover-field">
              <span>Slaptažodis</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <label className="popover-field">
              <span>Vardas</span>
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="popover-field">
              <span>Pavardė</span>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </label>
          </div>
          <WorkerForm
            companyTabs={companyTabs}
            initialTabs={[]}
            initialPermissions={EMPTY_PERMISSIONS}
            submitLabel="Sukurti"
            onSubmit={handleCreate}
            onCancel={() => setAddingOpen(false)}
          />
        </div>
      )}

      {loading && workers.length === 0 && <p>Kraunama…</p>}
      {!loading && workers.length === 0 && !addingOpen && <p className="empty-state">Kol kas nėra darbuotojų.</p>}

      {workers.map((worker) => (
        <div key={worker.id} className="worker-card">
          <div className="worker-card-header">
            <div>
              <strong>
                {worker.firstName} {worker.lastName}
              </strong>
              <span className="worker-card-username">@{worker.username}</span>
            </div>
            <div className="worker-card-actions">
              <button type="button" onClick={() => setActivityOpenId(activityOpenId === worker.id ? null : worker.id)}>
                {activityOpenId === worker.id ? 'Uždaryti veiklą' : 'Veikla'}
              </button>
              <button type="button" onClick={() => setEditingId(editingId === worker.id ? null : worker.id)}>
                {editingId === worker.id ? 'Uždaryti' : 'Redaguoti'}
              </button>
              <button type="button" onClick={() => setPasswordOpenId(passwordOpenId === worker.id ? null : worker.id)}>
                {passwordOpenId === worker.id ? 'Uždaryti' : <><Key className="icon" size={14} /> Slaptažodis</>}
              </button>
              <button type="button" className="danger" onClick={() => void handleDelete(worker)}>
                Ištrinti
              </button>
            </div>
          </div>
          {passwordOpenId === worker.id && (
            <WorkerPasswordForm
              onSubmit={(password) => void handlePasswordChange(worker, password)}
              onCancel={() => setPasswordOpenId(null)}
            />
          )}
          {editingId === worker.id ? (
            <WorkerForm
              companyTabs={companyTabs}
              initialTabs={worker.visibleTabs ?? []}
              initialPermissions={worker.permissions}
              submitLabel="Išsaugoti"
              onSubmit={(tabs, permissions) => void handleUpdate(worker, tabs, permissions)}
            />
          ) : (
            <div className="worker-card-summary">
              <span>{(worker.visibleTabs ?? []).map((t) => TAB_LABELS[t] ?? t).join(', ') || 'Nėra matomų skilčių'}</span>
            </div>
          )}
          {activityOpenId === worker.id && (
            <WorkerActivityPanel worker={worker} onJumpToRow={onJumpToRow} onJumpToContact={onJumpToContact} />
          )}
        </div>
      ))}
    </div>
  );
}
