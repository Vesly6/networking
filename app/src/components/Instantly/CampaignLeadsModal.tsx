import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Users, Trash2 } from 'lucide-react';
import { fetchInstantlyLeads, deleteInstantlyLead, type InstantlyLead } from '../../utils/instantlyApi';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';

interface CampaignLeadsModalProps {
  campaignId: string;
  onClose: () => void;
}

function leadName(lead: InstantlyLead): string {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ');
  return name || lead.email;
}

function groupKey(lead: InstantlyLead): string {
  return lead.company_domain || lead.company_name || '—';
}

function matchesSearch(lead: InstantlyLead, query: string): boolean {
  const haystack = [lead.email, lead.first_name, lead.last_name, lead.company_name, lead.company_domain]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

const PAGE_SIZE = 200;

/** A campaign's leads, grouped by company so the other people at a company
 * that already replied positively are visually right next to each other —
 * on explicit request, to support deleting them (they should stop
 * receiving further follow-ups) once one contact there has already agreed
 * to a meeting. Deliberately NOT the old, fully-scoped-out Campaigns/Leads
 * browser (see InstantlyView.tsx's own doc comment) — this is read-and-
 * delete only, no lead editing/creation. Selection is always manual
 * (checkboxes), with a per-company "select all" shortcut for convenience —
 * on explicit request, there is no automatic "also select the other leads
 * at this company" behavior tied to a reply. */
export function CampaignLeadsModal({ campaignId, onClose }: CampaignLeadsModalProps) {
  const showToast = useToastStore((s) => s.show);
  const [leads, setLeads] = useState<InstantlyLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const loadPage = async (starting_after?: string) => {
    try {
      const page = await fetchInstantlyLeads({ campaign: campaignId, limit: PAGE_SIZE, starting_after });
      setLeads((prev) => (starting_after ? [...prev, ...page.items] : page.items));
      setNextCursor(page.next_starting_after);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nepavyko įkelti lidų');
    }
  };

  useEffect(() => {
    setLoading(true);
    void loadPage().finally(() => setLoading(false));
    // Fresh load whenever a different campaign's modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  const handleLoadMore = async () => {
    setLoadingMore(true);
    await loadPage(nextCursor);
    setLoadingMore(false);
  };

  // Sorted by company so everyone from the same company renders adjacently
  // under one group heading, then filtered by the search box — grouping
  // happens on the full loaded set, filtering narrows what's actually shown.
  const groups = useMemo(() => {
    const filtered = search.trim() ? leads.filter((l) => matchesSearch(l, search.trim())) : leads;
    const sorted = [...filtered].sort((a, b) => groupKey(a).localeCompare(groupKey(b)));
    const result: { key: string; leads: InstantlyLead[] }[] = [];
    for (const lead of sorted) {
      const key = groupKey(lead);
      const last = result[result.length - 1];
      if (last && last.key === key) last.leads.push(lead);
      else result.push({ key, leads: [lead] });
    }
    return result;
  }, [leads, search]);

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectGroup = (group: { leads: InstantlyLead[] }) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const lead of group.leads) next.add(lead.id);
      return next;
    });

  const handleDeleteSelected = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await confirmDialog({
      message: `Ištrinti ${ids.length} ${ids.length === 1 ? 'kontaktą' : 'kontaktus'} iš šios kampanijos? Jie nebegaus tolimesnių laiškų. Šio veiksmo Instantly pusėje atšaukti negalima.`,
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    let succeeded = 0;
    let failed = 0;
    const deletedIds = new Set<string>();
    for (const id of ids) {
      try {
        await deleteInstantlyLead(id);
        deletedIds.add(id);
        succeeded++;
      } catch {
        failed++;
      }
    }
    setLeads((prev) => prev.filter((l) => !deletedIds.has(l.id)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of deletedIds) next.delete(id);
      return next;
    });
    setDeleting(false);
    showToast(failed > 0 ? `Ištrinta: ${succeeded} · Nepavyko: ${failed}` : `Ištrinta: ${succeeded}`);
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal campaign-leads-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apollo-search-modal-header">
          <h2>
            <Users className="icon" size={18} /> Kampanijos lidai
          </h2>
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            <X className="icon" size={16} />
          </button>
        </div>

        <input
          type="search"
          className="campaign-leads-search"
          placeholder="Ieškoti pagal įmonę, vardą ar el. paštą…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {loading && <p className="instantly-hint">Kraunama…</p>}
        {!loading && groups.length === 0 && <p className="instantly-hint">Lidų nerasta.</p>}

        {!loading && groups.length > 0 && (
          <div className="campaign-leads-list">
            {groups.map((group) => (
              <div className="campaign-leads-group" key={group.key}>
                <div className="campaign-leads-group-header">
                  <span>
                    {group.key} <span className="instantly-row-subtitle">({group.leads.length})</span>
                  </span>
                  {group.leads.length > 1 && (
                    <button type="button" onClick={() => selectGroup(group)}>
                      Pasirinkti visus šios įmonės
                    </button>
                  )}
                </div>
                {group.leads.map((lead) => (
                  <label key={lead.id} className="campaign-leads-row">
                    <input type="checkbox" checked={selectedIds.has(lead.id)} onChange={() => toggleSelected(lead.id)} />
                    <span className="campaign-leads-row-name">{leadName(lead)}</span>
                    <span className="instantly-row-subtitle">{lead.email}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}

        {!loading && nextCursor && !search.trim() && (
          <button type="button" onClick={() => void handleLoadMore()} disabled={loadingMore}>
            {loadingMore ? 'Kraunama…' : 'Įkelti daugiau'}
          </button>
        )}

        <div className="popover-footer">
          <button type="button" onClick={onClose}>
            Uždaryti
          </button>
          <span className="campaign-leads-selected-count">Pasirinkta: {selectedIds.size}</span>
          <button
            type="button"
            className="danger"
            disabled={selectedIds.size === 0 || deleting}
            onClick={() => void handleDeleteSelected()}
          >
            <Trash2 className="icon" size={14} /> {deleting ? 'Trinama…' : `Ištrinti pasirinktus (${selectedIds.size})`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
