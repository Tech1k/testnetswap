// SPDX-License-Identifier: AGPL-3.0-or-later
/* /donate: renders a QR (with the coin logo in the centre) for each donation address and
 * wires the copy buttons. Self-contained; the QR SVG is inline, no external requests. */
import qrcode from '/vendor/qrcode.mjs';

function qrSvg(text) {
  // level H (high error correction) so the centre logo occlusion is tolerated.
  try { const q = qrcode(0, 'H'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { return ''; }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.card[data-uri]').forEach((card) => {
    const uri = card.getAttribute('data-uri');
    const coin = card.getAttribute('data-coin');
    const slot = card.querySelector('.qrslot');
    if (!slot || !uri) return;
    const wrap = document.createElement('a');
    wrap.className = 'qr';
    wrap.href = uri;
    wrap.title = 'Open in wallet';
    wrap.innerHTML = qrSvg(uri);
    if (coin) {
      const logo = document.createElement('span');
      logo.className = 'qr-logo';
      const img = document.createElement('img');
      img.src = '/assets/coins/' + coin + '.svg';
      img.alt = '';
      logo.append(img);
      wrap.append(logo);
    }
    slot.append(wrap);
  });
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      try { navigator.clipboard && navigator.clipboard.writeText(btn.getAttribute('data-copy')); } catch {}
      const o = btn.textContent; btn.textContent = '✓'; setTimeout(() => (btn.textContent = o), 1000);
    });
  });
});
