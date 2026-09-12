import { useConfirmStore } from '../store/useConfirmStore';

export function DemoConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const resolveConfirm = useConfirmStore((s) => s.resolveConfirm);

  if (!request) return null;

  return (
    <div className="modal-backdrop confirm-dialog-backdrop" onClick={() => resolveConfirm(false)}>
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
