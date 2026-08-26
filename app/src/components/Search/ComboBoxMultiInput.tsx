import { useMemo, useRef, useState } from 'react';

/** A suggestion pair: `label` is what's shown/typed-against in the UI
 * (Lithuanian), `value` is what actually ends up in the component's
 * `value[]`/`onChange` — and, for Apollo filter lists, what's actually
 * sent to Apollo's API, which expects English location/title strings.
 * Plain strings are still accepted (label === value) for any use of this
 * component where the two never diverge. */
export interface ComboBoxOption {
  label: string;
  value: string;
}

interface ComboBoxMultiInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: string[] | ComboBoxOption[];
  placeholder?: string;
}

const MAX_SUGGESTIONS = 30;

function toOptions(suggestions: string[] | ComboBoxOption[]): ComboBoxOption[] {
  return suggestions.map((s) => (typeof s === 'string' ? { label: s, value: s } : s));
}

/** A "pick from a list, but can still type your own" multi-value input —
 * built on explicit request: "писать никто сейчас не любит все любят
 * выбирать... мы не будем отказываться полностью" (nobody likes typing,
 * everyone likes picking — but don't fully drop free typing either).
 * Selected values render as removable chips; typing filters `suggestions`
 * into a dropdown (shown immediately on focus, even before typing, so the
 * full option set is visible without having to type first); clicking one
 * adds it. Enter with no suggestion highlighted adds whatever's typed as a
 * plain custom value — this never becomes a closed/validated dropdown.
 *
 * Suggestions can be plain strings or {label, value} pairs — added so
 * Apollo's location/title suggestion lists could show Lithuanian labels
 * while still emitting/sending the English value Apollo's API expects.
 * Filtering matches against BOTH label and value, so typing either
 * "Lietuva" or "Lithuania" finds the same suggestion. */
export function ComboBoxMultiInput({ value, onChange, suggestions, placeholder }: ComboBoxMultiInputProps) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // null = nothing explicitly picked yet. This used to default to 0 (the
  // first suggestion always implicitly "highlighted"), which was a real,
  // reported bug: typing e.g. "HR" — meant as its own literal search term
  // — while *any* suggestion happened to contain "hr" as a substring (a
  // near-certainty against a large title list) made Enter silently add
  // that matched suggestion instead of the literal text actually typed,
  // with no visual cue beyond a subtle active-option style most users
  // wouldn't notice was even doing anything. Now Enter only ever picks a
  // suggestion after the user explicitly arrows to one — otherwise it
  // always adds exactly what was typed, matching a plain tag input's
  // normal behavior.
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => toOptions(suggestions), [suggestions]);
  const labelByValue = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of options) map.set(o.value, o.label);
    return map;
  }, [options]);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    const pool = q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      : options;
    return pool.filter((o) => !value.includes(o.value)).slice(0, MAX_SUGGESTIONS);
  }, [text, options, value]);

  const addValue = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setText('');
    setHighlighted(null);
  };
  const removeValue = (v: string) => onChange(value.filter((x) => x !== v));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min((h ?? -1) + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max((h ?? 0) - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && highlighted !== null && filtered[highlighted]) addValue(filtered[highlighted].value);
      else addValue(text);
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      removeValue(value[value.length - 1]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="combobox">
      <div className="combobox-chips">
        {value.map((v) => {
          const label = labelByValue.get(v) ?? v;
          return (
            <span key={v} className="combobox-chip" title={label}>
              <span className="combobox-chip-label">{label}</span>
              <button type="button" className="combobox-chip-remove" onClick={() => removeValue(v)} aria-label={`Pašalinti ${label}`}>
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="combobox-input"
          placeholder={value.length === 0 ? placeholder : ''}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHighlighted(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="combobox-dropdown">
          {filtered.map((o, i) => (
            <button
              type="button"
              key={o.value}
              className={`combobox-option ${i === highlighted ? 'combobox-option-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                addValue(o.value);
                inputRef.current?.focus();
              }}
              onMouseEnter={() => setHighlighted(i)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
