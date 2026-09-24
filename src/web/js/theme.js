// Tema chiaro / scuro / di sistema, ricordato nel browser.

const themeQuery = window.matchMedia('(prefers-color-scheme: light)');

export function getThemePref() {
  try { return localStorage.getItem('polipo-theme') || 'dark'; } catch (_) { return 'dark'; }
}

export function applyTheme(pref) {
  if (pref) { try { localStorage.setItem('polipo-theme', pref); } catch (_) { /* ignora */ } }
  const p = pref || getThemePref();
  const theme = p === 'system' ? (themeQuery.matches ? 'light' : 'dark') : p;
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event('themechange'));
}

themeQuery.addEventListener('change', () => { if (getThemePref() === 'system') applyTheme(); });
