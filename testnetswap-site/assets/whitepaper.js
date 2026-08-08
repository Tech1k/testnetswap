/* Whitepaper table-of-contents scroll-spy: highlights the current section in the
   sticky contents rail as the reader scrolls. Self-contained, no deps, CSP-safe
   (loaded as /assets/whitepaper.js under the strict per-page script-src 'self').
   SPDX-License-Identifier: AGPL-3.0-or-later */
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.wp-toc a'));
  if (!links.length) return;
  var map = {};
  links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var sections = Array.prototype.slice.call(document.querySelectorAll('section.wp-sec'));
  if (!('IntersectionObserver' in window) || !sections.length) return;
  var current = null;
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        var id = e.target.id;
        if (current && map[current]) map[current].classList.remove('active');
        if (map[id]) { map[id].classList.add('active'); current = id; }
      }
    });
  }, { rootMargin: '-10% 0px -80% 0px', threshold: 0 });
  sections.forEach(function (s) { obs.observe(s); });
})();
