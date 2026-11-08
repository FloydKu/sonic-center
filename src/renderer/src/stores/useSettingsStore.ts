import { create } from 'zustand';

export type ThemeId = 'dark' | 'light';

const THEME_KEY = 'sonic-center.theme';

interface SettingsState {
  /** 当前主题，dark = VS Code Dark+，light = 浅色 */
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

/** 应用主题到文档根元素（CSS 变量按 .theme-light 类切换） */
function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  if (theme === 'light') root.classList.add('theme-light');
  else root.classList.remove('theme-light');
}

/** 启动时恢复上次主题（无效值回退深色） */
function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    const theme = saved === 'light' ? 'light' : 'dark';
    applyTheme(theme);
    return theme;
  } catch {
    return 'dark';
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: loadTheme(),

  setTheme: (theme) => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* localStorage 不可用时静默忽略 */
    }
    set({ theme });
  },
}));
