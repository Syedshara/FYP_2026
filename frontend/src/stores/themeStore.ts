import { create } from 'zustand';

type Theme = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

/** Read persisted theme or default to dark */
function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem('n8n-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'dark';
}

/** Apply theme to <html> element */
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Also persist
  try {
    localStorage.setItem('n8n-theme', theme);
  } catch {
    // localStorage unavailable
  }
}

// Apply initial theme immediately (before React renders)
const initialTheme = getInitialTheme();
applyTheme(initialTheme);

export const useThemeStore = create<ThemeState>()((set, get) => ({
  theme: initialTheme,
  toggle: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
  },
  setTheme: (t: Theme) => {
    applyTheme(t);
    set({ theme: t });
  },
}));
