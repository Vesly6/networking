import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../store/useAuthStore';

/** Full-screen gate — App.tsx renders this instead of the real app
 * whenever useAuthStore has no valid token. Real multi-tenant accounts
 * now (server/src/accounts/db.ts) — there's still no public sign-up here,
 * just username + password; the only way a *new* account gets created is
 * the owner-only secret registration link (see RegistrationView.tsx). */
export function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  const loggingIn = useAuthStore((s) => s.loggingIn);
  const error = useAuthStore((s) => s.error);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // login() rethrows so other callers can react to a failure; this one
    // doesn't need to — the store's own `error` state (read above) is
    // already what renders the message below, so an uncaught rejection
    // here would just be console noise on every wrong-password attempt.
    login(username, password).catch(() => {});
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>MyDesk</h1>
        <label className="popover-field">
          <span>Vartotojo vardas</span>
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label className="popover-field">
          <span>Slaptažodis</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="primary" disabled={loggingIn || !username || !password}>
          {loggingIn ? 'Jungiamasi…' : 'Prisijungti'}
        </button>
      </form>
    </div>
  );
}
