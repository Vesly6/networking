import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ContextMenuProps {
  /** Viewport coordinates (e.g. from a `contextmenu` event's clientX/clientY)
   * — unlike Popover, this isn't anchored to an element's rect, since a
   * right-click menu opens at the cursor, not below/above a trigger button. */
  x: number;
  y: number;
  children: ReactNode;
}

const MARGIN = 8;

/** Excel-style right-click menu: renders into document.body via a portal,
 * position: fixed at the click point and clamped inside the viewport (same
 * clamping approach as Popover, just anchored to a point instead of a
 * rect). Closed the same way every other popover in TableView already is —
 * click anywhere else — so it doesn't need its own dismiss wiring beyond
 * stopping propagation on its own content. */
export function ContextMenu({ x, y, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const width = ref.current?.offsetWidth ?? 220;
    const height = ref.current?.offsetHeight ?? 200;
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN));
    const top = Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN));
    setPos({ top, left });
  }, [x, y]);

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
