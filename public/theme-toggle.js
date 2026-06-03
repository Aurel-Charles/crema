// Crema — shared light/dark toggle wiring (V7.7 — extracted from the duplicate
// that lived in /settings and the display gear panel, V7.6).
//
// appearance.js owns *applying* the theme (DOM data-theme + localStorage cache +
// the page-wide theme:updated re-skin). This module only drives a `.toggle`
// button: reflect the persisted value, PUT the new one optimistically (instant
// feel via cremaApplyTheme), roll back on failure, and resync the switch when a
// change is made elsewhere (the phone, another tab, the Pi's own screen).
//
// Single source of truth for /settings and the display gear panel — both call
// window.cremaThemeToggle.bind(buttonEl, socket).
(function () {
  // bind(btn, socket) — wire an existing .toggle button. `socket` is optional;
  // when given, theme:updated keeps the switch in step with remote changes.
  // Returns { load, reflect } so callers can refresh on demand (e.g. on panel
  // open) or set the state without a round-trip.
  function bind(btn, socket) {
    function reflect(dark) {
      btn.setAttribute('aria-pressed', String(dark === true));
    }

    async function load() {
      try {
        const { theme } = await (await fetch('/theme')).json();
        reflect(theme === 'dark');
      } catch {}
    }

    async function set(dark) {
      const prev = btn.getAttribute('aria-pressed') === 'true';
      btn.disabled = true;
      reflect(dark);
      window.cremaApplyTheme?.(dark ? 'dark' : 'light');
      try {
        const r = await fetch('/theme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: dark ? 'dark' : 'light' }),
        });
        if (!r.ok) throw new Error();
      } catch {
        reflect(prev);
        window.cremaApplyTheme?.(prev ? 'dark' : 'light');
      } finally {
        btn.disabled = false;
      }
    }

    btn.addEventListener('click', () => set(btn.getAttribute('aria-pressed') !== 'true'));
    if (socket) socket.on('theme:updated', ({ theme } = {}) => reflect(theme === 'dark'));

    return { load, reflect };
  }

  window.cremaThemeToggle = { bind };
})();
