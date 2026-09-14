import { useEffect, useState } from 'react';
import {
  useIntegrationsStore,
  NON_SECRET_INTEGRATION_FIELDS,
  type IntegrationField,
  type IntegrationModeField,
} from '../../store/useIntegrationsStore';
import { useWorkersStore, type Worker } from '../../store/useWorkersStore';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { LOCAL_API_BASE } from '../../utils/localApi';
import { Check, X, Save, Copy } from 'lucide-react';

interface FieldDef {
  field: IntegrationField;
  label: string;
  placeholder?: string;
}

interface GroupDef {
  title: string;
  hint?: string;
  fields: FieldDef[];
  /** Omitted for Zadarma's SIP/account credentials and LinkedIn's CDP URL —
   * neither has a per-provider Shared/Individual concept (see
   * server/src/accounts/db.ts's new company_integrations columns): Zadarma's
   * account key/secret were always company-scoped only (no per-worker
   * override to fall back from in the first place), and LinkedIn's CDP URL
   * is a single shared browser connection by design (see linkedin/
   * browser.ts's own doc comment), not a per-worker credential. */
  modeField?: IntegrationModeField;
}

// One group per integration, in the same order as INTEGRATION_FIELDS
// server-side. Which tab a group actually gates (per accounts/db.ts's
// computeAvailableFeatures) is called out in `hint` where it isn't
// self-evident from the title — OpenAI/ElevenLabs don't gate a tab of
// their own at all, they power small features inside already-visible
// tabs, so a company can leave those unset with nothing disappearing.
const GROUPS: GroupDef[] = [
  {
    title: 'Zadarma (Skambučiai)',
    hint: 'Raktas ir paslaptis abu būtini, kad skiltis „Skambučiai" realiai veiktų — įjunkite ją atskirai skiltyje „Funkcijos". SIP/Widget SIP yra atsarginis numeris visai įmonei, naudojamas tik jei konkretus darbuotojas neturi savo (žr. „Darbuotojai").',
    fields: [
      { field: 'zadarmaApiKey', label: 'API raktas' },
      { field: 'zadarmaApiSecret', label: 'API paslaptis' },
      { field: 'zadarmaCallerNumber', label: 'Skambinančio numeris', placeholder: '+37066653965' },
      { field: 'zadarmaSip', label: 'SIP vidinis numeris (įmonės)', placeholder: '100' },
      { field: 'zadarmaWidgetSip', label: 'Widget SIP (įmonės)', placeholder: '488048-100' },
    ],
  },
  {
    title: 'Instantly (Paštas)',
    fields: [{ field: 'instantlyApiKey', label: 'API raktas' }],
    modeField: 'instantlyMode',
  },
  {
    title: 'Apollo (Paieška)',
    fields: [{ field: 'apolloApiKey', label: 'API raktas' }],
    modeField: 'apolloMode',
  },
  {
    title: 'Serper',
    hint: 'Papildo skiltį „Paieška" (Apollo raktas) ir gali savarankiškai įjungti skiltį „Naujienos" (žr. „Funkcijos").',
    fields: [{ field: 'serperApiKey', label: 'API raktas' }],
    modeField: 'serperMode',
  },
  {
    title: 'OpenAI',
    hint: 'Neatveria atskiros skilties — naudojamas pagalbinėms funkcijoms (kontaktų tvarkymas ir kt.) kitose skiltyse.',
    fields: [{ field: 'openaiApiKey', label: 'API raktas' }],
    modeField: 'openaiMode',
  },
  {
    title: 'Anthropic (El. laiškų generatorius)',
    fields: [{ field: 'anthropicApiKey', label: 'API raktas' }],
    modeField: 'anthropicMode',
  },
  {
    title: 'ElevenLabs',
    hint: 'Neatveria atskiros skilties — naudojamas skambučių transkribavimui skiltyje „Skambučiai".',
    fields: [{ field: 'elevenlabsApiKey', label: 'API raktas' }],
    modeField: 'elevenlabsMode',
  },
  {
    title: 'LinkedIn',
    hint: 'Kol kas vienu metu gali būti aktyvi tik vienos įmonės LinkedIn sesija — susisiekite dėl nustatymo.',
    fields: [{ field: 'linkedinCdpUrl', label: 'CDP URL', placeholder: 'http://localhost:9222' }],
  },
];

const NON_SECRET = new Set<IntegrationField>(NON_SECRET_INTEGRATION_FIELDS);

