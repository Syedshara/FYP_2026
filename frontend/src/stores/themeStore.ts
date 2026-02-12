import { create } from 'zustand';

type Theme = 'light';

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

export const useThemeStore = create<ThemeState>()(
  () => ({
    theme: 'light' as Theme,
    toggle: () => {},
    setTheme: () => {},
  }),
);

// Always use terminal (light) theme — remove dark class
document.documentElement.classList.remove('dark');
