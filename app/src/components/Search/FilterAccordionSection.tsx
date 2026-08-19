import { useState, type ReactNode } from 'react';

interface FilterAccordionSectionProps {
  title: string;
  /** Count of values currently set within this section — shown as a small
   * badge next to the title (matching Apollo's own filter sidebar, where a
   * collapsed "Location" row still shows "1" once a value is set) so a
   * collapsed section doesn't hide the fact that it's actually filtering
   * something. */
  activeCount?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** One collapsible filter group — on explicit request, to match Apollo's
 * own People/Company Search sidebar exactly (a long list of collapsed
 * section headers like "Location", "# Employees", "Industry & Keywords",
 * each expanding only when clicked, rather than this app's older
 * "everything basic visible + one flat 'show more' toggle for the rest"
 * layout). CompanyFilterForm.tsx/PeopleFilterForm.tsx each render one of
 * these per filter group instead of a plain `.search-filter-group` div. */
export function FilterAccordionSection({ title, activeCount, defaultOpen = false, children }: FilterAccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="filter-accordion-section">
      <button type="button" className="filter-accordion-header" onClick={() => setOpen((v) => !v)}>
        <span className="filter-accordion-title">{title}</span>
        <span className="filter-accordion-right">
          {!!activeCount && <span className="filter-accordion-badge">{activeCount}</span>}
          <span className={`filter-accordion-chevron ${open ? 'filter-accordion-chevron-open' : ''}`}>▾</span>
        </span>
      </button>
      {open && <div className="filter-accordion-body">{children}</div>}
    </div>
  );
}
