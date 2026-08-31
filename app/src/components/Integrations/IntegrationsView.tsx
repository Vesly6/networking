import { useEffect, useState } from 'react';
import { useIntegrationsStore, NON_SECRET_INTEGRATION_FIELDS, type IntegrationField } from '../../store/useIntegrationsStore';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { Check, X, Save } from 'lucide-react';

interface FieldDef {
  field: IntegrationField;
  label: string;
  placeholder?: string;
}

interface GroupDef {
  title: string;
  hint?: string;
  fields: FieldDef[];
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
    hint: 'Raktas ir paslaptis abu būtini — skiltis „Skambučiai" atsiranda tik kai užpildyti abu laukai.',
    fields: [
      { field: 'zadarmaApiKey', label: 'API raktas' },
      { field: 'zadarmaApiSecret', label: 'API paslaptis' },
      { field: 'zadarmaCallerNumber', label: 'Skambinančio numeris', placeholder: '+37066653965' },
    ],
  },
  {
    title: 'Instantly (Paštas)',
    fields: [{ field: 'instantlyApiKey', label: 'API raktas' }],
  },
  {
    title: 'Apollo (Paieška)',
    fields: [{ field: 'apolloApiKey', label: 'API raktas' }],
  },
  {
    title: 'Serper',
    hint: 'Papildo skiltį „Paieška" — pati skiltis atsiranda nuo Apollo rakto, šis tik praplečia jos galimybes.',
    fields: [{ field: 'serperApiKey', label: 'API raktas' }],
  },
  {
    title: 'OpenAI',
    hint: 'Neatveria atskiros skilties — naudojamas pagalbinėms funkcijoms (kontaktų tvarkymas ir kt.) kitose skiltyse.',
    fields: [{ field: 'openaiApiKey', label: 'API raktas' }],
  },
  {
    title: 'Anthropic (El. laiškų generatorius)',
    fields: [{ field: 'anthropicApiKey', label: 'API raktas' }],
  },
  {
    title: 'ElevenLabs',
    hint: 'Neatveria atskiros skilties — naudojamas skambučių transkribavimui skiltyje „Skambučiai".',
    fields: [{ field: 'elevenlabsApiKey', label: 'API raktas' }],
  },
  {
    title: 'LinkedIn',
    hint: 'Kol kas vienu metu gali būti aktyvi tik vienos įmonės LinkedIn sesija — susisiekite dėl nustatymo.',
    fields: [{ field: 'linkedinCdpUrl', label: 'CDP URL', placeholder: 'http://localhost:9222' }],
  },
];

const NON_SECRET = new Set<IntegrationField>(NON_SECRET_INTEGRATION_FIELDS);

/** Self-service "API raktai" screen — a company's own super-admin (or the
 * owner, for their own company) pastes in whichever integrations they
 * actually use. Replaces the earlier owner-only "Įmonės" cross-tenant
 * panel: a tab's visibility is now computed server-side from which keys
 * THIS company has configured (see accounts/db.ts's
 * computeAvailableFeatures), not something set on another company's
 * behalf — so there's nothing left to toggle here beyond the keys
 * themselves. Reachable both from the Workspace screen (App.tsx, before
 * any table exists) and from inside an open table's nav (next to
 * "Darbuotojai") — same super_admin/owner gate as both entry points. */
export function IntegrationsView() {
  const status = useIntegrationsStore((s) => s.status);
  const loading = useIntegrationsStore((s) => s.loading);
  const saving = useIntegrationsStore((s) => s.saving);
  const error = useIntegrationsStore((s) => s.error);
  const load = useIntegrationsStore((s) => s.load);
  const save = useIntegrationsStore((s) => s.save);
  const clear = useIntegrationsStore((s) => s.clear);
  const showToast = useToastStore((s) => s.show);

  const [draft, setDraft] = useState<Partial<Record<IntegrationField, string>>>({});

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

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
      await save(patch);
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

  const handleClear = async (field: IntegrationField, label: string) => {
    const ok = await confirmDialog({
      message: `Išvalyti "${label}"? Susijusi skiltis gali dingti, kol raktas nebus įvestas iš naujo.`,
      danger: true,
    });
    if (!ok) return;
    try {
      await clear(field);
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
        Kiekviena skiltis (Skambučiai, Paštas, Paieška, El. laiškų generatorius ir t. t.) atsiranda automatiškai, kai čia įvedamas jai
        reikalingas raktas — atskirai jos įjungti nereikia.
      </p>

      {GROUPS.map((group) => (
        <div key={group.title} className="worker-card integrations-group">
          <div className="worker-card-header">
            <strong>{group.title}</strong>
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
        </div>
      ))}

      <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
        {saving ? 'Saugoma…' : <><Save className="icon" size={16} /> Išsaugoti</>}
      </button>
    </div>
  );
}
