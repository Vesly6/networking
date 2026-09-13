import { useEffect, useState } from 'react';
import type { UserPermissions } from '../../store/useAuthStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useWorkersStore, type Worker, type WorkerActionLogEntry, type WorkerActionType } from '../../store/useWorkersStore';
import { useToastStore } from '../../store/useToastStore';
import { typeToConfirmDialog } from '../../store/useTypeToConfirmStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { formatHistoryTimestamp } from '../../utils/date';
import { TAB_LABELS } from '../../utils/tabLabels';
import { ALL_PERMISSION_KEYS, PERMISSION_GROUPS, PERMISSIONS, type PermissionKey } from '../../utils/permissions';
import { ArrowRight, Key, UserCog, X } from 'lucide-react';

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
                  {/* Only present when a super_admin performed this while
                      impersonating the worker (see useAuthStore.ts's
                      impersonateWorker) — surfaces the real actor without
                      losing which worker's activity this otherwise reads
                      as. */}
                  {a.realUserName && <> · (super adminas {a.realUserName} veikė kaip)</>}
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

export interface WorkerZadarmaFields {
  zadarmaSip: string;
  zadarmaWidgetSip: string;
  zadarmaCallerNumber: string;
}

const EMPTY_ZADARMA: WorkerZadarmaFields = { zadarmaSip: '', zadarmaWidgetSip: '', zadarmaCallerNumber: '' };

/** The remaining plain-API-key integrations a worker can override — see
 * server/src/accounts/db.ts's per-worker migration. Unlike the Zadarma
 * fields above (a phone/extension number, not actually secret — always
 * pre-filled with the real value), these are real secrets the server never
 * re-sends once saved (see index.ts's workerToPublic()), so the form only
 * ever knows whether one is *set* (WorkerSecretsSet below), never its
 * actual value — same "never round-trip a saved secret into an input"
 * rule this app's own IntegrationsView.tsx already follows for the
 * company-wide keys. */
type SecretApiKey = 'apolloApiKey' | 'instantlyApiKey' | 'serperApiKey' | 'openaiApiKey' | 'anthropicApiKey' | 'elevenlabsApiKey';
const SECRET_API_KEY_FIELDS: Array<{ key: SecretApiKey; label: string }> = [
  { key: 'apolloApiKey', label: 'Apollo.io' },
  { key: 'instantlyApiKey', label: 'Instantly.ai' },
  { key: 'serperApiKey', label: 'serper.dev' },
  { key: 'openaiApiKey', label: 'OpenAI' },
  { key: 'anthropicApiKey', label: 'Anthropic (Claude)' },
  { key: 'elevenlabsApiKey', label: 'ElevenLabs' },
];
type WorkerSecretsSet = Partial<Record<SecretApiKey, boolean>>;
/** Only the keys the admin actually touched this session end up here —
 * typing a value adds `key: theValue`; clicking "Išvalyti" adds `key: ''`
 * (a deliberate clear, distinct from simply never having typed anything);
 * an untouched field is just absent, so submitting this object leaves
 * every other secret exactly as it was (see UpdateWorkerInput's own
 * "omitted ≠ blank" convention, mirrored here on the client). */
type SecretDrafts = Partial<Record<SecretApiKey, string>>;

