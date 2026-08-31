import { useState, type FormEvent } from 'react';
import { useSuperAdminStore } from '../store/useSuperAdminStore';

/** Mirrors LoginScreen.tsx's shape exactly, but for the independent
 * super-admin identity — App.tsx's /supersuperadmin route renders this
 * instead of <AdminView /> whenever useSuperAdminStore has no valid
 * token. Deliberately a completely separate screen/credential from the
 * normal login (see useSuperAdminStore.ts's own doc comment) — a regular
 * account's own username/password never grants access here, and this
 * screen never asks for or checks one. */
export function SuperAdminLoginScreen() {
  const login = useSuperAdminStore((s) => s.login);
  const loggingIn = useSuperAdminStore((s) => s.loggingIn);
  const error = useSuperAdminStore((s) => s.error);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    login(username, password).catch(() => {});
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Valdymo skydas</h1>
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
