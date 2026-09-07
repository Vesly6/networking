import { useState } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useToastStore } from '../store/useToastStore';
import { UserCog } from 'lucide-react';

interface ImpersonationBannerProps {
  /** Called right after successfully returning to the real Super Admin
   * session — App.tsx uses this to reset back to the workspace root (a
   * table/tab the impersonated worker could see might not exist/apply for
   * the admin's own view, or vice versa). */
  onReturned?: () => void;
}

/** Persistent "you are acting as someone else" indicator — on explicit
 * request, so a super_admin impersonating a worker (see useAuthStore.ts's
 * impersonateWorker/stopImpersonating) can never lose track of which
 * account they're currently acting in. Deliberately NOT dismissible (no
 * close button, unlike IncomingCallBanner.tsx) — the whole point is that it
 * stays visible the entire time impersonation is active; the only way off
 * this banner is the actual "Grįžti į Super Admin" action. Mounted once in
 * App.tsx alongside Softphone/IncomingCallBanner so it shows regardless of
 * which tab/screen is open. */
export function ImpersonationBanner({ onReturned }: ImpersonationBannerProps) {
  const impersonating = useAuthStore((s) => s.user?.impersonating ?? null);
  const stopImpersonating = useAuthStore((s) => s.stopImpersonating);
  const showToast = useToastStore((s) => s.show);
  const [returning, setReturning] = useState(false);

  if (!impersonating) return null;

  const handleReturn = async () => {
    setReturning(true);
    try {
      await stopImpersonating();
      onReturned?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko grįžti į Super Admin');
    } finally {
      setReturning(false);
    }
  };

  return (
    <div className="impersonation-banner">
      <UserCog className="icon" size={16} />
      <span className="impersonation-banner-text">
        Jūs veikiate kaip: <strong>{impersonating.workerName}</strong>
      </span>
      <button type="button" className="impersonation-banner-return" onClick={() => void handleReturn()} disabled={returning}>
        {returning ? 'Grįžtama…' : 'Grįžti į Super Admin'}
      </button>
    </div>
  );
}
