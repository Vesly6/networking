import { useEffect, useState } from 'react';
import { fetchCompanyPermissions, saveCompanyPermissions } from '../../utils/adminApi';
import { useToastStore } from '../../store/useToastStore';
import { PERMISSION_GROUPS, PERMISSIONS, type PermissionKey } from '../../utils/permissions';

/** The platform Super Super Admin's per-company ceiling editor — sets
 * exactly what server/src/permissions/effective.ts's companyCeiling()
 * returns for this company, which IS that company's own super_admin's
 * effective set, and which every one of their workers' own grants gets
 * intersected against (see effectivePermissions' own doc comment).
 * Unchecking something here takes effect immediately for the company's
 * super_admin AND cascades to any worker who'd been individually granted
 * it, with zero additional writes — nothing here needs to "push" that
 * cascade, it's just what the live intersection computes on the next
 * check. Re-checking it immediately restores both, the same way. */
export function PermissionsPanel({ companyId }: { companyId: string }) {
  const [keys, setKeys] = useState<PermissionKey[] | null>(null);
  const [saving, setSaving] = useState(false);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    setKeys(null);
    void fetchCompanyPermissions(companyId).then((r) => setKeys(r.permissionKeys));
  }, [companyId]);

  const toggle = (key: PermissionKey) =>
    setKeys((prev) => (prev ? (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]) : prev));

  const handleSave = async () => {
    if (!keys) return;
    setSaving(true);
    try {
      const { permissionKeys } = await saveCompanyPermissions(companyId, keys);
      setKeys(permissionKeys);
      showToast('Išsaugota');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko išsaugoti');
    } finally {
      setSaving(false);
    }
  };

  if (!keys) return <p>Kraunama…</p>;

  return (
    <div className="admin-features-panel">
      <p className="integrations-intro">
        Šios varnelės nustato šios įmonės „lubas" — ką jos administratorius (ir, per jį, bet kuris jo darbuotojas) gali daryti
        apskritai. Administratorius savo darbuotojams gali suteikti tik tai, ką pats čia turi; atėmus teisę čia, ji iškart
        dingsta ir iš administratoriaus, ir iš bet kurio darbuotojo, kuriam ji buvo suteikta — be jokio papildomo veiksmo.
      </p>
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.title} className="worker-form-permission-group">
          <span className="worker-form-permission-group-title">{group.title}</span>
          <div className="worker-form-permission-list">
            {group.keys.map((key) => (
              <label key={key} className="search-filter-checkbox">
                <input type="checkbox" checked={keys.includes(key)} onChange={() => toggle(key)} />
                <span>{PERMISSIONS[key]}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
        {saving ? 'Saugoma…' : 'Išsaugoti'}
      </button>
    </div>
  );
}
