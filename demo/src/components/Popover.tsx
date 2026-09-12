// Copied verbatim from app/src/components/Popover.tsx.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  anchor: HTMLElement;
  width?: number;
  children: ReactNode;
}

const MARGIN = 8;

/** Renders into document.body with `position: fixed`, positioned from the
 * anchor's live viewport rect and clamped inside the viewport — avoids
 * getting clipped by an ancestor's overflow/sticky positioning. */
export function Popover({ anchor, width = 260, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      if (!anchor || !anchor.isConnected) return;
      const rect = anchor.getBoundingClientRect();
      const height = ref.current?.offsetHeight ?? 320;

      let left = rect.right - width;
      left = Math.min(left, window.innerWidth - width - MARGIN);
      left = Math.max(MARGIN, left);

      let top = rect.bottom + 4;
      if (top + height > window.innerHeight - MARGIN) {
        top = rect.top - height - 4;
      }
      top = Math.max(MARGIN, top);

      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, width]);

  return createPortal(
    <div
      ref={ref}
      className="popover"
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
