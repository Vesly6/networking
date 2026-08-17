import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  /** The element the popover is anchored to — used only to compute position. */
  anchor: HTMLElement;
  width?: number;
  children: ReactNode;
}

const MARGIN = 8;

/**
 * Renders into document.body with `position: fixed`, positioned from the
 * anchor's live viewport rect and clamped inside the viewport. This avoids
 * getting clipped/pushed off-screen by an ancestor's `overflow: auto` or a
 * sticky-positioned containing block (the old `position: absolute` popovers
 * inside sticky table headers could end up entirely outside the viewport).
 */
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
    >
      {children}
    </div>,
    document.body,
  );
}
