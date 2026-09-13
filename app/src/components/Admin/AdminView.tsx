import { useEffect, useState } from 'react';
import {
  fetchCompanies,
  fetchCompanyFeatures,
  saveCompanyFeatures,
  fetchLoginLog,
  fetchCompanySuperAdmin,
  updateCompanySuperAdmin,
  blockCompany,
  unblockCompany,
  fetchAuditLog,
  type AdminCompany,
  type LoginLogEntry,
  type AuditLogEntry,
} from '../../utils/adminApi';
import { startPlatformImpersonation } from '../../utils/platformImpersonation';
import { fetchAllBackups, fetchBackupCsv, deleteBackup, restoreBackup, type BackupSummary } from '../../utils/backupsApi';
import { downloadCsv } from '../../utils/csv';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import type { Worker } from '../../store/useWorkersStore';
import { WorkersView } from '../Workers/WorkersView';
import { IntegrationsView } from '../Integrations/IntegrationsView';
import { PermissionsPanel } from './PermissionsPanel';
import { formatHistoryTimestamp } from '../../utils/date';
import { TAB_LABELS, ALL_TABS, workerGrantableTabs } from '../../utils/tabLabels';
import {
  Building2,
  Users,
  Key,
  ToggleLeft,
  Archive,
  History as HistoryIcon,
  ArrowLeft,
  Download,
  Trash2,
  RotateCcw,
  UserCog,
  ShieldCheck,
  Ban,
  ScrollText,
  Eye,
} from 'lucide-react';

// Mirrors server/src/accounts/db.ts's ALWAYS_ON_FEATURES exactly — these
// two can never be turned off, so the Funkcijos checkbox list omits them
// entirely rather than showing a disabled/always-checked box.
const CORE_FEATURES = new Set(['table', 'calendar']);

const ROLE_LABELS: Record<string, string> = { super_admin: 'Administratorius', worker: 'Darbuotojas' };

type TopSection = 'companies' | 'backups' | 'login-log' | 'audit-log';
type CompanyPanel = 'super-admin' | 'workers' | 'integrations' | 'features' | 'permissions';

function FeaturesPanel({ companyId }: { companyId: string }) {
  const [features, setFeatures] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    setFeatures(null);
    void fetchCompanyFeatures(companyId).then((r) => setFeatures(r.enabledFeatures));
  }, [companyId]);

  const toggle = (f: string) => setFeatures((prev) => (prev ? (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]) : prev));

  const handleSave = async () => {
    if (!features) return;
    setSaving(true);
    try {
      const company = await saveCompanyFeatures(companyId, features);
      setFeatures(company.enabledFeatures);
      showToast('Išsaugota');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko išsaugoti');
    } finally {
      setSaving(false);
    }
  };

  if (!features) return <p>Kraunama…</p>;

  return (
    <div className="admin-features-panel">
      <p className="integrations-intro">
        Lentelė ir Kalendorius visada įjungti. Čia pasirenkama, kurios kitos skiltys matomos šiam klientui — pažymėjimas čia
        nesukonfigūruoja jokio API rakto (tam skirta skiltis „Integracijos").
      </p>
      <div className="worker-form-permission-list">
        {ALL_TABS.filter((t) => !CORE_FEATURES.has(t)).map((t) => (
          <label key={t} className="search-filter-checkbox">
            <input type="checkbox" checked={features.includes(t)} onChange={() => toggle(t)} />
            <span>{TAB_LABELS[t] ?? t}</span>
          </label>
        ))}
      </div>
      <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
        {saving ? 'Saugoma…' : 'Išsaugoti'}
      </button>
    </div>
  );
}

/** View/edit a company's own super_admin account — the one account
 * WorkersView (Darbuotojai) never reaches, since its whole store/API
 * surface is hardcoded to role='worker' (see
 * server/src/accounts/db.ts's listWorkers/updateWorker doc comments).
 * Added on explicit request: a company's super_admin had no recovery
 * path of their own if a password was forgotten — a super_admin can
 * already reset a *worker's* forgotten password, but nothing could reset
 * a super_admin's own until this. Username/name are always-visible plain
 * inputs (not a separate view/edit toggle) since there's only four fields
 * total and nothing here is sensitive to display; password is the one
 * field that's write-only (never fetched/shown), matching how every
 * other password field in this app works. */
