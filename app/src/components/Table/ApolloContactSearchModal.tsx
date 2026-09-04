import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PeopleFilterForm } from '../Search/PeopleFilterForm';
import { ApolloCreditsIndicator } from '../Search/ApolloCreditsIndicator';
import {
  searchPeople,
  enrichPerson,
  pollPhoneReveal,
  pickBestPhoneNumber,
  type ApolloSearchPerson,
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

/** Searches people directly by domain — no company-search step at all, on
 * explicit request after it became clear that Apollo bills company search
 * (/mixed_companies/search) 1 credit/page regardless of whether it's
 * triggered automatically or by an explicit click, while people search
 * (/mixed_people/api_search, what this modal actually needs) is free and
 * already accepts q_organization_domains_list directly — there was never
 * a real need to pay for a company lookup just to resolve a domain this
 * modal usually already has a good guess for.
 *
 * Both the name and domain fields are pre-filled from the row's own known
 * data (cleaned name, best-effort guessed domain — see
 * guessCompanyDomain in companyName.ts) but nothing is sent to Apollo
 * until the user explicitly submits (Enter in either field, or the
 * search button). Domain is what's actually searched on; if the field is
 * empty but a name is present, a domain is guessed from the name at
 * submit time. If a domain search comes up empty, the fix is editing
 * either field and searching again — there's no separate "browse
 * companies and pick one" step to fall back to anymore. */
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

  const [companyNameQuery, setCompanyNameQuery] = useState(cleanCompanyNameForSearch(initialCompanyName));
  const [companyDomainQuery, setCompanyDomainQuery] = useState(() => guessCompanyDomain(initialCompanyName));

  const [peopleParams, setPeopleParams] = useState<PeopleSearchParams>({ per_page: 100 });
  const [peopleResults, setPeopleResults] = useState<ApolloSearchPerson[]>([]);
  const [peopleTotalEntries, setPeopleTotalEntries] = useState(0);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState('');
  const [peopleSearched, setPeopleSearched] = useState(false);
  const [addingPersonIds, setAddingPersonIds] = useState<Set<string>>(new Set());
  // Mobile only (see .apollo-search-modal-filters' collapsed state in
  // App.css) — stacking the filter form above results (instead of the
  // fixed 320px side-by-side column that never fit a phone width) still
  // left a real, reported problem of its own: PeopleFilterForm alone runs
  // to eight-plus collapsible sections, tall enough on a phone to push
  // every actual result off the bottom of the screen with no way to get
  // back to a compact view short of scrolling all the way past it again.
  // Starts expanded for the same reason SearchView's own toggle does —
  // this is what a first-time visitor needs to see first.
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

  const runPeopleSearchWith = async (params: PeopleSearchParams) => {
    setPeopleLoading(true);
    setPeopleError('');
    try {
      const res = await searchPeople(params);
      setPeopleResults(res.people);
      setPeopleTotalEntries(res.total_entries);
      setPeopleSearched(true);
      if (res.people.length === 0) setPeopleError('Žmonių nerasta pagal šį domeną — pabandykite kitą domeną arba pavadinimą');
    } catch (err) {
      setPeopleError(err instanceof Error ? err.message : 'Nepavyko atlikti paieškos');
    } finally {
      setPeopleLoading(false);
    }
  };

  // The only Apollo call this modal's own quick-search form ever makes —
  // straight to people search, never company search. Domain takes
  // priority when present (a precise, single-company filter); if the
  // domain field is empty but a name is, a domain is guessed from the
  // name right here rather than stored, so editing the name alone and
  // resubmitting always re-derives fresh rather than reusing a stale
  // guess. q_organization_domains_list, not organization_ids — confirmed
  // live against the real API: organization_ids from a freshly-resolved
  // company often returns zero people even for companies with thousands
  // indexed (Vinted 0 vs 2140, Maxima LT 0 vs 478, SEB 0 vs 13097 — the
  // same finding that originally motivated preferring domain over id in
  // the old company-search flow this replaces).
  const runQuickPeopleSearch = async () => {
    const domain = companyDomainQuery.trim() || guessCompanyDomain(companyNameQuery.trim());
    if (!domain) return;
    const params: PeopleSearchParams = { per_page: 100, q_organization_domains_list: [domain] };
    setPeopleParams(params);
    await runSearchAndCollapse(() => runPeopleSearchWith(params));
  };

  // A filter-form resubmit (PeopleFilterForm's own "Ieškoti" button) is a
  // *new* search, not "keep paging" — always starts back at page 1, even
  // if the previous search had paged further in. goToPage (below) is the
  // only thing that ever advances past page 1.
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

  // What's actually being searched on right now, for display only — the
  // quick-search fields above can drift from this once the user starts
  // editing them again after a search already ran; this always reflects
  // the domain the *current* peopleResults actually came from.
  const activeDomain = peopleParams.q_organization_domains_list?.[0];

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
        organization_name: companyNameQuery.trim() || undefined,
        domain: activeDomain || companyDomainQuery.trim() || undefined,
        reveal_phone_number: true,
      });
      const firstName = result.person?.first_name || person.first_name || '';
      const lastName = result.person?.last_name || person.last_name_obfuscated || '';
      const email = result.person?.email || result.person?.contact?.email || '';
      // person.organization?.name isn't guaranteed present on every People
      // Search result — fall back to the row's own known company name
      // (the quick-search field above) rather than leaving it blank.
      const company = person.organization?.name || companyNameQuery.trim();
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
          <button
            type="button"
            className="apollo-search-modal-filters-toggle"
            onClick={() => setFiltersExpanded((v) => !v)}
          >
            {filtersExpanded ? <>Slėpti filtrus <ChevronUp className="icon" size={14} /></> : <>Filtrai <ChevronDown className="icon" size={14} /></>}
          </button>
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            <X className="icon" size={16} />
          </button>
        </div>

        <div className="apollo-search-modal-body">
          {filtersExpanded && (
          <div className="apollo-search-modal-filters">
            <p className="apollo-search-modal-hint">
              Domenas ieškomas pirmiausia — jei jo nėra, spėjamas iš pavadinimo. Apollo užklausa vykdoma tik
              paspaudus paieškos mygtuką arba Enter, ne automatiškai atidarius šį langą, ir žmonių paieška yra
              nemokama.
            </p>
            <form
              className="apollo-company-quick-search"
              onSubmit={(e) => {
                e.preventDefault();
                void runQuickPeopleSearch();
              }}
            >
              <label className="search-filter-field">
                <span>Įmonės domenas</span>
                <div className="apollo-company-quick-search-row">
                  <input
                    value={companyDomainQuery}
                    onChange={(e) => setCompanyDomainQuery(e.target.value)}
                    placeholder="imone.lt"
                  />
                  <button
                    type="submit"
                    className="apollo-company-quick-search-btn"
                    disabled={peopleLoading || (!companyDomainQuery.trim() && !companyNameQuery.trim())}
                    title="Ieškoti žmonių pagal domeną"
                  >
                    <Search className="icon" size={16} />
                  </button>
                </div>
              </label>
              <label className="search-filter-field">
                <span>Įmonės pavadinimas</span>
                <input
                  value={companyNameQuery}
                  onChange={(e) => setCompanyNameQuery(e.target.value)}
                  placeholder="Jei domeno nėra arba jis neteisingas"
                />
              </label>
            </form>
            <PeopleFilterForm
              params={peopleParams}
              onChange={setPeopleParams}
              onSubmit={() => void runSearchAndCollapse(runPeopleSearch)}
              loading={peopleLoading}
              // The quick-search form above is the only company-selection
              // mechanism now — PeopleFilterForm's own separate "Įmonė"
              // company-lookup section would just be a second, paid,
              // redundant way to do the same thing.
              hideCompanySection
            />
          </div>
          )}
          <div className="apollo-search-modal-results">
            {activeDomain && (
              <p className="apollo-search-modal-hint">
                Ieškoma pagal domeną: <strong>{activeDomain}</strong>
              </p>
            )}
            {peopleError && <div className="search-result-detail-error">{peopleError}</div>}
            {!peopleSearched && !peopleLoading && (
              <div className="empty-state">Įveskite domeną (arba pavadinimą) ir spauskite paieškos mygtuką.</div>
            )}
            {peopleLoading && <div className="empty-state">Ieškoma…</div>}
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
      </div>
    </div>,
    document.body,
  );
}