// Exactly the IntegrationField values that also exist as a per-worker
// override (see useWorkersStore.ts's WorkerIntegrationOverrides) — every
// group with a `modeField` above has exactly one field, and that field is
// always one of these six; Zadarma's real key/secret and LinkedIn's CDP
// URL have no per-worker equivalent at all (see GroupDef.modeField's own
// doc comment), so those two groups never render the worker-assignment
// sub-section below.
type WorkerOverridableField = 'instantlyApiKey' | 'apolloApiKey' | 'serperApiKey' | 'openaiApiKey' | 'anthropicApiKey' | 'elevenlabsApiKey';

function workerHasProviderKey(worker: Worker, field: WorkerOverridableField): boolean {
  switch (field) {
    case 'instantlyApiKey':
      return !!worker.instantlyApiKeySet;
    case 'apolloApiKey':
      return !!worker.apolloApiKeySet;
    case 'serperApiKey':
      return !!worker.serperApiKeySet;
    case 'openaiApiKey':
      return !!worker.openaiApiKeySet;
    case 'anthropicApiKey':
      return !!worker.anthropicApiKeySet;
    case 'elevenlabsApiKey':
      return !!worker.elevenlabsApiKeySet;
  }
}

interface IntegrationsViewProps {
  /** Omitted = a company's own super_admin managing their own company's
   * integrations directly (the new "Integracijos" top-level tab, gated by
   * the api_keys.view/edit/set_mode registry keys). Passed = the platform
   * admin managing an arbitrary company by id from the independent
   * super-admin dashboard, unchanged from before. Self-service used to be
   * removed entirely (see the doc comment below) because no
   * permission-scoped way to offer it existed yet — this is that gap
   * being closed now that the registry actually gates it. */
  companyId?: string;
}

/** Reachable two ways now: the independent /supersuperadmin dashboard
 * (companyId passed, managing an arbitrary company), or a company's own
 * super_admin's "Integracijos" tab (companyId omitted, managing their own
 * — see useIntegrationsStore.ts's dual-route load/save/clear/setMode).
 * Self-service was removed once already (on explicit request: previously
 * any super-admin pasted in their own company's keys and a tab appeared
 * automatically — see accounts/db.ts's now-removed
 * computeAvailableFeatures) specifically because there was no
 * permission-scoped way to offer it — the api_keys.* registry keys didn't
 * exist yet. Which tabs a configured key actually unlocks is a *separate*,
 * explicit choice in the Funkcijos panel (updateCompanyFeatures) —
 * configuring a key here never makes a tab auto-appear on its own. */
