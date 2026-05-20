// js/theme/theme.js
//
// index.html lines 5985-6026 of post-v224 source.
//
// Side-effect-only module: declares THEME_KEY/MODES/META + applyTheme +
// cycleTheme, runs the init IIFE that reads localStorage and applies
// the stored theme, attaches the click handler to #themeToggle.
//
// No window exposures -- nothing else in the codebase calls applyTheme
// or reads THEME_META programmatically.

// ---------------------------------------------------------------
//  Theme toggle (preserved from v11)
// ---------------------------------------------------------------
const THEME_KEY = 'dow-theme-v1';
const themeToggle = document.getElementById('themeToggle');
const themeIcon = themeToggle.querySelector('.theme-icon');
const themeLabel = themeToggle.querySelector('.theme-label');
const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_META = {
  auto:  { icon: '◐', label: 'Auto' },
  light: { icon: '☀', label: 'Light' },
  dark:  { icon: '☾', label: 'Dark' },
};
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  const meta = THEME_META[mode] || THEME_META.auto;
  themeIcon.textContent = meta.icon;
  themeLabel.textContent = meta.label;
}
function cycleTheme() {
  const current = localStorage.getItem(THEME_KEY) || 'auto';
  const idx = THEME_MODES.indexOf(current);
  const next = THEME_MODES[(idx + 1) % THEME_MODES.length];
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  applyTheme(next);
  document.dispatchEvent(new CustomEvent('waypoint:themechange', { detail: { theme: next } }));
}
(function initTheme() {
  // continues to cycle auto / light / dark from there.
  document.documentElement.classList.add('v98-dark-default');
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  if (!stored || !THEME_MODES.includes(stored)) stored = 'dark';
  applyTheme(stored);
  const lbl = document.getElementById('v98ThemeLabel');
  if (lbl) lbl.textContent = stored.charAt(0).toUpperCase() + stored.slice(1);
})();
themeToggle.addEventListener('click', cycleTheme);

// Expose cycleTheme on window so classic-script callers (e.g.
// js/chrome/wire.js's #v98ThemeProxy click handler, which tests
// `typeof cycleTheme === 'function'`) can still invoke it after the
// move from inline IIFE to ES module. Without this exposure, clicking
// the v98 sidebar theme button silently no-ops because module-scoped
// declarations aren't visible to classic-script global lookups
// (F-NEW-V203-1 family: classic ↔ module bridge gap).
window.cycleTheme = cycleTheme;
