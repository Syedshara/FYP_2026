import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, TokenResponse } from '@/types';
import { authApi } from '@/api/auth';

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** true while we're restoring session from persisted token on app boot */
  isHydrating: boolean;

  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  setTokens: (tokens: TokenResponse) => void;
  fetchUser: () => Promise<void>;
  /** Called once on app mount to restore session from persisted token */
  restoreSession: () => Promise<void>;
  /** Silent token refresh using refresh_token */
  refreshAccessToken: () => Promise<string | null>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      isHydrating: true, // starts true — resolved by restoreSession

      login: async (username, password) => {
        set({ isLoading: true });
        try {
          const tokens = await authApi.login({ username, password });
          set({
            token: tokens.access_token,
            refreshToken: tokens.refresh_token,
            isAuthenticated: true,
            isLoading: false,
          });
          // Fetch user profile
          const user = await authApi.me();
          set({ user });
        } catch (err) {
          set({ isLoading: false });
          throw err;
        }
      },

      logout: () => {
        set({
          token: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          isHydrating: false,
        });
      },

      setTokens: (tokens) => {
        set({
          token: tokens.access_token,
          refreshToken: tokens.refresh_token,
          isAuthenticated: true,
        });
      },

      fetchUser: async () => {
        if (!get().token) return;
        try {
          const user = await authApi.me();
          set({ user, isAuthenticated: true });
        } catch {
          get().logout();
        }
      },

      restoreSession: async () => {
        const { token, refreshToken } = get();

        // No persisted token — nothing to restore
        if (!token) {
          set({ isHydrating: false });
          return;
        }

        try {
          // Try /auth/me with existing token
          const user = await authApi.me();
          set({ user, isAuthenticated: true, isHydrating: false });
        } catch {
          // Token expired — try refresh
          if (refreshToken) {
            try {
              const tokens = await authApi.refresh(refreshToken);
              set({
                token: tokens.access_token,
                refreshToken: tokens.refresh_token,
              });
              const user = await authApi.me();
              set({ user, isAuthenticated: true, isHydrating: false });
            } catch {
              // Refresh also failed — force logout
              get().logout();
            }
          } else {
            get().logout();
          }
        }
      },

      refreshAccessToken: async () => {
        const { refreshToken } = get();
        if (!refreshToken) return null;
        try {
          const tokens = await authApi.refresh(refreshToken);
          set({
            token: tokens.access_token,
            refreshToken: tokens.refresh_token,
            isAuthenticated: true,
          });
          return tokens.access_token;
        } catch {
          get().logout();
          return null;
        }
      },
    }),
    {
      name: 'iot-ids-auth',
      partialize: (state) => ({
        token: state.token,
        refreshToken: state.refreshToken,
        user: state.user,
      }),
    },
  ),
);
