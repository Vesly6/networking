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
      // Stopping only onClick used to be enough, because every *other*
      // popover in this app is only ever closed by a click-based mechanism
      // (TableView's document-level closePopovers listener). DataCell's own
      // date-cell mini-popovers (📝/👤) broke that assumption: they're
      // closed on *mousedown* too (handleCellMouseDown clears
      // dateCellPopover on every cell mousedown, needed so clicking a
      // different cell actually closes them). React's synthetic events
      // bubble through the *logical* component tree, not the portal's real
      // DOM position — and this popover's content is logically nested
      // inside whichever DataCell rendered it, physically portaled or not.
      // So a mousedown on, say, a contact-picker option synthetically
      // bubbled up to that same cell's own <td onMouseDown={onSelect}>,
      // which immediately closed this popover (removing the very button
      // being pressed) before the browser's native 'click' had anything
      // left to dispatch to — a real, reproduced bug: mousedown fired,
      // click never did, so setLinkedContact() never ran and picking a
      // contact silently did nothing. Stopping mousedown here too closes
      // that gap for every popover, not just the two that happen to
      // trigger it today.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
