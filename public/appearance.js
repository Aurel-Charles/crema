// Crema — appearance (light/dark) bootstrap (V7.4).
//
// Loaded *synchronously in <head>, before theme.css*, so the cached choice is
// applied to <html data-theme> before the first paint (no light-mode flash on a
// dark Pi). theme.css carries the actual palette: :root = light defaults,
// :root[data-theme="dark"] = the deep-indigo "Mega Type" night remap.
//
// The Pi is the source of truth (data/theme.json). localStorage is only a
// flash-free cache; on load we reconcile with GET /theme and subscribe to the
// `theme:updated` socket event so a switch made on the phone re-skins the
// screen — and vice-versa — live, no reload.
(function () {
  var KEY = 'crema-theme';
  var root = document.documentElement;

  function apply(theme) {
    var dark = theme === 'dark';
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch (e) {}
    // Keep the PWA status-bar tint in step with the surface behind it.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#15102A' : '#FBF1E2');
  }

  // 1. Immediate — cached value, before CSS paints. Absent/light = leave the
  //    :root light defaults untouched.
  try {
    if (localStorage.getItem(KEY) === 'dark') root.setAttribute('data-theme', 'dark');
  } catch (e) {}

  // Exposed so the settings toggle can reflect a choice instantly (optimistic
  // UI) before the PUT round-trips.
  window.cremaApplyTheme = apply;

  // 2. After load — reconcile with the Pi, then track live changes. Deferred to
  //    `load` so socket.io.js (sync, end of <body>) has defined window.io;
  //    calling io() here reuses the page's existing default socket.
  window.addEventListener('load', function () {
    fetch('/theme')
      .then(function (r) { return r.json(); })
      .then(function (d) { apply(d.theme); })
      .catch(function () {});
    if (window.io) {
      try { io().on('theme:updated', function (d) { apply(d.theme); }); } catch (e) {}
    }
  });
})();
