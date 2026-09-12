// Copied verbatim from app/src/components/ContextMenu.tsx.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ContextMenuProps {
  x: number;
  y: number;
  children: ReactNode;
}

const MARGIN = 8;

/** Excel-style right-click menu: renders into document.body via a portal,
 * position: fixed at the click point and clamped inside the viewport. */
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
