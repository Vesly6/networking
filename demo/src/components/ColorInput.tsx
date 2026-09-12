// Copied verbatim from app/src/components/ColorInput.tsx.
import { useEffect, useRef, useState } from 'react';

interface ColorInputProps {
  value?: string;
  /** Fired once, when the picker is closed/committed — not on every drag
   * tick, since React's onChange is wired to the native `input` event
   * (which fires continuously while dragging), not `change`. */
  onCommit: (color: string) => void;
  className?: string;
  title?: string;
}

export function ColorInput({ value, onCommit, className, title }: ColorInputProps) {
  const [draft, setDraft] = useState(value ?? '#000000');
  const ref = useRef<HTMLInputElement>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  useEffect(() => {
    setDraft(value ?? '#000000');
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleNativeChange = (e: Event) => {
      onCommitRef.current((e.target as HTMLInputElement).value);
    };
    el.addEventListener('change', handleNativeChange);
    return () => el.removeEventListener('change', handleNativeChange);
  }, []);

  return (
    <input
      ref={ref}
      type="color"
      className={className}
      title={title}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}
