import { useIncomingCallStore } from '../store/useIncomingCallStore';
import { Phone, ArrowRight, X } from 'lucide-react';

interface IncomingCallBannerProps {
  onJumpToRow: (rowId: string) => void;
  onJumpToContact: (rowId: string, columnId: string, contactId: string) => void;
}

/** A live "somebody is calling right now" banner — on explicit request
 * ("надо чтоб афтоматом показывало мне контакт... которого ето номер").
 * Fed by utils/incomingCallBridge.ts's MutationObserver on the Zadarma
 * widget, mounted globally (App.tsx) so it shows regardless of which tab
 * is open, same as usePendingPhoneSearchStore's own header badge. Shown
 * even when the number doesn't match anything in the active table (just
 * the bare number, no jump button) — better than staying silent, since
 * the whole point is "don't make me go look this up myself." */
export function IncomingCallBanner({ onJumpToRow, onJumpToContact }: IncomingCallBannerProps) {
  const callerNumber = useIncomingCallStore((s) => s.callerNumber);
  const match = useIncomingCallStore((s) => s.match);
  const clear = useIncomingCallStore((s) => s.clear);

  if (!callerNumber) return null;

  const handleJump = () => {
    if (match?.kind === 'row') onJumpToRow(match.rowId);
    else if (match?.kind === 'contact') onJumpToContact(match.rowId, match.columnId, match.contactId);
  };

  return (
    <div className="incoming-call-banner">
      <span className="incoming-call-banner-icon">
        <Phone className="icon" size={18} />
      </span>
      <div className="incoming-call-banner-body">
        <span className="incoming-call-banner-title">Skambina: {match?.label ?? callerNumber}</span>
        {match && <span className="incoming-call-banner-number">{callerNumber}</span>}
      </div>
      {match && (
        <button type="button" className="incoming-call-banner-jump" onClick={handleJump}>
          Atverti lentelėje <ArrowRight className="icon" size={14} />
        </button>
      )}
      <button type="button" className="incoming-call-banner-close" onClick={clear} title="Uždaryti">
        <X className="icon" size={16} />
      </button>
    </div>
  );
}