function SuperAdminAccountPanel({ companyId }: { companyId: string }) {
  const [account, setAccount] = useState<Worker | null>(null);
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    setAccount(null);
    setNewPassword('');
    void fetchCompanySuperAdmin(companyId).then((w) => {
      setAccount(w);
      setUsername(w.username);
      setFirstName(w.firstName);
      setLastName(w.lastName);
    });
  }, [companyId]);

  const handleSave = async () => {
    if (!username.trim() || !firstName.trim()) {
      showToast('Užpildykite vartotojo vardą ir vardą');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateCompanySuperAdmin(companyId, {
        username: username.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        password: newPassword || undefined,
      });
      setAccount(updated);
      setUsername(updated.username);
      setFirstName(updated.firstName);
      setLastName(updated.lastName);
      setNewPassword('');
      showToast('Išsaugota');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko išsaugoti');
    } finally {
      setSaving(false);
    }
  };

  if (!account) return <p>Kraunama…</p>;

  return (
    <div className="admin-super-admin-panel">
      <label className="popover-field">
        <span>Vartotojo vardas</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="popover-field">
        <span>Vardas</span>
        <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
      </label>
      <label className="popover-field">
        <span>Pavardė</span>
        <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </label>
      <label className="popover-field">
        <span>Naujas slaptažodis</span>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="Palikite tuščią, jei nekeičiate"
        />
      </label>
      <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
        {saving ? 'Saugoma…' : 'Išsaugoti'}
      </button>
    </div>
  );
}

/** Shared by this dashboard's own Duomenys section (admin=true, every
 * company) and the Workspace screen's own-company backups panel
 * (OwnBackupsView.tsx, admin=false) — same table, same three actions,
 * differing only in which route family they hit (see backupsApi.ts's own
 * doc comment on the `admin` flag). */
