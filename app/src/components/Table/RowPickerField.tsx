import { useMemo, useRef, useState } from 'react';
import { Popover } from '../Popover';

export interface RowPickerOption {
  rowId: string;
  label: string;
}

interface RowPickerFieldProps {
  /** The chosen option's id (or the pinned option's id, e.g. a "skip"
   * sentinel), or undefined when nothing's been picked yet. */
  value: string | undefined;
  /** The full candidate list to search — can be any size. Only the top
   * MAX_RESULTS matches are ever rendered, so this component never mounts
   * more than a small, constant number of DOM nodes no matter how large
   * `options` is. This is the whole point: the caller this was built for
   * (MergeContactsModal.tsx) used to render one plain <option> per
   * candidate, per rendered group — against a large table that multiplied
   * out to enough DOM nodes to crash the tab outright (confirmed live via
   * Playwright: a real Chromium renderer crash against a ~14,500-row
   * table with a mostly-unmatched CSV import). */
  options: RowPickerOption[];
  /** Always shown above the search-filtered list and exempt from the
   * search filter — e.g. a "skip this group" choice that must stay
   * reachable even mid-search. */
  pinnedOption?: RowPickerOption;
  /** Shown on the trigger button when value is undefined. */
  placeholder: string;
  onChange: (rowId: string) => void;
}

const MAX_RESULTS = 50;

/** A `<select>` replacement for choosing one row out of a list that can be
 * too large to render as plain <option> elements. Renders as a button
 * showing the current choice; clicking it opens a Popover with a search
 * input and a filtered, capped list of matches rendered as buttons.
 *
 * The *scan* over `options` on every keystroke is still O(options.length)
 * — cheap, a plain substring test, no regex — but the *rendered* result is
 * always capped at MAX_RESULTS, so DOM node count is independent of how
 * large `options` is. Closing on an outside click reuses this codebase's
 * existing combobox pattern (see ComboBoxMultiInput.tsx): the search
 * input's onBlur schedules a close, and each option button's onMouseDown
 * calls preventDefault() so picking an option never fires that blur in
 * the first place — no document-level listener needed (Popover.tsx
 * already stops its own onMouseDown/onClick from bubbling out to
 * whatever's underneath, e.g. a modal's own backdrop-click-to-cancel). */
export function RowPickerField({ value, options, pinnedOption, placeholder, onChange }: RowPickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);

  const selectedLabel =
    value === undefined
      ? null
      : (pinnedOption && value === pinnedOption.rowId ? pinnedOption.label : options.find((o) => o.rowId === value)?.label) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    return pool.slice(0, MAX_RESULTS);
  }, [query, options]);

  const select = (rowId: string) => {
    onChange(rowId);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="row-picker-trigger"
        onClick={() => {
          setQuery('');
          setOpen((o) => !o);
        }}
      >
        <span className="row-picker-trigger-label">{selectedLabel ?? placeholder}</span>
      </button>
      {open && btnRef.current && (
        <Popover anchor={btnRef.current} width={280}>
          <input
            autoFocus
            type="text"
            className="row-picker-search"
            placeholder="Ieškoti..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="row-picker-options">
            {pinnedOption && (
              <button
                type="button"
                className={`date-cell-contact-option ${value === pinnedOption.rowId ? 'date-cell-contact-option-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(pinnedOption.rowId)}
              >
                {pinnedOption.label}
              </button>
            )}
            {filtered.map((o) => (
              <button
                key={o.rowId}
                type="button"
                className={`date-cell-contact-option ${o.rowId === value ? 'date-cell-contact-option-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(o.rowId)}
              >
                {o.label}
              </button>
            ))}
            {filtered.length === 0 && <div className="row-picker-hint">Nerasta atitikmenų</div>}
          </div>
          {options.length > MAX_RESULTS && filtered.length >= MAX_RESULTS && (
            <div className="row-picker-hint">Rodomi pirmi {MAX_RESULTS} atitikmenys — susiaurinkite paiešką</div>
          )}
        </Popover>
      )}
    </>
  );
}
