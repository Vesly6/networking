import { useTableStore } from '../store/useTableStore';
import { useToastStore } from '../store/useToastStore';
import { getColumnByType } from './row';
import { addContact, joinContactFields } from './contacts';
import type { ApolloSearchPerson, ApolloCompany, ApolloEnrichedPerson } from './apolloApi';

/** Maps an Apollo person (search result, optionally already enriched) into
 * a new row of the active table — deliberately maps into EXISTING columns
 * only, never auto-creates one: matches the same "explicit, not silent"
 * choice CSV import already made (CLAUDE.md) — a column silently appearing
 * with a name Apollo picked wasn't something anyone asked for. Whatever
 * doesn't have a matching column is dropped, and the toast says exactly
 * what was skipped so it's not a silent data loss. */
export function useAddApolloResultToTable() {
  const columns = useTableStore((s) => s.columns);
  const addRow = useTableStore((s) => s.addRow);
  const updateCell = useTableStore((s) => s.updateCell);
  const showToast = useToastStore((s) => s.show);

  const addPerson = (person: ApolloSearchPerson, enriched: ApolloEnrichedPerson | undefined, revealedPhone?: string) => {
    if (columns.length === 0) {
      showToast('Pirmiausia pridėkite bent vieną stulpelį — kol kas nėra kur sudėti Apollo duomenų');
      return;
    }
    const companyColumn = getColumnByType(columns, 'company');
    const contactColumn = getColumnByType(columns, 'contact');
    const phoneColumn = getColumnByType(columns, 'phone');
    const skipped: string[] = [];

    const firstName = enriched?.first_name ?? person.first_name ?? '';
    const lastName = enriched?.last_name ?? person.last_name_obfuscated ?? '';
    const title = enriched?.title ?? person.title ?? '';
    const email = enriched?.email ?? enriched?.contact?.email ?? '';
    // Phone lives in useSearchStore's separate phoneNumbersById (see
    // revealPhone/pollPhoneReveal), not on `enriched` itself — the "Find
    // phone" button's async lookup is entirely independent of "Find
    // email"'s enrichPerson() call, so the caller passes whatever it has.
    const phone = revealedPhone ?? '';
    const companyName = enriched?.organization?.name ?? person.organization?.name ?? '';
    const linkedinUrl = enriched?.linkedin_url ?? '';

    const rowId = addRow();

    if (companyColumn) {
      if (companyName) updateCell(rowId, companyColumn.id, companyName);
    } else if (companyName) {
      skipped.push('Įmonė');
    }

    if (contactColumn) {
      const text = joinContactFields({
        firstName,
        lastName,
        position: title,
        company: companyName,
        email,
        phone,
        linkedinUrl,
        instagramUrl: '',
        facebookUrl: '',
      });
      if (text) {
        const current = useTableStore.getState().rows.find((r) => r.id === rowId)?.cells[contactColumn.id] ?? '';
        updateCell(rowId, contactColumn.id, addContact(current, text));
      }
    } else if (phone && phoneColumn) {
      updateCell(rowId, phoneColumn.id, phone);
    } else if ((firstName || phone || email) && !contactColumn) {
      skipped.push('Kontaktai');
    }

    const parts = [`Į lentelę pridėta: ${[firstName, lastName].filter(Boolean).join(' ') || 'eilutė'}`];
    if (skipped.length > 0) parts.push(`nėra stulpelio „${skipped.join('/')}“ — šie duomenys praleisti`);
    showToast(parts.join(' — '));
  };

  const addCompany = (company: ApolloCompany) => {
    if (columns.length === 0) {
      showToast('Pirmiausia pridėkite bent vieną stulpelį — kol kas nėra kur sudėti Apollo duomenų');
      return;
    }
    const companyColumn = getColumnByType(columns, 'company');
    const phoneColumn = getColumnByType(columns, 'phone');
    const linkColumn = getColumnByType(columns, 'link');
    const skipped: string[] = [];

    const rowId = addRow();

    if (companyColumn) {
      if (company.name) updateCell(rowId, companyColumn.id, company.name);
    } else if (company.name) {
      skipped.push('Įmonė');
    }

    if (phoneColumn && company.phone) {
      updateCell(rowId, phoneColumn.id, company.phone);
    } else if (company.phone) {
      skipped.push('Telefonas');
    }

    if (linkColumn && (company.website_url || company.primary_domain)) {
      updateCell(rowId, linkColumn.id, company.primary_domain ?? company.website_url ?? '');
    }

    const parts = [`Į lentelę pridėta: ${company.name ?? 'įmonė'}`];
    if (skipped.length > 0) parts.push(`nėra stulpelio „${skipped.join('/')}“ — šie duomenys praleisti`);
    showToast(parts.join(' — '));
  };

  return { addPerson, addCompany };
}
