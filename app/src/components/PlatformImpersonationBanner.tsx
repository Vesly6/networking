import { useState } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useToastStore } from '../store/useToastStore';
import { exitPlatformImpersonation } from '../utils/platformImpersonation';
import { ShieldAlert } from 'lucide-react';

/** Persistent "the platform is diagnosing inside your company" indicator —
 * the one-level-up counterpart to ImpersonationBanner.tsx (a company's own
 * super_admin acting as one of their workers). Distinct styling
 * (impersonation-banner-platform) so it reads as a different, more
 * unusual event than the everyday admin-acting-as-worker case. Deliberately
 * NOT dismissible, same reasoning as ImpersonationBanner — the only way
 * off this screen is the actual Exit action, which also returns to the
 * platform dashboard (see exitPlatformImpersonation's own doc comment). */
export function PlatformImpersonationBanner() {
  const platformActing = useAuthStore((s) => !!s.user?.platformActing);
  const companyName = useAuthStore((s) => s.user?.company?.name ?? '');
  const companyId = useAuthStore((s) => s.user?.companyId ?? '');
  const showToast = useToastStore((s) => s.show);
  const [exiting, setExiting] = useState(false);

  if (!platformActing) return null;

  const handleExit = async () => {
    setExiting(true);
    try {
      await exitPlatformImpersonation(companyId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko išeiti');
      setExiting(false);
    }
  };

  return (
    <div className="impersonation-banner impersonation-banner-platform">
      <ShieldAlert className="icon" size={16} />
      <span className="impersonation-banner-text">
        Veikiate kaip įmonės administratorius: <strong>{companyName}</strong>
      </span>
      <button type="button" className="impersonation-banner-return" onClick={() => void handleExit()} disabled={exiting}>
        {exiting ? 'Išeinama…' : 'Išeiti'}
      </button>
    </div>
  );
}
