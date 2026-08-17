import { create } from 'zustand';
import { localApiRequest } from '../utils/localApi';
import { getAuthToken, setAuthToken, setUnauthorizedHandler } from '../utils/authToken';

interface AuthState {
  token: string | null;
  loggingIn: boolean;
  error: string | null;
  /** True right after a login that used the recovery password rather than
   * the main one — App.tsx shows a one-time notice prompting the user to
   * go update AUTH_PASSWORD in their hosting dashboard, since there's no
   * in-app "change password" flow that persists anywhere (see
   * server/src/auth.ts for why). */
  loggedInViaRecovery: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  dismissRecoveryNotice: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: getAuthToken(),
  loggingIn: false,
  error: null,
  loggedInViaRecovery: false,

  login: async (username, password) => {
    set({ loggingIn: true, error: null });
    try {
      const { token, viaRecovery } = await localApiRequest<{ token: string; viaRecovery: boolean }>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      setAuthToken(token);
      set({ token, loggingIn: false, loggedInViaRecovery: viaRecovery });
    } catch (err) {
      set({ loggingIn: false, error: err instanceof Error ? err.message : 'Could not log in' });
      throw err;
    }
  },

  logout: () => {
    setAuthToken(null);
    set({ token: null, loggedInViaRecovery: false });
  },

  dismissRecoveryNotice: () => set({ loggedInViaRecovery: false }),
}));

setUnauthorizedHandler(() => useAuthStore.getState().logout());
