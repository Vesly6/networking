import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../store/useAuthStore';

interface RegistrationViewProps {
  /** Whatever followed "/reg" in the URL — sent as-is to POST
   * /api/register, which compares it (constant-time) against
   * REGISTRATION_SECRET in server/.env. A wrong value fails with the same
   * generic message a missing/expired login would, never a distinct
   * "wrong secret" — see index.ts's own doc comment on why. */
  secret: string;
}

/** App.tsx renders this instead of the normal login/app flow whenever the
 * URL path matches /reg<anything> — checked via a plain
 * window.location.pathname regex, not a router dependency (this app has
 * none, and doesn't need one for a single fixed path). Submitting creates
 * a brand-new, fully isolated company and logs the submitter straight in
 * as its first super-admin (see accounts/db.ts's createCompany/createUser
 * and index.ts's POST /api/register). On success this does a hard
 * navigation to "/" rather than a soft state update — the URL still says
 * /reg<secret> at that point, and App.tsx's own routing check runs before
 * it even looks at the auth token, so nothing short of an actual reload
 * would move past this screen even though the new session is already
 * valid and stored. */
export function RegistrationView({ secret }: RegistrationViewProps) {
  const register = useAuthStore((s) => s.register);
  const loggingIn = useAuthStore((s) => s.loggingIn);
  const error = useAuthStore((s) => s.error);
  const [companyName, setCompanyName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    register({ secret, companyName, username, password, firstName, lastName })
      .then(() => {
        window.location.href = '/';
      })
      .catch(() => {});
  };

  const canSubmit = companyName.trim() && username.trim() && password && firstName.trim();

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Nauja kompanija</h1>
        <label className="popover-field">
          <span>Kompanijos pavadinimas</span>
          <input autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        </label>
        <label className="popover-field">
          <span>Vartotojo vardas</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label className="popover-field">
          <span>Slaptažodis</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="popover-field">
          <span>Vardas</span>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </label>
        <label className="popover-field">
          <span>Pavardė</span>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="primary" disabled={loggingIn || !canSubmit}>
          {loggingIn ? 'Registruojama…' : 'Sukurti kompaniją'}
        </button>
      </form>
    </div>
  );
}
