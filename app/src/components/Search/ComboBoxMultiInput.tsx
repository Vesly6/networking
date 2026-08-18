import { useMemo, useRef, useState } from 'react';

interface ComboBoxMultiInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}

const MAX_SUGGESTIONS = 30;

/** A "pick from a list, but can still type your own" multi-value input —
 * built on explicit request: "писать никто сейчас не любит все любят
 * выбирать... мы не будем отказываться полностью" (nobody likes typing,
 * everyone likes picking — but don't fully drop free typing either).
 * Selected values render as removable chips; typing filters `suggestions`
 * into a dropdown (shown immediately on focus, even before typing, so the
 * full option set is visible without having to type first); clicking one
 * adds it. Enter with no suggestion highlighted adds whatever's typed as a
 * plain custom value — this never becomes a closed/validated dropdown. */
export function ComboBoxMultiInput({ value, onChange, suggestions, placeholder }: ComboBoxMultiInputProps) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    const pool = q ? suggestions.filter((s) => s.toLowerCase().includes(q)) : suggestions;
    return pool.filter((s) => !value.includes(s)).slice(0, MAX_SUGGESTIONS);
  }, [text, suggestions, value]);

  const addValue = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setText('');
    setHighlighted(0);
  };
  const removeValue = (v: string) => onChange(value.filter((x) => x !== v));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && filtered[highlighted]) addValue(filtered[highlighted]);
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
        {value.map((v) => (
          <span key={v} className="combobox-chip">
            {v}
            <button type="button" className="combobox-chip-remove" onClick={() => removeValue(v)} aria-label={`Remove ${v}`}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="combobox-input"
          placeholder={value.length === 0 ? placeholder : ''}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHighlighted(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="combobox-dropdown">
          {filtered.map((s, i) => (
            <button
              type="button"
              key={s}
              className={`combobox-option ${i === highlighted ? 'combobox-option-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                addValue(s);
                inputRef.current?.focus();
              }}
              onMouseEnter={() => setHighlighted(i)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
