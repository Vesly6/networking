import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/** Instant, portaled hover tooltip — extracted out of CellHoverEditor.tsx's
 * original SentBadgeTooltip (still styled via that same
 * `.cell-hover-contact-sent-tooltip` class, kept unrenamed to avoid CSS
 * churn) once a second place (LinkedInPlannerView.tsx's own
 * "Išsiuntė"/"Nepatvirtino" badges) needed the identical instant-show
 * behavior a native `title` attribute can't give: a browser's built-in
 * tooltip has a real, OS-level ~1s hover delay before it appears, which
 * read as "very slow to show the name" once these badges started
 * carrying a real per-worker list instead of just a bare count. This
 * component has none of that delay — it renders the instant onMouseEnter
 * fires.
 *
 * A plain nested `position: absolute` child was tried first (in
 * CellHoverEditor's original version) and rejected: it's silently clipped
 * by any scrollable ancestor with `overflow` set (confirmed live —
 * computed opacity/visibility were correct, it just never painted). This
 * portals into `document.body` and positions itself from the anchor's own
 * live `getBoundingClientRect()`, clamped to the viewport, the same
 * pattern every other portaled popover in this app (Popover.tsx) uses. */
export function HoverTooltip({ anchor, text }: { anchor: HTMLElement; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // A real, reported bug in the original version: starting without
  // `position: 'fixed'` painted this as a normal block-level element on
  // its very first render (full document width, not shrink-wrapped to its
  // own text) — that wrong size is what the effect below then measured
  // and centered against, landing the tooltip wildly off-position. This
  // never re-runs once `anchor`/`text` stop changing, so getting the very
  // first measurement right matters.
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = ref.current?.offsetWidth ?? 0;
    const height = ref.current?.offsetHeight ?? 0;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.top - height - 6;
    if (top < 8) top = rect.bottom + 6; // flip below when there's no room above
    setStyle({ position: 'fixed', top, left, visibility: 'visible' });
  }, [anchor, text]);

  return createPortal(
    <div ref={ref} className="cell-hover-contact-sent-tooltip" style={style}>
      {text}
    </div>,
    document.body,
  );
}
