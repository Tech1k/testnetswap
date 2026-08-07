/* No-flash theme, plus the toggle-button wiring. Loaded synchronously in <head> so the
   data-theme attribute is set before first paint; the DOM part wires up once ready.
   Self-contained, no deps, CSP-safe. Shares the 'ts-theme' key with the testnet suite.
   SPDX-License-Identifier: AGPL-3.0-or-later */
(function () {
  var root = document.documentElement;
  function pref() { return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'; }
  function stored() { try { var t = localStorage.getItem('ts-theme'); return (t === 'light' || t === 'dark') ? t : null; } catch (e) { return null; } }
  function cur() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

  // 1) Set before paint (no flash of the wrong theme).
  root.setAttribute('data-theme', stored() || pref());

  // 2) Wire the toggle button (and the meta theme-color) once the DOM exists.
  function wire() {
    var btn = document.getElementById('theme-toggle');
    var metaColor = document.querySelector('meta[name="theme-color"]');
    function paint() {
      if (btn) btn.setAttribute('aria-pressed', cur() === 'light' ? 'true' : 'false');
      if (metaColor) metaColor.setAttribute('content', cur() === 'light' ? '#f7f7f7' : '#14161b');
    }
    paint();
    if (btn) {
      btn.addEventListener('click', function () {
        var t = cur() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', t);
        try { localStorage.setItem('ts-theme', t); } catch (e) { /* private mode */ }
        paint();
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
