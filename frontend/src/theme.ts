import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const preference = window.matchMedia('(prefers-color-scheme: dark)');

function currentTheme(): Theme {
  const stored = document.documentElement.dataset.theme;
  return stored === 'light' || stored === 'dark' ? stored : preference.matches ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState(currentTheme);

  useEffect(() => {
    const sync = () => setTheme(currentTheme());
    preference.addEventListener('change', sync);
    return () => preference.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#f7f8fa');
  }, [theme]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem('memory-studio:theme', next); } catch { /* The current page still changes. */ }
  }

  return { theme, toggleTheme };
}
