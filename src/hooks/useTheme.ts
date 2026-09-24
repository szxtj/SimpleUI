import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

export function useTheme(preference: ThemePreference = 'system', isSpotlight = false) {
  const getSystemTheme = (): 'light' | 'dark' => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  };

  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);

  // Listen to macOS system theme preference changes in real-time
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    } else {
      // Fallback for older WebKit
      mediaQuery.addListener(handler);
      return () => {
        mediaQuery.removeListener(handler);
      };
    }
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    preference === 'system' ? systemTheme : preference;
  const isDark = resolvedTheme === 'dark';

  // Apply to DOM
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    root.style.colorScheme = isDark ? 'dark' : 'light';

    if (isSpotlight) {
      root.style.backgroundColor = 'transparent';
      document.body.style.backgroundColor = 'transparent';
    } else {
      const bgColor = isDark ? '#18191c' : '#f8f9fb';
      root.style.backgroundColor = bgColor;
      document.body.style.backgroundColor = bgColor;
    }
  }, [isDark, isSpotlight]);

  return { resolvedTheme, isDark };
}
