import { useEffect } from 'react';
import { useInstantlyAccountsStore } from '../../store/useInstantlyAccountsStore';
import { useToastStore } from '../../store/useToastStore';
import { ACCOUNT_STATUS_LABELS, WARMUP_STATUS_LABELS, type InstantlyAccount } from '../../utils/instantlyApi';

function statusPillStyle(status: number): { background: string; color: string } {
  if (status === 1) return { background: '#e5f0e3', color: '#1b7a3d' };
  if (status < 0) return { background: 'var(--danger-bg)', color: 'var(--danger)' };
  return { background: 'var(--bg-alt)', color: 'var(--text-muted)' };
}

/** Purely informational, on explicit request — no add/pause/resume/
 * warmup-toggle actions here anymore (this used to have an "+ Add
 * mailbox" SMTP/IMAP form and per-row pause/warmup buttons; both removed
 * since the mailboxes themselves are managed elsewhere — this panel's
 * only job now is showing which mailboxes the account is currently
 * sending from). server/src/instantly.ts's own createAccount/
 * pauseAccount/resumeAccount/enableWarmup/disableWarmup wrappers and the
 * store actions calling them are left in place (harmless, unused) rather
 * than torn out, in case this needs to come back later — nothing in this
 * component calls them anymore. */
export function AccountsPanel() {
  const accounts = useInstantlyAccountsStore((s) => s.accounts);
  const ready = useInstantlyAccountsStore((s) => s.ready);
  const error = useInstantlyAccountsStore((s) => s.error);
  const refresh = useInstantlyAccountsStore((s) => s.refresh);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  const renderRow = (account: InstantlyAccount) => {
    const pill = statusPillStyle(account.status);
    return (
      <div className="instantly-row" key={account.email}>
        <div className="instantly-row-main">
          <span className="instantly-row-title">{account.email}</span>
          <span className="instantly-row-subtitle">
            Dienos limitas: {account.daily_limit} · Warmup: {WARMUP_STATUS_LABELS[account.warmup_status] ?? account.warmup_status}
            {account.stat_warmup_score !== null ? ` (${account.stat_warmup_score})` : ''}
          </span>
        </div>
        <span className="instantly-pill" style={pill}>
          {ACCOUNT_STATUS_LABELS[account.status] ?? account.status}
        </span>
      </div>
    );
  };

  return (
    <div className="instantly-panel">
      {ready && accounts.length === 0 && <p className="instantly-hint">Kol kas nėra prijungtų pašto dėžučių.</p>}
      <div className="instantly-list">{accounts.map(renderRow)}</div>
    </div>
  );
}
