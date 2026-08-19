import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CompanyFilterForm } from '../Search/CompanyFilterForm';
import { PeopleFilterForm } from '../Search/PeopleFilterForm';
import {
  searchCompanies,
  searchPeople,
  enrichPerson,
  pollPhoneReveal,
  type ApolloCompany,
  type ApolloSearchPerson,
  type CompanySearchParams,
  type PeopleSearchParams,
} from '../../utils/apolloApi';
import { cleanCompanyNameForSearch } from '../../utils/companyName';
import { joinContactFields } from '../../utils/contacts';
import { useToastStore } from '../../store/useToastStore';

interface ApolloContactSearchModalProps {
  /** The row's raw Company-column value — seeds the initial company-name
   * query (cleaned, still fully editable) so the common case is still
   * "open, confirm, done," not "open, retype the company from scratch." */
  initialCompanyName: string;
  onAddContact: (text: string, id?: string) => void;
  onUpdateContact: (id: string, text: string) => void;
  onClose: () => void;
}

// Fallback for the rare Apollo company record with a website_url but no
// primary_domain — most already have primary_domain set directly.
function extractHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Apollo's own docs just say "can take several minutes" with no hard
// number — this used to be 3 minutes (matching useSearchStore.ts's poll),
// but that turned out to be a real, confirmed bug: timed a live phone
// lookup for a real contact end to end and it resolved at 210s, i.e.
// *after* the old 180s cap already gave up. The number was found, it just
// arrived 30 seconds too late for this code to still be listening — the
// contact silently kept no phone even though Apollo did have one. 5
// minutes gives real-world lookups more headroom while still failing
// clearly instead of polling forever if something is genuinely stuck.
const PHONE_POLL_MAX_MS = 5 * 60 * 1000;

/** The old version of this feature auto-picked companyRes.companies[0] and
 * went straight to a people search with no way to see — let alone
 * correct — which company Apollo actually matched, or to search with
 * different filters than a single auto-cleaned name string. This is a real
 * two-step search (reusing the same CompanyFilterForm/PeopleFilterForm the
 * "Paieška" tab already uses, on explicit request): confirm/replace the
 * company here first, then search people at the confirmed company with the
 * full filter set, not just a name. */
