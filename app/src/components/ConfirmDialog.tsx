import { useConfirmStore } from '../store/useConfirmStore';

/** Mounted once, near the app root (App.tsx) — reads the pending request (if
 * any) from useConfirmStore and renders nothing when there isn't one. Same
 * .modal/.modal-backdrop chrome as CsvImportMapping, so every centered
 * dialog in the app looks consistent. */
export function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const resolveConfirm = useConfirmStore((s) => s.resolveConfirm);

  if (!request) return null;

  return (
    <div className="modal-backdrop" onClick={() => resolveConfirm(false)}>
      <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        {request.title && <h2>{request.title}</h2>}
        <p className="confirm-dialog-message">{request.message}</p>
        <div className="popover-footer">
          <button type="button" onClick={() => resolveConfirm(false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            autoFocus
            className={request.danger ? 'danger' : 'primary'}
            onClick={() => resolveConfirm(true)}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
