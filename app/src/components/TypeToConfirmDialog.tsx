import { useState } from 'react';
import { useTypeToConfirmStore } from '../store/useTypeToConfirmStore';

/** Mounted once, near the app root (App.tsx), alongside the plain
 * ConfirmDialog — same .modal/.modal-backdrop chrome so it still looks
 * consistent with every other dialog in the app, just with a required text
 * match gating the confirm button instead of it always being clickable. */
export function TypeToConfirmDialog() {
  const request = useTypeToConfirmStore((s) => s.request);
  const resolveTypeToConfirm = useTypeToConfirmStore((s) => s.resolveTypeToConfirm);
  const [draft, setDraft] = useState('');

  if (!request) return null;

  const matches = draft === request.requiredText;

  const close = (result: boolean) => {
    setDraft('');
    resolveTypeToConfirm(result);
  };

  return (
    <div className="modal-backdrop" onClick={() => close(false)}>
      <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        {request.title && <h2>{request.title}</h2>}
        <p className="confirm-dialog-message">{request.message}</p>
        <p className="type-to-confirm-required">
          Parašykite <code>{request.requiredText}</code>:
        </p>
        <input
          className="type-to-confirm-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches) close(true);
            if (e.key === 'Escape') close(false);
          }}
        />
        <div className="popover-footer">
          <button type="button" onClick={() => close(false)}>
            {request.cancelLabel ?? 'Atšaukti'}
          </button>
          <button type="button" className="danger" disabled={!matches} onClick={() => close(true)}>
            {request.confirmLabel ?? 'Ištrinti negrįžtamai'}
          </button>
        </div>
      </div>
    </div>
  );
}