export function ApolloContactSearchModal({
  initialCompanyName,
  onAddContact,
  onUpdateContact,
  onClose,
}: ApolloContactSearchModalProps) {
  const showToast = useToastStore((s) => s.show);
  // Both onAddContact and onUpdateContact close over *this render's*
  // `rawValue` snapshot (TableView.tsx: `updateCell(row.id, column.id,
  // addContact(rawValue, text, id))`) — a read-modify-write. Calling a
  // stale one silently reverts anything added since that render, which is
  // exactly what "Pridėti pasirinktus" (bulk-add) hit: firing several
  // handleAddPerson calls back to back without an intervening re-render
  // means every one of them closes over the *same* pre-loop onAddContact,
  // so each person after the first overwrote the previous one's addition
  // instead of appending to it — confirmed live, 3 selected people, only
  // the last one actually ended up in the contacts list. Reading through a
  // ref (updated every render) means each call always uses whichever
  // closure is current *at the moment it actually runs*, not the one from
  // whenever this component itself last rendered.
  const onAddContactRef = useRef(onAddContact);
  onAddContactRef.current = onAddContact;
  const onUpdateContactRef = useRef(onUpdateContact);
  onUpdateContactRef.current = onUpdateContact;

  const [companyParams, setCompanyParams] = useState<CompanySearchParams>({
    q_organization_name: cleanCompanyNameForSearch(initialCompanyName),
    per_page: 10,
  });
  const [companyResults, setCompanyResults] = useState<ApolloCompany[]>([]);
  const [companyLoading, setCompanyLoading] = useState(false);
  const [companyError, setCompanyError] = useState('');
  const [companySearched, setCompanySearched] = useState(false);

  const [selectedCompany, setSelectedCompany] = useState<ApolloCompany | null>(null);
  const [peopleParams, setPeopleParams] = useState<PeopleSearchParams>({ per_page: 25 });
  const [peopleResults, setPeopleResults] = useState<ApolloSearchPerson[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState('');
  const [peopleSearched, setPeopleSearched] = useState(false);
  const [addingPersonIds, setAddingPersonIds] = useState<Set<string>>(new Set());
  // A single "phone still being searched" count covering *every* in-flight
  // background poll, not per-person — one always-visible line ("Ieškoma N
  // telefono numerių…") so clicking "+ Pridėti" on several people in a row
  // doesn't read as several separate buttons quietly doing nothing; there's
  // one place that always shows real, moving progress instead. Each click
  // is already fully independent (its own request_id, its own poll loop —
  // see handleAddPerson), so searching several people "at once" never
  // needed a bulk-select UI: clicking "+ Pridėti" repeatedly already runs
  // every one of those lookups in parallel. An earlier version added
  // checkboxes + a "Pridėti pasirinktus" button for this, on the
  // assumption that parallelism needed to be triggered explicitly — on
  // request, removed again as unneeded complexity once it was clear plain
  // repeated clicks already do the same thing.
  const [pendingPhoneCount, setPendingPhoneCount] = useState(0);

  const runCompanySearch = async () => {
    setCompanyLoading(true);
    setCompanyError('');
    try {
      const res = await searchCompanies(companyParams);
      setCompanyResults(res.companies);
      setCompanySearched(true);
      if (res.companies.length === 0) setCompanyError('Įmonių nerasta — pabandykite kitus raktažodžius');
    } catch (err) {
      setCompanyError(err instanceof Error ? err.message : 'Nepavyko atlikti paieškos');
    } finally {
      setCompanyLoading(false);
    }
  };

  // Auto-run once on open with the pre-filled (cleaned) name — keeps the
  // "one click and see candidates" convenience the old version had, while
  // everything after this point (confirming/replacing/filtering) is now
  // fully in the user's hands rather than happening silently.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void runCompanySearch(); }, []);

  const pickCompany = async (company: ApolloCompany) => {
    setSelectedCompany(company);
    setPeopleResults([]);
    setPeopleError('');
    setPeopleSearched(false);
    // The domain is what actually works — confirmed live against the real
    // API: organization_ids from a freshly-resolved company often comes
    // back from People Search with zero results even for companies with
    // thousands of people indexed (a real, confirmed bug: Vinted 0 vs 2140
    // via domain, Maxima LT 0 vs 478, SEB 0 vs 13097, Swedbank 0 vs
    // 10528) — Apollo's organization_id linkage is unreliable for a lot of
    // real companies, but the domain hits a far more complete index.
    // organization_ids is used only as a fallback when there's no domain
    // at all — sending *both* together was tried and is a second, separate
    // confirmed bug: Apollo intersects multiple organization filters
    // instead of treating them as alternatives, so pairing a working
    // domain with the same broken organization_id silently zeroes the
    // combined result back down to 0 (verified directly: domain alone 478,
    // organization_ids alone 0, both together also 0).
    const domain = company.primary_domain || extractHostname(company.website_url);
    const params: PeopleSearchParams = domain
      ? { per_page: 25, q_organization_domains_list: [domain] }
      : { per_page: 25, organization_ids: [company.id] };
    setPeopleParams(params);
    await runPeopleSearchWith(params);
  };

  const runPeopleSearchWith = async (params: PeopleSearchParams) => {
    setPeopleLoading(true);
    setPeopleError('');
    try {
      const res = await searchPeople(params);
      setPeopleResults(res.people);
      setPeopleSearched(true);
      if (res.people.length === 0) setPeopleError('Šioje įmonėje žmonių nerasta');
    } catch (err) {
      setPeopleError(err instanceof Error ? err.message : 'Nepavyko atlikti paieškos');
    } finally {
      setPeopleLoading(false);
    }
  };
  const runPeopleSearch = () => void runPeopleSearchWith(peopleParams);

  // Revealing a phone number is Apollo's separate, pricier, start-then-poll
  // lookup (up to +8 credits on top of email's 1) that "can take several
  // minutes" per Apollo's own docs — confirmed live, one real lookup took
  // 210s. Blocking "+ Pridėti" on that (the first version of this) made
  // adding a single contact feel broken/frozen. Now the contact is added
  // immediately with whatever enrichPerson returns synchronously (name +
  // email, fast) and the phone number fills in on its own a bit later via
  // onUpdateContact, once Apollo actually has it — matching how
  // useSearchStore.ts's own "Ieškoti telefono" is *also* fire-and-poll, not
  // a blocking call anywhere else in this codebase either. Each call is
  // fully independent (its own request_id, its own poll loop), so calling
  // this for several people back to back — one at a time, or via
  // handleAddSelected below — already runs their phone lookups *in
  // parallel*, not queued one after another; the wall-clock cost of adding
  // 10 people with phones is "however long the slowest one takes," not 10x
  // that.
  const handleAddPerson = async (person: ApolloSearchPerson) => {
    setAddingPersonIds((prev) => new Set(prev).add(person.id));
    try {
      const result = await enrichPerson({
        id: person.id,
        name: [person.first_name, person.last_name_obfuscated].filter(Boolean).join(' ') || undefined,
        organization_name: selectedCompany?.name ?? undefined,
        domain: selectedCompany?.primary_domain ?? undefined,
        reveal_phone_number: true,
      });
      const firstName = result.person?.first_name || person.first_name || '';
      const lastName = result.person?.last_name || person.last_name_obfuscated || '';
      const email = result.person?.email || result.person?.contact?.email || '';

      const id = crypto.randomUUID();
      onAddContactRef.current(joinContactFields({ firstName, lastName, position: person.title ?? '', email, phone: '' }), id);
      setPeopleResults((prev) => prev.filter((p) => p.id !== person.id));
      showToast(`${firstName || 'Kontaktas'} pridėtas`);

      // The TOP-LEVEL request_id is what polling needs — NOT
      // result.phone_enrichment.request_id, which looks right but is a
      // different id the polling endpoint always rejects (see
      // apolloApi.ts's pollPhoneReveal doc comment). Not awaited — the
      // function returns (and the button unblocks) right after adding.
      if (result.request_id) {
        setPendingPhoneCount((n) => n + 1);
        void (async (requestId: string) => {
          try {
            const deadline = Date.now() + PHONE_POLL_MAX_MS;
            for (;;) {
              const poll = await pollPhoneReveal(requestId);
              if (poll.status === 'ready') {
                const phone = poll.phoneNumbers[0]?.sanitized_number ?? '';
                if (phone) {
                  onUpdateContactRef.current(
                    id,
                    joinContactFields({ firstName, lastName, position: person.title ?? '', email, phone }),
                  );
                  showToast(`${firstName || 'Kontaktas'}: rastas telefono numeris`);
                }
                return;
              }
              if (poll.status === 'error' || Date.now() >= deadline) return;
              await sleep(Math.min(Math.max(poll.retryAfterSeconds, 5), 20) * 1000);
            }
          } finally {
            setPendingPhoneCount((n) => Math.max(0, n - 1));
          }
        })(result.request_id);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko pridėti kontakto');
    } finally {
      setAddingPersonIds((prev) => {
        const next = new Set(prev);
        next.delete(person.id);
        return next;
      });
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal apollo-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apollo-search-modal-header">
          <h2>🔍 Ieškoti kontaktų (Apollo)</h2>
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {!selectedCompany ? (
          <div className="apollo-search-modal-body">
            <div className="apollo-search-modal-filters">
              <p className="apollo-search-modal-hint">
                Patikrinkite arba pakeiskite raktažodžius ir susiraskite tikslią įmonę — kol jos nepasirinksite,
                žmonių paieška neprasidės.
              </p>
              <CompanyFilterForm params={companyParams} onChange={setCompanyParams} onSubmit={runCompanySearch} loading={companyLoading} />
            </div>
            <div className="apollo-search-modal-results">
              {companyError && <div className="search-result-detail-error">{companyError}</div>}
              {!companySearched && !companyLoading && (
                <div className="empty-state">Ieškoma…</div>
              )}
              {companyResults.map((c) => (
                <div key={c.id} className="apollo-search-modal-company-row">
                  <div className="apollo-search-modal-company-info">
                    <div className="apollo-search-modal-company-name">{c.name}</div>
                    <div className="search-result-detail-muted">
                      {[c.primary_domain, c.organization_city, c.organization_country].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <button type="button" className="cell-hover-apollo-result-add" onClick={() => void pickCompany(c)}>
                    Pasirinkti →
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="apollo-search-modal-body">
            <div className="apollo-search-modal-filters">
              <button
                type="button"
                className="apollo-search-modal-back"
                onClick={() => {
                  setSelectedCompany(null);
                  setPeopleResults([]);
                  setPeopleError('');
                }}
              >
                ← Keisti įmonę
              </button>
              <p className="apollo-search-modal-hint">
                Pasirinkta įmonė: <strong>{selectedCompany.name}</strong>
                {selectedCompany.primary_domain && <> · {selectedCompany.primary_domain}</>}
              </p>
              <PeopleFilterForm params={peopleParams} onChange={setPeopleParams} onSubmit={runPeopleSearch} loading={peopleLoading} />
            </div>
            <div className="apollo-search-modal-results">
              {peopleError && <div className="search-result-detail-error">{peopleError}</div>}
              {!peopleSearched && !peopleLoading && (
                <div className="empty-state">Ieškoma…</div>
              )}
              {pendingPhoneCount > 0 && (
                <div className="apollo-search-modal-bulk-row">
                  <span className="search-result-detail-muted">
                    🕐 Ieškoma {pendingPhoneCount} telefono {pendingPhoneCount === 1 ? 'numerio' : 'numerių'} fone — galite tuo
                    metu ieškoti ir spausti "+ Pridėti" toliau, kiekvienas ieškomas atskirai ir vienu metu
                  </span>
                </div>
              )}
              {peopleResults.map((p) => (
                <div key={p.id} className="cell-hover-apollo-result">
                  <span className="cell-hover-apollo-result-name">
                    {[p.first_name, p.last_name_obfuscated].filter(Boolean).join(' ') || 'Nežinoma'}
                    {p.title && <span className="search-result-detail-muted"> — {p.title}</span>}
                  </span>
                  <button
                    type="button"
                    className="cell-hover-apollo-result-add"
                    disabled={addingPersonIds.has(p.id)}
                    title="Prideda kontaktą iškart; telefono numerį (jei Apollo jį randa) įrašo pačiam po kelių minučių"
                    onClick={() => void handleAddPerson(p)}
                  >
                    {addingPersonIds.has(p.id) ? '…' : '+ Pridėti'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