export function IntegrationsView({ companyId }: IntegrationsViewProps) {
  const status = useIntegrationsStore((s) => s.status);
  const loading = useIntegrationsStore((s) => s.loading);
  const saving = useIntegrationsStore((s) => s.saving);
  const error = useIntegrationsStore((s) => s.error);
  const load = useIntegrationsStore((s) => s.load);
  const save = useIntegrationsStore((s) => s.save);
  const clear = useIntegrationsStore((s) => s.clear);
  const setMode = useIntegrationsStore((s) => s.setMode);
  const showToast = useToastStore((s) => s.show);

  const workers = useWorkersStore((s) => s.workers);
  const loadWorkers = useWorkersStore((s) => s.load);
  const updateWorker = useWorkersStore((s) => s.update);

  const [draft, setDraft] = useState<Partial<Record<IntegrationField, string>>>({});
  // Per-company webhook URL — see server/src/index.ts's POST
  // /api/instantly/webhook/:companyId doc comment. Only meaningful in
  // admin mode (an arbitrary company by id) — a company's own super_admin
  // sees their own webhook URL just as well via req.auth!.companyId
  // server-side, but this specific display line needs an id to build the
  // URL string client-side, so it's only rendered when companyId is known.
  const instantlyWebhookUrl = companyId ? `${LOCAL_API_BASE}/api/instantly/webhook/${companyId}` : null;

  useEffect(() => {
    void load(companyId);
    void loadWorkers(companyId);
    // Re-load whenever the owner switches which company they're viewing
    // in the Admin dashboard — companyId is the one prop that can
    // actually change across this component's lifetime (the no-arg
    // "manage my own" usage never changes it at all).
  }, [load, loadWorkers, companyId]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  // One selected worker + one draft value per provider group, keyed by
  // that group's own field — lets each Individual-mode group's "assign a
  // worker's key" sub-form act independently without six separate pieces
  // of component state.
  const [workerPickerSelection, setWorkerPickerSelection] = useState<Partial<Record<WorkerOverridableField, string>>>({});
  const [workerKeyDraft, setWorkerKeyDraft] = useState<Partial<Record<WorkerOverridableField, string>>>({});

  const handleAssignWorkerKey = async (field: WorkerOverridableField) => {
    const workerId = workerPickerSelection[field];
    const value = (workerKeyDraft[field] ?? '').trim();
    if (!workerId || !value) return;
    try {
      await updateWorker(workerId, { [field]: value }, companyId);
      setWorkerKeyDraft((prev) => ({ ...prev, [field]: '' }));
      showToast('Darbuotojo raktas priskirtas');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko priskirti rakto');
    }
  };

  const handleClearWorkerKey = async (field: WorkerOverridableField, workerId: string, workerLabel: string) => {
    const ok = await confirmDialog({ message: `Išvalyti ${workerLabel} individualų raktą?`, danger: true });
    if (!ok) return;
    try {
      await updateWorker(workerId, { [field]: '' }, companyId);
      showToast('Išvalyta');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko išvalyti');
    }
  };

  // Pre-fill only the two non-secret fields once status loads — a secret
  // field's draft deliberately starts (and, after every successful save,
  // goes back to) empty, since the server never re-sends a real secret
  // after saving; leaving a secret input untouched and hitting "Išsaugoti"
  // relies on PATCH's own omitted-field-means-unchanged semantics.
  useEffect(() => {
    if (!status) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const field of NON_SECRET_INTEGRATION_FIELDS) {
        if (next[field] === undefined) next[field] = (status[field] as string | null) ?? '';
      }
      return next;
    });
  }, [status]);

  const handleChange = (field: IntegrationField, value: string) => setDraft((prev) => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    const patch: Partial<Record<IntegrationField, string>> = {};
    for (const [field, value] of Object.entries(draft) as [IntegrationField, string][]) {
      if (value.trim()) patch[field] = value.trim();
    }
    if (Object.keys(patch).length === 0) {
      showToast('Nieko naujo neįvesta');
      return;
    }
    try {
      await save(patch, companyId);
      setDraft((prev) => {
        const next = { ...prev };
        for (const field of Object.keys(patch) as IntegrationField[]) {
          if (!NON_SECRET.has(field)) delete next[field];
        }
        return next;
      });
      showToast('Išsaugota');
    } catch {
      // error already surfaced via the effect watching the store's `error`
    }
  };

  const handleSetMode = async (field: IntegrationModeField, mode: 'shared' | 'individual') => {
    try {
      await setMode(field, mode, companyId);
      showToast(mode === 'individual' ? 'Perjungta į Individual režimą' : 'Perjungta į Shared režimą');
    } catch {
      // error already surfaced via the effect watching the store's `error`
    }
  };

  const handleClear = async (field: IntegrationField, label: string) => {
    const ok = await confirmDialog({
      message: `Išvalyti "${label}"? Susijusi skiltis gali dingti, kol raktas nebus įvestas iš naujo.`,
      danger: true,
    });
    if (!ok) return;
    try {
      await clear(field, companyId);
      setDraft((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
      showToast('Išvalyta');
    } catch {
      // error already surfaced via the effect watching the store's `error`
    }
  };

  if (loading && !status) {
    return (
      <div className="integrations-view">
        <p>Kraunama…</p>
      </div>
    );
  }

  return (
    <div className="integrations-view">
      <p className="integrations-intro">
        Čia įvedami tik patys API raktai — kurios skiltys (Skambučiai, Paštas, Paieška ir t. t.) klientui matomos, nustatoma atskirai
        skiltyje „Funkcijos".
      </p>

      {GROUPS.map((group) => (
        <div key={group.title} className="worker-card integrations-group">
          <div className="worker-card-header">
            <strong>{group.title}</strong>
            {group.modeField && status && (
              <div className="integrations-mode-toggle" title="Shared: darbuotojas be savo rakto naudoja įmonės. Individual: darbuotojas be savo rakto negali naudoti šios integracijos.">
                <button
                  type="button"
                  className={status[group.modeField] !== 'individual' ? 'active' : ''}
                  onClick={() => void handleSetMode(group.modeField!, 'shared')}
                >
                  Shared
                </button>
                <button
                  type="button"
                  className={status[group.modeField] === 'individual' ? 'active' : ''}
                  onClick={() => void handleSetMode(group.modeField!, 'individual')}
                >
                  Individual
                </button>
              </div>
            )}
          </div>
          {group.hint && <p className="integrations-hint">{group.hint}</p>}
          <div className="integrations-fields">
            {group.fields.map(({ field, label, placeholder }) => {
              const secret = !NON_SECRET.has(field);
              const configured = secret ? !!status?.[field] : !!(status?.[field] as string | null);
              return (
                <div key={field} className="integrations-field-row">
                  <label className="popover-field">
                    <span>{label}</span>
                    <input
                      type={secret ? 'password' : 'text'}
                      value={draft[field] ?? ''}
                      placeholder={configured && secret ? '••••••••' : placeholder}
                      autoComplete="off"
                      onChange={(e) => handleChange(field, e.target.value)}
                    />
                  </label>
                  <div className="integrations-field-status">
                    <span className={configured ? 'integrations-badge-set' : 'integrations-badge-unset'}>
                      {configured ? <><Check className="icon" size={14} /> Sukonfigūruota</> : '— Nenustatyta'}
                    </span>
                    {configured && (
                      <button type="button" className="danger" onClick={() => void handleClear(field, label)}>
                        <X className="icon" size={14} /> Išvalyti
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {group.modeField && status?.[group.modeField] === 'individual' && (() => {
            const workerField = group.fields[0].field as WorkerOverridableField;
            const selectedWorkerId = workerPickerSelection[workerField] ?? '';
            const selectedWorker = workers.find((w) => w.id === selectedWorkerId);
            const selectedWorkerHasKey = selectedWorker ? workerHasProviderKey(selectedWorker, workerField) : false;
            return (
              <div className="integrations-worker-assign">
                <p className="integrations-hint">
                  Individual režimu darbuotojas be savo rakto šios integracijos naudoti negalės — priskirkite raktą konkrečiam
                  darbuotojui čia, arba jo paties redagavimo formoje (Darbuotojai).
                </p>
                <div className="integrations-worker-assign-row">
                  <select
                    value={selectedWorkerId}
                    onChange={(e) => setWorkerPickerSelection((prev) => ({ ...prev, [workerField]: e.target.value }))}
                  >
                    <option value="">— pasirinkite darbuotoją —</option>
                    {workers.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.firstName} {w.lastName} ({w.username})
                      </option>
                    ))}
                  </select>
                  {selectedWorker && (
                    <>
                      <input
                        type="password"
                        placeholder={selectedWorkerHasKey ? '••••••••' : 'Naujas raktas'}
                        autoComplete="off"
                        value={workerKeyDraft[workerField] ?? ''}
                        onChange={(e) => setWorkerKeyDraft((prev) => ({ ...prev, [workerField]: e.target.value }))}
                      />
                      <button type="button" onClick={() => void handleAssignWorkerKey(workerField)}>
                        Priskirti
                      </button>
                      {selectedWorkerHasKey && (
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void handleClearWorkerKey(workerField, selectedWorker.id, `${selectedWorker.firstName} ${selectedWorker.lastName}`)}
                        >
                          <X className="icon" size={14} /> Išvalyti
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })()}
          {group.title === 'Instantly (Paštas)' && instantlyWebhookUrl && (
            <div className="integrations-webhook-info">
              <p className="integrations-hint">
                Kad atsakymai patys atsirastų „Visi atsakymai" lentelėje (be rankinio paspaudimo Paštas skiltyje): šios įmonės
                Instantly paskyroje → Integrations → Add Webhook → Event: Reply received → Campaigns: All → įklijuokite šią
                nuorodą. Reikalingas Instantly Hyper Growth (ar aukštesnis) planas. Kiekvienai įmonei — sava, atskira nuoroda.
              </p>
              <div className="integrations-webhook-url-row">
                <code>{instantlyWebhookUrl}</code>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(instantlyWebhookUrl);
                      showToast('Nuoroda nukopijuota');
                    } catch {
                      showToast('Nepavyko nukopijuoti — nėra prieigos prie iškarpinės');
                    }
                  }}
                >
                  <Copy className="icon" size={14} /> Kopijuoti
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
        {saving ? 'Saugoma…' : <><Save className="icon" size={16} /> Išsaugoti</>}
      </button>
    </div>
  );
}
