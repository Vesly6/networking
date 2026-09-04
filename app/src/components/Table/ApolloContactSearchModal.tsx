import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PeopleFilterForm } from '../Search/PeopleFilterForm';
import { ApolloCreditsIndicator } from '../Search/ApolloCreditsIndicator';
import {
  searchCompanies,
  searchPeople,
  enrichPerson,
  pollPhoneReveal,
  pickBestPhoneNumber,
  type ApolloCompany,
  type ApolloSearchPerson,
  type CompanySearchParams,
  type PeopleSearchParams,
} from '../../utils/apolloApi';
import { cleanCompanyNameForSearch, guessCompanyDomain } from '../../utils/companyName';
import { joinContactFields, parseContacts, contactTextToFields } from '../../utils/contacts';
import { useToastStore } from '../../store/useToastStore';
import { usePendingPhoneSearchStore } from '../../store/usePendingPhoneSearchStore';
import { randomUUID } from '../../utils/uuid';
import { Search, ChevronUp, ChevronDown, X, ArrowRight, ArrowLeft, Clock, Check } from 'lucide-react';

interface ApolloContactSearchModalProps {
  /** The row's raw Company-column value — seeds the initial company-name
   * query (cleaned, still fully editable) so the common case is still
   * "open, confirm, done," not "open, retype the company from scratch." */
  initialCompanyName: string;
  /** This row's raw Contacts-cell value (same string CellHoverEditor's own
   * `value` prop already holds in contact mode) — used only to flag people
   * search results that have already been added to this row (see
   * `alreadyAddedKeys` below), never written to. Reported bug: reopening
   * this modal after adding someone re-ran the same people search and
   * showed that exact person again with no indication they were already a
   * contact — Apollo's own results have no idea what this app already
   * saved, so the cross-reference has to happen here. */
  existingContactsRaw: string;
  onAddContact: (text: string, id?: string) => void;
  onUpdateContact: (id: string, text: string) => void;
  onClose: () => void;
}

// Best-effort match key: normalized first name + last-name initial. Apollo's
// unenriched search results only ever expose an obfuscated last name (e.g.
// "S." for "Smith"), so a full last-name comparison against an already-added
// contact's real, enriched name would almost never line up — the initial is
// the most either side can reliably agree on. When an existing contact has
// no parseable last name at all, first-name-only is used as a looser
// fallback rather than never matching.
function normalizeNamePart(v: string): string {
  return v.trim().toLowerCase();
}
function lastInitialOf(v: string | null | undefined): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.replace(/\./g, '').charAt(0).toLowerCase() : '';
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

// Session-scoped (this page load only — module-level, not component state,
// so it survives this modal closing and reopening for a different row) —
// on explicit request: checking the same domain/name twice in one session
// shouldn't re-spend a company-search credit for an answer already known.
// Keyed by exactly what was searched (domain takes priority — see
// runCompanySearch below), case-insensitive.
const companySearchCache = new Map<string, ApolloCompany[]>();

/** A real two-step search: confirm/replace the company first (a compact
 * name+domain form — see runCompanySearch below for why this is
 * deliberately NOT the full CompanyFilterForm the "Paieška" tab uses;
 * this step only ever needs a precise single-company check, not a broad
 * multi-filter discovery search), then search people at the confirmed
 * company with PeopleFilterForm's full filter set.
 *
 * Neither step auto-searches on its own — on explicit request, after a
 * real reported problem: this modal used to run a paid company search
 * (Apollo bills 1 credit/page) automatically the instant it opened, every
 * single time, whether or not the user actually wanted to look anyone
 * up. Both the name and domain fields are pre-filled from the row's own
 * known data as a convenience, but nothing is sent to Apollo until the
 * user explicitly clicks the search button (or presses Enter in either
 * field). Company search itself is also session-cached (see
 * companySearchCache above) so re-checking the same domain/name twice
 * doesn't spend a second credit on an answer this page already has. */