export function BackupsPanel({ backups, admin, onChanged }: { backups: BackupSummary[]; admin: boolean; onChanged: () => void }) {
  const showToast = useToastStore((s) => s.show);

  const handleDownload = async (b: BackupSummary) => {
    try {
      const { filename, csv } = await fetchBackupCsv(b.id, admin);
      downloadCsv(filename, csv);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko atsisiųsti');
    }
  };

  const handleDelete = async (b: BackupSummary) => {
    const ok = await confirmDialog({ message: `Ištrinti „${b.tableName}" kopiją (${formatHistoryTimestamp(b.createdAt)})?`, danger: true });
    if (!ok) return;
    try {
      await deleteBackup(b.id, admin);
      showToast('Kopija ištrinta');
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko ištrinti');
    }
  };

  const handleRestore = async (b: BackupSummary) => {
    const ok = await confirmDialog({
      message: `Atkurti „${b.tableName}" (${formatHistoryTimestamp(b.createdAt)}) kaip naują lentelę? Dabartiniai duomenys nebus paliesti.`,
    });
    if (!ok) return;
    try {
      const table = await restoreBackup(b.id, admin);
      showToast(`Sukurta nauja lentelė: ${table.name}`);
      // Only when this is the caller's OWN company (admin=false) — the
      // owner's cross-company restore creates a table under a *different*
      // company than the one useWorkspaceStore is scoped to (the owner's
      // own req.auth.companyId), so refreshing it here would just re-fetch
      // the owner's own unrelated table list for no reason.
      if (!admin) void useWorkspaceStore.getState().init();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko atkurti');
    }
  };

  if (backups.length === 0) return <p className="empty-state">Kol kas nėra bėkapų.</p>;

  return (
    <table className="admin-backups-table">
      <thead>
        <tr>
          <th>Lentelė</th>
          <th>Eilučių</th>
          <th>Data</th>
          <th>Veiksmai</th>
        </tr>
      </thead>
      <tbody>
        {backups.map((b) => (
          <tr key={b.id}>
            <td>{b.tableName}</td>
            <td>{b.rowCount}</td>
            <td>{formatHistoryTimestamp(b.createdAt)}</td>
            <td className="admin-backups-actions">
              <button type="button" onClick={() => void handleDownload(b)}>
                <Download className="icon" size={14} /> CSV
              </button>
              <button type="button" onClick={() => void handleRestore(b)}>
                <RotateCcw className="icon" size={14} /> Atkurti
              </button>
              <button type="button" className="danger" onClick={() => void handleDelete(b)}>
                <Trash2 className="icon" size={14} /> Ištrinti
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Owner-only "CEO/founder" dashboard — full cross-company visibility and
 * control, on explicit request. Companies (Įmonės) is the default/home
 * section; selecting one drills into that company's own workers/
 * integrations/features, mirroring the existing Workspace→table
 * drill-in pattern elsewhere in this app. Duomenys and Prisijungimų
 * istorija stay top-level (cross-company by nature, nothing to select
 * into first). */
export function AdminView() {
  const [section, setSection] = useState<TopSection>('companies');
  const [companies, setCompanies] = useState<AdminCompany[]>([]);
  const [companiesReady, setCompaniesReady] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [companyPanel, setCompanyPanel] = useState<CompanyPanel>('workers');

  const [allBackups, setAllBackups] = useState<BackupSummary[]>([]);
  const [backupsReady, setBackupsReady] = useState(false);

  const [loginLog, setLoginLog] = useState<LoginLogEntry[]>([]);
  const [loginLogReady, setLoginLogReady] = useState(false);
  const [loginLogCompanyFilter, setLoginLogCompanyFilter] = useState('');

  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [auditLogReady, setAuditLogReady] = useState(false);
  const [auditLogCompanyFilter, setAuditLogCompanyFilter] = useState('');

  const [blocking, setBlocking] = useState(false);
  const [impersonating, setImpersonating] = useState(false);
  const showToast = useToastStore((s) => s.show);

  const refreshCompanies = () => {
    void fetchCompanies().then((r) => {
      setCompanies(r.companies);
      setCompaniesReady(true);
    });
  };
  const refreshBackups = () => {
    void fetchAllBackups().then((r) => {
      setAllBackups(r.backups);
      setBackupsReady(true);
    });
  };

  useEffect(() => {
    refreshCompanies();
    // Load once on mount only.
  }, []);

  useEffect(() => {
    if (section === 'backups' && !backupsReady) refreshBackups();
  }, [section, backupsReady]);

  useEffect(() => {
    if (section !== 'login-log') return;
    setLoginLogReady(false);
    void fetchLoginLog(loginLogCompanyFilter || undefined).then((r) => {
      setLoginLog(r.entries);
      setLoginLogReady(true);
    });
  }, [section, loginLogCompanyFilter]);

  useEffect(() => {
    if (section !== 'audit-log') return;
    setAuditLogReady(false);
    void fetchAuditLog(auditLogCompanyFilter || undefined).then((r) => {
      setAuditLog(r.entries);
      setAuditLogReady(true);
    });
  }, [section, auditLogCompanyFilter]);

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId) ?? null;

  const handleToggleBlock = async (company: AdminCompany) => {
    const blockedNow = !!company.blockedAt;
    if (!blockedNow) {
      const ok = await confirmDialog({
        message: `Užblokuoti „${company.name}"? Kiekvienas šios įmonės vartotojas (įskaitant jau prisijungusius) iškart nebegalės atlikti jokio veiksmo.`,
        danger: true,
      });
      if (!ok) return;
    }
    setBlocking(true);
    try {
      if (blockedNow) await unblockCompany(company.id);
      else await blockCompany(company.id);
      refreshCompanies();
      showToast(blockedNow ? 'Įmonė atblokuota' : 'Įmonė užblokuota');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko pakeisti būsenos');
    } finally {
      setBlocking(false);
    }
  };

  const handleImpersonate = async (company: AdminCompany) => {
    setImpersonating(true);
    try {
      await startPlatformImpersonation(company.id);
      // startPlatformImpersonation navigates away (window.location.href)
      // on success — nothing left to do here even on the happy path.
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko prisijungti kaip administratorius');
      setImpersonating(false);
    }
  };

  if (selectedCompany) {
    return (
      <div className="admin-view">
        <div className="workers-header">
          <button type="button" onClick={() => setSelectedCompanyId(null)}>
            <ArrowLeft className="icon" size={16} /> Įmonės
          </button>
          <h2>
            {selectedCompany.name}
            {selectedCompany.blockedAt && <span className="admin-blocked-badge">Užblokuota</span>}
          </h2>
          <div className="workers-header-actions">
            <button type="button" disabled={impersonating} onClick={() => void handleImpersonate(selectedCompany)}>
              <Eye className="icon" size={14} /> {impersonating ? 'Jungiamasi…' : 'Peržiūrėti kaip administratorius'}
            </button>
            <button
              type="button"
              className={selectedCompany.blockedAt ? '' : 'danger'}
              disabled={blocking}
              onClick={() => void handleToggleBlock(selectedCompany)}
            >
              {selectedCompany.blockedAt ? (
                <><ShieldCheck className="icon" size={14} /> Atblokuoti</>
              ) : (
                <><Ban className="icon" size={14} /> Blokuoti</>
              )}
            </button>
          </div>
        </div>
        <nav className="linkedin-subnav">
          <button type="button" className={companyPanel === 'super-admin' ? 'active' : ''} onClick={() => setCompanyPanel('super-admin')}>
            <UserCog className="icon" size={16} /> Administratorius
          </button>
          <button type="button" className={companyPanel === 'permissions' ? 'active' : ''} onClick={() => setCompanyPanel('permissions')}>
            <ShieldCheck className="icon" size={16} /> Leidimai
          </button>
          <button type="button" className={companyPanel === 'workers' ? 'active' : ''} onClick={() => setCompanyPanel('workers')}>
            <Users className="icon" size={16} /> Darbuotojai
          </button>
          <button type="button" className={companyPanel === 'integrations' ? 'active' : ''} onClick={() => setCompanyPanel('integrations')}>
            <Key className="icon" size={16} /> Integracijos
          </button>
          <button type="button" className={companyPanel === 'features' ? 'active' : ''} onClick={() => setCompanyPanel('features')}>
            <ToggleLeft className="icon" size={16} /> Funkcijos
          </button>
        </nav>
        {companyPanel === 'super-admin' && <SuperAdminAccountPanel companyId={selectedCompany.id} />}
        {companyPanel === 'permissions' && <PermissionsPanel companyId={selectedCompany.id} />}
        {companyPanel === 'workers' && (
          <WorkersView companyId={selectedCompany.id} companyTabs={workerGrantableTabs(selectedCompany.enabledFeatures)} />
        )}
        {companyPanel === 'integrations' && <IntegrationsView companyId={selectedCompany.id} />}
        {companyPanel === 'features' && <FeaturesPanel companyId={selectedCompany.id} />}
      </div>
    );
  }

  return (
    <div className="admin-view">
      <nav className="linkedin-subnav">
        <button type="button" className={section === 'companies' ? 'active' : ''} onClick={() => setSection('companies')}>
          <Building2 className="icon" size={16} /> Įmonės
        </button>
        <button type="button" className={section === 'backups' ? 'active' : ''} onClick={() => setSection('backups')}>
          <Archive className="icon" size={16} /> Duomenys
        </button>
        <button type="button" className={section === 'login-log' ? 'active' : ''} onClick={() => setSection('login-log')}>
          <HistoryIcon className="icon" size={16} /> Prisijungimų istorija
        </button>
        <button type="button" className={section === 'audit-log' ? 'active' : ''} onClick={() => setSection('audit-log')}>
          <ScrollText className="icon" size={16} /> Audito žurnalas
        </button>
      </nav>

      {section === 'companies' &&
        (companiesReady && companies.length === 0 ? (
          <p className="empty-state">Kol kas nėra įmonių.</p>
        ) : (
          <div className="table-cards">
            {companies.map((c) => (
              <div key={c.id} className="table-card" onClick={() => setSelectedCompanyId(c.id)}>
                <div className="table-card-name">
                  {c.name}
                  {c.blockedAt && <span className="admin-blocked-badge">Užblokuota</span>}
                </div>
                <div className="table-card-meta">{c.enabledFeatures.length} funkcij(ų)</div>
              </div>
            ))}
          </div>
        ))}

      {section === 'backups' && (backupsReady ? <BackupsPanel backups={allBackups} admin onChanged={refreshBackups} /> : <p>Kraunama…</p>)}

      {section === 'login-log' && (
        <div className="admin-login-log">
          <select value={loginLogCompanyFilter} onChange={(e) => setLoginLogCompanyFilter(e.target.value)}>
            <option value="">Visos įmonės</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {loginLogReady ? (
            loginLog.length === 0 ? (
              <p className="empty-state">Kol kas nėra prisijungimų.</p>
            ) : (
              <table className="admin-backups-table">
                <thead>
                  <tr>
                    <th>Vartotojas</th>
                    <th>Rolė</th>
                    <th>Įmonė</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {loginLog.map((e) => (
                    <tr key={e.id}>
                      <td>{e.username}</td>
                      <td>{ROLE_LABELS[e.role] ?? e.role}</td>
                      <td>{companies.find((c) => c.id === e.companyId)?.name ?? e.companyId}</td>
                      <td>{formatHistoryTimestamp(e.loggedInAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p>Kraunama…</p>
          )}
        </div>
      )}

      {section === 'audit-log' && (
        <div className="admin-login-log">
          <select value={auditLogCompanyFilter} onChange={(e) => setAuditLogCompanyFilter(e.target.value)}>
            <option value="">Visos įmonės</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {auditLogReady ? (
            auditLog.length === 0 ? (
              <p className="empty-state">Kol kas nėra įrašų.</p>
            ) : (
              <table className="admin-backups-table">
                <thead>
                  <tr>
                    <th>Veiksmas</th>
                    <th>Atlikėjas</th>
                    <th>Įmonė</th>
                    <th>Taikinys</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.map((e) => (
                    <tr key={e.id}>
                      <td>{e.action}</td>
                      <td>{ROLE_LABELS[e.actorRole ?? ''] ?? e.actorRole ?? '—'}</td>
                      <td>{companies.find((c) => c.id === e.companyId)?.name ?? e.companyId ?? '—'}</td>
                      <td>
                        {e.targetType ?? '—'} {e.targetId ?? ''}
                      </td>
                      <td>{formatHistoryTimestamp(e.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p>Kraunama…</p>
          )}
        </div>
      )}
    </div>
  );
}
