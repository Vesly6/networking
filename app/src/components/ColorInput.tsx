import { useEffect, useRef, useState } from 'react';

interface ColorInputProps {
  value?: string;
  /** Fired once, when the picker is closed/committed — not on every drag
   * tick. See the comment below for why this matters. */
  onCommit: (color: string) => void;
  className?: string;
  title?: string;
}

/** A plain `<input type="color">`, except it only commits once the color
 * picker actually closes, instead of on every pixel of drag inside it.
 *
 * The native picker fires a DOM `input` event continuously while you drag
 * (dozens of times a second) and a single `change` event when you're done
 * — but React's `onChange` prop is wired to the native `input` event for
 * all form controls, not `change` (a long-standing React normalization,
 * not a bug). Every caller here previously used `onChange` to call
 * straight into a store action that does an undo-stack snapshot, a full
 * table re-render, and a read-modify-write to IndexedDB — meaning every
 * single drag tick was paying for all of that, which is exactly what made
 * dragging the color wheel feel like it was fighting the browser instead
 * of moving smoothly. Local `draft` state absorbs the live drag (cheap,
 * only this component re-renders) and a native `change` listener — added
 * via a ref, since React has no prop for it on this element — fires
 * `onCommit` exactly once, when the drag actually ends. */
export function ColorInput({ value, onCommit, className, title }: ColorInputProps) {
  const [draft, setDraft] = useState(value ?? '#000000');
  const ref = useRef<HTMLInputElement>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Re-sync from an *external* value change (e.g. undo/redo touching this
  // same option's color) — not from this input's own onChange, which
  // already applied the new value to `draft` directly.
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