export function ApolloContactSearchModal({
  initialCompanyName,
  existingContactsRaw,
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

  // Pre-filled from the row's own known data (cleaned name, best-effort
  // guessed domain) but never auto-submitted — on explicit request, a
  // real reported problem: this modal used to run a paid company search
  // (Apollo bills 1 credit/page for /mixed_companies/search) the instant
  // it opened, every time, whether or not the user actually wanted to
  // look anyone up. Both fields stay fully editable; searching now only
  // ever happens from the explicit button click in runCompanySearch
  // below (also submittable via Enter, since both live inside a <form>).
  const [companyNameQuery, setCompanyNameQuery] = useState(cleanCompanyNameForSearch(initialCompanyName));
  const [companyDomainQuery, setCompanyDomainQuery] = useState(() => guessCompanyDomain(initialCompanyName));
  const [companyResults, setCompanyResults] = useState<ApolloCompany[]>([]);
  const [companyLoading, setCompanyLoading] = useState(false);
  const [companyError, setCompanyError] = useState('');
  const [companySearched, setCompanySearched] = useState(false);

  const [selectedCompany, setSelectedCompany] = useState<ApolloCompany | null>(null);
  const [peopleParams, setPeopleParams] = useState<PeopleSearchParams>({ per_page: 100 });
  const [peopleResults, setPeopleResults] = useState<ApolloSearchPerson[]>([]);
  const [peopleTotalEntries, setPeopleTotalEntries] = useState(0);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState('');
  const [peopleSearched, setPeopleSearched] = useState(false);
  const [addingPersonIds, setAddingPersonIds] = useState<Set<string>>(new Set());
  // Only gates the PEOPLE step's filters now (the company step's own
  // compact name+domain form has nothing worth collapsing, and the header
  // toggle button is hidden entirely until a company is picked — see the
  // header JSX below). Mobile only (see .apollo-search-modal-filters'
  // collapsed state in App.css) — stacking the filter form above results
  // (instead of the fixed 320px side-by-side column that never fit a
  // phone width) still left a real, reported problem of its own:
  // PeopleFilterForm alone runs to eight-plus collapsible sections, tall
  // enough on a phone to push every actual result off the bottom of the
  // screen with no way to get back to a compact view short of scrolling
  // all the way past it again. Starts expanded for the same reason
  // SearchView's own toggle does — this is what a first-time visitor to
  // this step needs to see first.
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  // Same "auto-collapse once a search actually runs" behavior as
  // SearchView's own runSearchAndCollapse — on request, manually tapping
  // "Slėpti filtrus" first wasn't obvious to everyone. Desktop-gated the
  // same way (matchMedia against the shared 640px breakpoint), since the
  // side-by-side layout there never needed collapsing at all.
  const runSearchAndCollapse = async (run: () => Promise<void>) => {
    await run();
    if (window.matchMedia('(max-width: 640px)').matches) setFiltersExpanded(false);
  };
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
  // Global, not local useState — see usePendingPhoneSearchStore's own doc
  // comment for why: this component unmounts on modal close, but the poll
  // loop below (deliberately fire-and-poll, not awaited) keeps running
  // regardless, so the *visible* "still searching" indicator needs to
  // live somewhere that survives the unmount too, or closing the modal
  // makes an actually-still-running search look like it silently broke.
  const startPhoneSearch = usePendingPhoneSearchStore((s) => s.start);
  const finishPhoneSearch = usePendingPhoneSearchStore((s) => s.finish);
  const pendingPhoneCount = usePendingPhoneSearchStore((s) => s.count);

  // Only ever called from an explicit click/Enter on the company-search
  // form below — never automatically. Domain takes priority over name
  // when both are present: a domain is a precise, single-company lookup,
  // while a bare name is a broad keyword match that can return many
  // candidates — on explicit request, "не делать широкий поиск... если
  // для проверки конкретной компании уже есть точный домен." Checks the
  // session cache first (companySearchCache above) so re-checking the
  // same domain/name twice doesn't re-spend a credit on an answer this
  // page already has.
  const runCompanySearch = async () => {
    const domain = companyDomainQuery.trim();
    const name = companyNameQuery.trim();
    if (!domain && !name) return;
    const cacheKey = domain ? `domain:${domain.toLowerCase()}` : `name:${name.toLowerCase()}`;

    const cached = companySearchCache.get(cacheKey);
    if (cached) {
      setCompanyResults(cached);
      setCompanySearched(true);
      setCompanyError(cached.length === 0 ? 'Įmonių nerasta — pabandykite kitus raktažodžius' : '');
      return;
    }

    setCompanyLoading(true);
    setCompanyError('');
    try {
      const params: CompanySearchParams = domain
        ? { q_organization_domains_list: [domain], per_page: 10 }
        : { q_organization_name: name, per_page: 10 };
      const res = await searchCompanies(params);
      setCompanyResults(res.companies);
      companySearchCache.set(cacheKey, res.companies);
      setCompanySearched(true);
      if (res.companies.length === 0) setCompanyError('Įmonių nerasta — pabandykite kitus raktažodžius');
    } catch (err) {
      setCompanyError(err instanceof Error ? err.message : 'Nepavyko atlikti paieškos');
    } finally {
      setCompanyLoading(false);
    }
  };

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
      ? { per_page: 100, q_organization_domains_list: [domain] }
      : { per_page: 100, organization_ids: [company.id] };
    setPeopleParams(params);
    // Same reasoning as the company step's own auto-run above — picking a
    // company and landing on its people results is the primary flow here,
    // not the manual "resubmit the people filter form" path, so it needs
    // the same auto-collapse.
    await runSearchAndCollapse(() => runPeopleSearchWith(params));
  };

  const runPeopleSearchWith = async (params: PeopleSearchParams) => {
    setPeopleLoading(true);
    setPeopleError('');
    try {
      const res = await searchPeople(params);
      setPeopleResults(res.people);
      setPeopleTotalEntries(res.total_entries);
      setPeopleSearched(true);
      if (res.people.length === 0) setPeopleError('Šioje įmonėje žmonių nerasta');
    } catch (err) {
      setPeopleError(err instanceof Error ? err.message : 'Nepavyko atlikti paieškos');
    } finally {
      setPeopleLoading(false);
    }
  };
  // A filter-form resubmit is a *new* search, not "keep paging" — always
  // starts back at page 1, even if the previous search had paged further
  // in. goToPage (below) is the only thing that ever advances past page 1.
  const runPeopleSearch = () => {
    const next = { ...peopleParams, page: 1 };
    setPeopleParams(next);
    return runPeopleSearchWith(next);
  };
  const peoplePerPage = peopleParams.per_page ?? 100;
  const peopleCurrentPage = peopleParams.page ?? 1;
  const peopleTotalPages = peoplePerPage > 0 ? Math.max(1, Math.ceil(peopleTotalEntries / peoplePerPage)) : 1;
  const goToPeoplePage = (page: number) => {
    const next = { ...peopleParams, page };
    setPeopleParams(next);
    void runPeopleSearchWith(next);
  };

  // Best-effort "already added to this row" lookup — see the doc comment on
  // existingContactsRaw above. pairKeys covers the common case (an existing
  // contact whose name split into a first + last part); firstOnlyKeys is the
  // fallback for a legacy/freeform entry that didn't split cleanly (better
  // to over-flag a same-first-name coincidence than to silently miss an
  // actual duplicate).
  const { pairKeys, firstOnlyKeys } = useMemo(() => {
    const pairs = new Set<string>();
    const firstOnly = new Set<string>();
    for (const entry of parseContacts(existingContactsRaw)) {
      const fields = contactTextToFields(entry.text);
      const first = normalizeNamePart(fields.firstName);
      if (!first) continue;
      const lastInitial = lastInitialOf(fields.lastName);
      if (lastInitial) {
        pairs.add(`${first}|${lastInitial}`);
      } else {
        firstOnly.add(first);
      }
    }
    return { pairKeys: pairs, firstOnlyKeys: firstOnly };
  }, [existingContactsRaw]);

  const isAlreadyAdded = (person: ApolloSearchPerson): boolean => {
    const first = normalizeNamePart(person.first_name ?? '');
    if (!first) return false;
    const lastInitial = lastInitialOf(person.last_name_obfuscated);
    if (lastInitial && pairKeys.has(`${first}|${lastInitial}`)) return true;
    return firstOnlyKeys.has(first);
  };

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
      // The selected company's own name (from Company Search, already
      // confirmed by the user in step 1) — not person.organization?.name,
      // which isn't guaranteed present on every People Search result and
      // would otherwise make "Company" silently blank for some people even
      // though the company is already known for certain at this point.
      const company = selectedCompany?.name ?? '';
      const linkedinUrl = result.person?.linkedin_url || '';

      const id = randomUUID();
      onAddContactRef.current(
        joinContactFields({
          firstName,
          lastName,
          position: person.title ?? '',
          company,
          email,
          phone: '',
          linkedinUrl,
          instagramUrl: '',
          facebookUrl: '',
        }),
        id,
      );
      setPeopleResults((prev) => prev.filter((p) => p.id !== person.id));
      showToast(`${firstName || 'Kontaktas'} pridėtas`);

      const applyPhone = (phone: string) => {
        onUpdateContactRef.current(
          id,
          joinContactFields({
            firstName,
            lastName,
            position: person.title ?? '',
            company,
            email,
            phone,
            linkedinUrl,
            instagramUrl: '',
            facebookUrl: '',
          }),
        );
        showToast(`${firstName || 'Kontaktas'}: rastas telefono numeris`);
      };

      // Apollo can return the phone synchronously, in this SAME response,
      // when it's already on file from an earlier reveal (this account's
      // or — per Apollo's own cross-customer caching — someone else's) —
      // a real, reported bug: this used to unconditionally fall into the
      // poll loop below regardless, throwing away an answer that had
      // already arrived and paying the full "can take several minutes"
      // async cost for no reason. Checked first, before touching
      // request_id/polling at all.
      //
      // Branches on whether sync data EXISTS at all (contactPhones), not
      // on whether it happened to contain a mobile number — those are
      // different things. Apollo answering synchronously with only a
      // work_hq/work_direct number is still a complete answer ("no
      // mobile for this person"), not a reason to poll again for a
      // second opinion; pickBestPhoneNumber only accepts mobile/cell
      // entries (on explicit request — no work numbers, ever), so
      // checking ITS result instead of the raw array would have
      // incorrectly treated "answered, but not mobile" as "not answered
      // yet" and kicked off a redundant async lookup.
      const contactPhones = result.person?.contact?.phone_numbers;
      if (contactPhones) {
        const mobile = pickBestPhoneNumber(contactPhones)?.sanitized_number;
        if (mobile) applyPhone(mobile);
      } else if (result.request_id) {
        // The TOP-LEVEL request_id is what polling needs — NOT
        // result.phone_enrichment.request_id, which looks right but is a
        // different id the polling endpoint always rejects (see
        // apolloApi.ts's pollPhoneReveal doc comment). Not awaited — the
        // function returns (and the button unblocks) right after adding.
        startPhoneSearch();
        void (async (requestId: string) => {
          try {
            const deadline = Date.now() + PHONE_POLL_MAX_MS;
            for (;;) {
              const poll = await pollPhoneReveal(requestId);
              if (poll.status === 'ready') {
                const phone = pickBestPhoneNumber(poll.phoneNumbers)?.sanitized_number ?? '';
                if (phone) applyPhone(phone);
                return;
              }
              if (poll.status === 'error' || Date.now() >= deadline) return;
              await sleep(Math.min(Math.max(poll.retryAfterSeconds, 5), 20) * 1000);
            }
          } finally {
            finishPhoneSearch();
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
          <h2><Search className="icon" size={18} /> Ieškoti kontaktų</h2>
          <ApolloCreditsIndicator />
          {selectedCompany && (
            <button
              type="button"
              className="apollo-search-modal-filters-toggle"
              onClick={() => setFiltersExpanded((v) => !v)}
            >
              {filtersExpanded ? <>Slėpti filtrus <ChevronUp className="icon" size={14} /></> : <>Filtrai <ChevronDown className="icon" size={14} /></>}
            </button>
          )}
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            <X className="icon" size={16} />
          </button>
        </div>

        {!selectedCompany ? (
          <div className="apollo-search-modal-body">
            <div className="apollo-search-modal-filters">
              <p className="apollo-search-modal-hint">
                Patikrinkite arba pakeiskite pavadinimą/domeną ir spauskite paieškos mygtuką — Apollo užklausa
                vykdoma tik paspaudus jį, ne automatiškai atidarius šį langą.
              </p>
              <form
                className="apollo-company-quick-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runCompanySearch();
                }}
              >
                <label className="search-filter-field">
                  <span>Įmonės pavadinimas</span>
                  <div className="apollo-company-quick-search-row">
                    <input
                      value={companyNameQuery}
                      onChange={(e) => setCompanyNameQuery(e.target.value)}
                      placeholder="Įmonės pavadinimas"
                    />
                    <button
                      type="submit"
                      className="apollo-company-quick-search-btn"
                      disabled={companyLoading || (!companyNameQuery.trim() && !companyDomainQuery.trim())}
                      title="Ieškoti Apollo"
                    >
                      <Search className="icon" size={16} />
                    </button>
                  </div>
                </label>
                <label className="search-filter-field">
                  <span>Įmonės domenas</span>
                  <input
                    value={companyDomainQuery}
                    onChange={(e) => setCompanyDomainQuery(e.target.value)}
                    placeholder="imone.lt"
                  />
                </label>
              </form>
            </div>
            <div className="apollo-search-modal-results">
              {companyError && <div className="search-result-detail-error">{companyError}</div>}
              {companyLoading && <div className="empty-state">Ieškoma…</div>}
              {!companySearched && !companyLoading && (
                <div className="empty-state">Įveskite pavadinimą arba domeną ir spauskite paieškos mygtuką.</div>
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
                    Pasirinkti <ArrowRight className="icon" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="apollo-search-modal-body">
            {filtersExpanded && (
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
                <ArrowLeft className="icon" size={14} /> Keisti įmonę
              </button>
              <p className="apollo-search-modal-hint">
                Pasirinkta įmonė: <strong>{selectedCompany.name}</strong>
                {selectedCompany.primary_domain && <> · {selectedCompany.primary_domain}</>}
              </p>
              <PeopleFilterForm
                params={peopleParams}
                onChange={setPeopleParams}
                onSubmit={() => void runSearchAndCollapse(runPeopleSearch)}
                loading={peopleLoading}
              />
            </div>
            )}
            <div className="apollo-search-modal-results">
              {peopleError && <div className="search-result-detail-error">{peopleError}</div>}
              {!peopleSearched && !peopleLoading && (
                <div className="empty-state">Ieškoma…</div>
              )}
              {pendingPhoneCount > 0 && (
                <div className="apollo-search-modal-bulk-row">
                  <span className="search-result-detail-muted">
                    <Clock className="icon" size={14} /> Ieškoma {pendingPhoneCount} telefono {pendingPhoneCount === 1 ? 'numerio' : 'numerių'} fone — galite tuo
                    metu ieškoti ir spausti "+ Pridėti" toliau, kiekvienas ieškomas atskirai ir vienu metu
                  </span>
                </div>
              )}
              {peopleResults.map((p) => {
                const added = isAlreadyAdded(p);
                return (
                  <div key={p.id} className={`cell-hover-apollo-result${added ? ' cell-hover-apollo-result-existing' : ''}`}>
                    <span className="cell-hover-apollo-result-name">
                      {[p.first_name, p.last_name_obfuscated].filter(Boolean).join(' ') || 'Nežinoma'}
                      {p.title && <span className="search-result-detail-muted"> — {p.title}</span>}
                      {added && <span className="cell-hover-apollo-result-added-badge"><Check className="icon" size={12} /> Jau pridėta</span>}
                    </span>
                    <button
                      type="button"
                      className="cell-hover-apollo-result-add"
                      disabled={addingPersonIds.has(p.id)}
                      title={
                        added
                          ? 'Panašus kontaktas jau yra šioje eilutėje — vis tiek galima pridėti dar kartą'
                          : 'Prideda kontaktą iškart; telefono numerį (jei jį pavyksta rasti) įrašo pačiam po kelių minučių'
                      }
                      onClick={() => void handleAddPerson(p)}
                    >
                      {addingPersonIds.has(p.id) ? '…' : added ? '+ Pridėti vėl' : '+ Pridėti'}
                    </button>
                  </div>
                );
              })}
              {peopleSearched && peopleTotalEntries > 0 && (
                <div className="apollo-search-modal-pagination">
                  <button
                    type="button"
                    className="apollo-search-modal-back"
                    disabled={peopleLoading || peopleCurrentPage <= 1}
                    onClick={() => goToPeoplePage(peopleCurrentPage - 1)}
                  >
                    <ArrowLeft className="icon" size={14} /> Ankstesnis
                  </button>
                  <span className="search-result-detail-muted">
                    {peopleCurrentPage} / {peopleTotalPages} psl. ({peopleTotalEntries} viso)
                  </span>
                  <button
                    type="button"
                    className="apollo-search-modal-back"
                    disabled={peopleLoading || peopleCurrentPage >= peopleTotalPages}
                    onClick={() => goToPeoplePage(peopleCurrentPage + 1)}
                  >
                    Kitas <ArrowRight className="icon" size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