function WorkerForm({
  companyTabs,
  initialFirstName = '',
  initialLastName = '',
  initialTabs,
  initialPermissions,
  initialPermissionKeys = [],
  actingPermissionKeys,
  initialZadarma = EMPTY_ZADARMA,
  initialSecretsSet = {},
  submitLabel,
  onSubmit,
  onCancel,
}: {
  companyTabs: string[];
  /** Empty for a brand-new worker (the create flow); the worker's current
   * name when editing an existing one — this is what makes renaming a
   * worker in place possible (see UpdateWorkerInput's own doc comment for
   * why that's a deliberate, safe workflow: `id` never changes, and past
   * note/comment authorship is a permanent snapshot, not re-resolved
   * live). */
  initialFirstName?: string;
  initialLastName?: string;
  initialTabs: string[];
  initialPermissions: UserPermissions;
  /** The worker's own current raw grant (Worker.grantedPermissionKeys) —
   * not the effective/intersected set, since this form should show exactly
   * what was granted even if the company's own ceiling currently makes
   * some of it inert (see utils/permissions.ts's own doc comment). Empty
   * for a brand-new worker. */
  initialPermissionKeys?: PermissionKey[];
  /** The bound on what this form is even allowed to check — a company's
   * own super_admin can only grant a subset of their own current effective
   * set (enforced server-side too, see index.ts's PATCH /api/workers/:id),
   * so WorkersView passes their own permissionKeys here. The platform
   * Admin dashboard (companyId set) passes the full registry instead — the
   * platform IS the ceiling's own author, and over-granting there is
   * already structurally inert (see pickPermissionKeys' own server-side
   * doc comment), so there's nothing to bound. */
  actingPermissionKeys: PermissionKey[];
  initialZadarma?: WorkerZadarmaFields;
  initialSecretsSet?: WorkerSecretsSet;
  submitLabel: string;
  onSubmit: (
    firstName: string,
    lastName: string,
    tabs: string[],
    permissions: UserPermissions,
    permissionKeys: PermissionKey[],
    zadarma: WorkerZadarmaFields,
    secretDrafts: SecretDrafts,
  ) => void;
  onCancel?: () => void;
}) {
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [tabs, setTabs] = useState<string[]>(initialTabs);
  const [permissions, setPermissions] = useState<UserPermissions>(initialPermissions);
  const [permissionKeys, setPermissionKeys] = useState<PermissionKey[]>(initialPermissionKeys);
  const [zadarma, setZadarma] = useState<WorkerZadarmaFields>(initialZadarma);
  const [secretDrafts, setSecretDrafts] = useState<SecretDrafts>({});

  const toggleTab = (t: string) => setTabs((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  const togglePermission = (key: keyof UserPermissions) => setPermissions((prev) => ({ ...prev, [key]: !prev[key] }));
  const togglePermissionKey = (key: PermissionKey) =>
    setPermissionKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const handleClearSecret = async (key: SecretApiKey, label: string) => {
    const ok = await confirmDialog({ message: `Išvalyti „${label}“ raktą šiam darbuotojui?`, danger: true });
    if (!ok) return;
    setSecretDrafts((prev) => ({ ...prev, [key]: '' }));
  };

  return (
    <div className="worker-form-permissions">
      <div className="worker-form-section">
        <span className="worker-form-section-label">Vardas Pavardė</span>
        <div className="worker-form-fields">
          <label className="popover-field">
            <span>Vardas</span>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </label>
          <label className="popover-field">
            <span>Pavardė</span>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
        </div>
      </div>
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
      <div className="worker-form-section">
        <span className="worker-form-section-label">Leidimai (integracijos, API raktai, administravimas)</span>
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.title} className="worker-form-permission-group">
            <span className="worker-form-permission-group-title">{group.title}</span>
            <div className="worker-form-permission-list">
              {group.keys.map((key) => {
                const grantable = actingPermissionKeys.includes(key);
                return (
                  <label
                    key={key}
                    className="search-filter-checkbox"
                    title={grantable ? undefined : 'Jūs patys neturite šios teisės — negalite jos suteikti'}
                  >
                    <input
                      type="checkbox"
                      checked={permissionKeys.includes(key)}
                      disabled={!grantable}
                      onChange={() => togglePermissionKey(key)}
                    />
                    <span>{PERMISSIONS[key]}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="worker-form-section worker-form-always-restricted">
        <span className="worker-form-section-label">Visada apribota (nepriklausomai nuo varnelių)</span>
        <ul>
          {ALWAYS_RESTRICTED.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </div>
      <div className="worker-form-section">
        <span className="worker-form-section-label">Zadarma (nebūtina — jei tuščia, naudojamas bendras įmonės/serverio numeris)</span>
        <div className="worker-form-fields">
          <label className="popover-field">
            <span>SIP vidinis numeris</span>
            <input
              value={zadarma.zadarmaSip}
              onChange={(e) => setZadarma((prev) => ({ ...prev, zadarmaSip: e.target.value }))}
              placeholder="100"
              autoComplete="off"
            />
          </label>
          <label className="popover-field">
            <span>Widget SIP (account-extension)</span>
            <input
              value={zadarma.zadarmaWidgetSip}
              onChange={(e) => setZadarma((prev) => ({ ...prev, zadarmaWidgetSip: e.target.value }))}
              placeholder="488048-100"
              autoComplete="off"
            />
          </label>
          <label className="popover-field">
            <span>Skambinantis numeris</span>
            <input
              value={zadarma.zadarmaCallerNumber}
              onChange={(e) => setZadarma((prev) => ({ ...prev, zadarmaCallerNumber: e.target.value }))}
              placeholder="+37066653965"
              autoComplete="off"
            />
          </label>
        </div>
      </div>
      <div className="worker-form-section">
        <span className="worker-form-section-label">
          Kitos integracijos (nebūtina — jei tuščia, naudojamas bendras įmonės raktas)
        </span>
        <div className="worker-form-fields">
          {SECRET_API_KEY_FIELDS.map(({ key, label }) => {
            const isSet = !!initialSecretsSet[key];
            const draft = secretDrafts[key];
            const willClear = draft === '';
            return (
              <div key={key} className="integrations-field-row">
                <label className="popover-field">
                  <span>{label}</span>
                  <input
                    type="password"
                    value={draft ?? ''}
                    onChange={(e) => setSecretDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder={isSet && !willClear ? '••••••••' : 'API raktas'}
                    autoComplete="off"
                  />
                </label>
                {isSet && (
                  <div className="integrations-field-status">
                    <span className={willClear ? 'integrations-badge-unset' : 'integrations-badge-set'}>
                      {willClear ? '— bus išvalyta' : 'Sukonfigūruota'}
                    </span>
                    {!willClear && (
                      <button type="button" className="danger" onClick={() => void handleClearSecret(key, label)}>
                        <X className="icon" size={14} /> Išvalyti
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="worker-form-actions">
        <button
          type="button"
          className="primary"
          onClick={() => onSubmit(firstName, lastName, tabs, permissions, permissionKeys, zadarma, secretDrafts)}
        >
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
   * caller in this app uses. Optional — the owner's Admin-dashboard usage
   * (viewing another company's workers) has no jump-to-row destination
   * (no table open at all in that context) and simply doesn't show the
   * activity panel these power (see activityOpenId below). */
  onJumpToRow?: (tableId: string, rowId: string) => void;
  onJumpToContact?: (tableId: string, rowId: string, columnId: string, contactId: string) => void;
  /** The tab chips offered in "Matomos skiltys" when creating/editing a
   * worker — always the TARGET company's own enabledFeatures, which is
   * why this is a required prop rather than derived internally from
   * useAuthStore (the logged-in user's own company is only the right
   * answer when companyId below is omitted). */
  companyTabs: string[];
  /** Omitted: manage the caller's own company's workers (/api/workers) —
   * a company's own super_admin, or the owner viewing their own company.
   * Passed (only from the owner's Admin dashboard): manage an arbitrary
   * client's workers (/api/admin/companies/:id/workers) instead. The
   * per-worker "Veikla" activity panel is hidden in this mode — see its
   * own note below on why that route isn't cross-company-capable yet. */
  companyId?: string;
  /** Called right after successfully impersonating a worker — App.tsx uses
   * this to reset to the workspace root, same as ImpersonationBanner's own
   * onReturned, since the admin's current screen/table may not exist or
   * apply from the worker's point of view (or vice versa on return).
   * Omitted in the owner's cross-company Admin dashboard usage (companyId
   * set) — impersonation is only ever "log in as MY OWN worker," so that
   * mode doesn't offer the button at all (see its own gating below). */
  onImpersonated?: () => void;
}

/** Super-admin (or owner, viewing their own company) manages the workers
 * under their own company — App.tsx only ever renders this tab's nav
 * button for those two roles (see AppScreen's own doc comment there for
 * why "manage workers" isn't a Tab/enabledFeatures-gated concept the same
 * way Calls/LinkedIn/Search are). Also reused, with companyId set, by the
 * owner's Admin dashboard to manage an arbitrary client's workers. */
export function WorkersView({ onJumpToRow, onJumpToContact, companyTabs, companyId, onImpersonated }: WorkersViewProps) {
  const workers = useWorkersStore((s) => s.workers);
  const loading = useWorkersStore((s) => s.loading);
  const error = useWorkersStore((s) => s.error);
  const actionsError = useWorkersStore((s) => s.actionsError);
  const load = useWorkersStore((s) => s.load);
  const create = useWorkersStore((s) => s.create);
  const update = useWorkersStore((s) => s.update);
  const remove = useWorkersStore((s) => s.remove);
  const impersonateWorker = useAuthStore((s) => s.impersonateWorker);
  const showToast = useToastStore((s) => s.show);

  const [addingOpen, setAddingOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activityOpenId, setActivityOpenId] = useState<string | null>(null);
  const [passwordOpenId, setPasswordOpenId] = useState<string | null>(null);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);

  useEffect(() => {
    void load(companyId);
    // Re-load when the owner switches which company they're viewing.
  }, [load, companyId]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  useEffect(() => {
    if (actionsError) showToast(actionsError);
  }, [actionsError, showToast]);

  // A company's own super_admin can only grant a subset of their own
  // current effective set (see WorkerForm's own doc comment on
  // actingPermissionKeys) — the platform Admin dashboard (companyId set)
  // has no such bound, since over-granting there is already structurally
  // inert server-side.
  const ownPermissionKeys = useAuthStore((s) => s.user?.permissionKeys);
  const actingPermissionKeys = companyId ? ALL_PERMISSION_KEYS : (ownPermissionKeys ?? []);

  const handleCreate = async (
    firstName: string,
    lastName: string,
    tabs: string[],
    permissions: UserPermissions,
    permissionKeys: PermissionKey[],
    zadarma: WorkerZadarmaFields,
    secretDrafts: SecretDrafts,
  ) => {
    if (!username.trim() || !password || !firstName.trim()) {
      showToast('Užpildykite vardą, slaptažodį ir vardą');
      return;
    }
    try {
      await create(
        {
          username: username.trim(),
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          visibleTabs: tabs,
          permissions,
          permissionKeys,
          zadarmaSip: zadarma.zadarmaSip || undefined,
          zadarmaWidgetSip: zadarma.zadarmaWidgetSip || undefined,
          zadarmaCallerNumber: zadarma.zadarmaCallerNumber || undefined,
          ...secretDrafts,
        },
        companyId,
      );
      setUsername('');
      setPassword('');
      setAddingOpen(false);
      showToast('Darbuotojas pridėtas');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko pridėti darbuotojo');
    }
  };

  const handleUpdate = async (
    worker: Worker,
    firstName: string,
    lastName: string,
    tabs: string[],
    permissions: UserPermissions,
    permissionKeys: PermissionKey[],
    zadarma: WorkerZadarmaFields,
    secretDrafts: SecretDrafts,
  ) => {
    if (!firstName.trim()) {
      showToast('Vardas negali būti tuščias');
      return;
    }
    try {
      await update(
        worker.id,
        {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          visibleTabs: tabs,
          permissions,
          permissionKeys,
          zadarmaSip: zadarma.zadarmaSip,
          zadarmaWidgetSip: zadarma.zadarmaWidgetSip,
          zadarmaCallerNumber: zadarma.zadarmaCallerNumber,
          ...secretDrafts,
        },
        companyId,
      );
      setEditingId(null);
      showToast('Išsaugota');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko išsaugoti');
    }
  };

  const handleImpersonate = async (worker: Worker) => {
    setImpersonatingId(worker.id);
    try {
      await impersonateWorker(worker.id);
      onImpersonated?.();
      showToast(`Prisijungėte kaip ${worker.firstName} ${worker.lastName}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko prisijungti kaip darbuotojas');
    } finally {
      setImpersonatingId(null);
    }
  };

  const handlePasswordChange = async (worker: Worker, password: string) => {
    try {
      await update(worker.id, { password }, companyId);
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
      await remove(worker.id, companyId);
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
          </div>
          <WorkerForm
            companyTabs={companyTabs}
            initialTabs={[]}
            initialPermissions={EMPTY_PERMISSIONS}
            actingPermissionKeys={actingPermissionKeys}
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
              {/* Only in the "manage my own company" mode — the underlying
                  worker-actions route isn't cross-company-capable yet (see
                  its own scope note in useWorkersStore.ts), so there's
                  nothing correct to show here when the owner is viewing a
                  different company's workers. */}
              {!companyId && (
                <button type="button" onClick={() => setActivityOpenId(activityOpenId === worker.id ? null : worker.id)}>
                  {activityOpenId === worker.id ? 'Uždaryti veiklą' : 'Veikla'}
                </button>
              )}
              {/* Only in the "manage my own company" mode, same reasoning
                  as the "Veikla" gating above — impersonation is only ever
                  "log in as MY OWN worker," not something the owner's
                  cross-company Admin dashboard should offer. */}
              {!companyId && (
                <button
                  type="button"
                  onClick={() => void handleImpersonate(worker)}
                  disabled={impersonatingId === worker.id}
                  title="Laikinai prisijungti prie šio darbuotojo peržiūros, išlaikant visas administratoriaus teises"
                >
                  <UserCog className="icon" size={14} /> {impersonatingId === worker.id ? 'Jungiamasi…' : 'Prisijungti kaip'}
                </button>
              )}
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
              initialFirstName={worker.firstName}
              initialLastName={worker.lastName}
              initialTabs={worker.visibleTabs ?? []}
              initialPermissions={worker.permissions}
              initialPermissionKeys={worker.grantedPermissionKeys}
              actingPermissionKeys={actingPermissionKeys}
              initialZadarma={{
                zadarmaSip: worker.zadarmaSip ?? '',
                zadarmaWidgetSip: worker.zadarmaWidgetSip ?? '',
                zadarmaCallerNumber: worker.zadarmaCallerNumber ?? '',
              }}
              initialSecretsSet={{
                apolloApiKey: worker.apolloApiKeySet,
                instantlyApiKey: worker.instantlyApiKeySet,
                serperApiKey: worker.serperApiKeySet,
                openaiApiKey: worker.openaiApiKeySet,
                anthropicApiKey: worker.anthropicApiKeySet,
                elevenlabsApiKey: worker.elevenlabsApiKeySet,
              }}
              submitLabel="Išsaugoti"
              onSubmit={(firstName, lastName, tabs, permissions, permissionKeys, zadarma, secretDrafts) =>
                void handleUpdate(worker, firstName, lastName, tabs, permissions, permissionKeys, zadarma, secretDrafts)
              }
            />
          ) : (
            <div className="worker-card-summary">
              <span>{(worker.visibleTabs ?? []).map((t) => TAB_LABELS[t] ?? t).join(', ') || 'Nėra matomų skilčių'}</span>
            </div>
          )}
          {activityOpenId === worker.id && onJumpToRow && onJumpToContact && (
            <WorkerActivityPanel worker={worker} onJumpToRow={onJumpToRow} onJumpToContact={onJumpToContact} />
          )}
        </div>
      ))}
    </div>
  );
}
