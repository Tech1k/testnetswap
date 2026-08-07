// SPDX-License-Identifier: AGPL-3.0-or-later
/* /network: the maker directory. Fetches the relay roster and renders one card per maker.
 * CRITICAL: every roster field comes from an UNTRUSTED maker, so it is rendered with
 * textContent only (via the el() helper below), never innerHTML. The relay also strictly
 * validates the info before serving it; this is defense-in-depth. Read-only, touches no keys. */
const meta = (n) => { const e = document.querySelector('meta[name="' + n + '"]'); return e && e.content; };
const RELAY = (window.TESTNETSWAP_RELAY || meta('testnetswap-relay') || 'wss://relay.testnetswap.com/');
const ROSTER = (window.TESTNETSWAP_ROSTER || meta('testnetswap-roster') || (RELAY.replace(/^ws/, 'http').replace(/\/?$/, '') + '/roster'));
const $ = (id) => document.getElementById(id);
const el = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const k of kids) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
const kv = (k, v) => el('div', 'kv', el('span', 'muted', k), v && v.nodeType ? v : el('span', null, v));
const fmtSats = (s) => (Number(s) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
// Rate: trim to ~6 significant figures so a reciprocal like 1/0.00082 prints "1219.51", not "1219.5121951219512".
const fmtRate = (r) => { const n = Number(r); return (isFinite(n) && n > 0) ? String(Number(n.toPrecision(6))) : String(r); };
const fmtXmr = (x) => { const n = Number(x); return isFinite(n) ? String(Number(n.toFixed(6))) : String(x); };
const shortId = (id) => String(id).slice(0, 10) + '…' + String(id).slice(-6);
function humanAge(sinceSec) { const n = Number(sinceSec); if (!isFinite(n)) return '?'; const s = Math.max(0, Math.floor(Date.now() / 1000) - n); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }

// Coin icon + ticker chip. Icons are static local SVGs; the ticker text stays textContent-safe.
const COIN_ICO = { tBTC: 'btc', tLTC: 'ltc', tXMR: 'xmr', sXMR: 'xmr' };
function coinIco(coin) {
  const k = COIN_ICO[coin] || String(coin || '').replace(/^[ts]/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const img = el('img', 'pair-ico'); img.src = '/assets/coins/' + k + '.svg'; img.width = 16; img.height = 16; img.alt = ''; img.loading = 'lazy';
  return img;
}
const coinChip = (coin) => el('span', 'coin-chip', coinIco(coin), coin);

function makerCard(m) {
  const info = m.info || {};
  const name = (typeof info.name === 'string' && info.name) ? info.name : ('maker ' + String(m.maker_id).slice(0, 8));
  // Group the dot + name into one .coin-name item so the card-header’s flex space-between keeps the
  // title on the left and the vouched/operator badge on the right (3 loose children would center it).
  const head = el('h2', 'card-header', el('span', 'coin-name', el('span', 'dot dot-ok mkr-dot', '●'), el('span', null, name))); // roster lists only live makers; h2 = real heading under the page h1
  // Operator-vouched badge: a TRUST hint set only by the relay operator (config), never self-reported.
  // Rendered as textContent like everything else. Takes precedence over the plain "operator" note.
  if (m.vouched) {
    const pill = el('span', 'vouched', '✓ ' + String(m.vouched));
    pill.title = 'Operator-confirmed identity, not an endorsement of reliability. Not a safety guarantee: your browser verifies every swap on-chain.';
    head.append(pill);
  } else if (m.default) {
    head.append(el('span', 'muted', ' · operator'));
  }
  const body = el('div', 'card-body');
  body.append(kv('Maker id', el('span', 'mono', shortId(m.maker_id))));
  body.append(kv('Uptime (relay-observed)', humanAge(m.connected_since)));
  // Unify the HTLC pairs and the Monero legs into one icon list. Monero legs settle to tBTC.
  const pairs = [];
  if (Array.isArray(info.pairs)) for (const p of info.pairs) pairs.push({ from: p.from, to: p.to, rate: p.rate, min: p.min_sats, max: p.max_sats, liq: p.liquidity_free_sats, unit: p.liquidity_unit });
  if (info.xmr && info.xmr.enabled) {
    // XMR legs carry rate + limits too (all relay-validated). One row per source ticker x settle coin,
    // so tXMR/sXMR -> tLTC show up automatically once a maker enables tLTC settlement. min/max are pico (1e12/XMR).
    const x = info.xmr, rates = x.rates || {};
    const tickers = (Array.isArray(x.tickers) && x.tickers.length) ? x.tickers : ['tXMR'];
    const settles = (Array.isArray(x.settle) && x.settle.length) ? x.settle : ['tBTC'];
    const minXmr = x.min_pico != null ? x.min_pico / 1e12 : null, maxXmr = x.max_pico != null ? x.max_pico / 1e12 : null;
    for (const t of tickers) for (const s of settles) {
      const rate = rates[s] != null ? rates[s] : (s === 'tBTC' ? x.rate_tbtc_per_xmr : null);
      const leg = { from: t, to: s, rate, minXmr, maxXmr };
      // Free liquidity at parity with HTLC pairs: relay-carried free sats per settle coin (the leg’s dest).
      if (x.free && x.free[s] != null) { leg.liq = x.free[s]; leg.unit = s; }
      pairs.push(leg);
    }
  }
  if (pairs.length) {
    body.append(el('div', 'muted pairs-label', 'Pairs (rate + limits self-reported; liquidity advertised, verified at quote)'));
    const wrap = el('div', 'pairs');
    for (const p of pairs) {
      const meta = [];
      if (p.rate != null) meta.push('1 ' + p.from + ' ≈ ' + fmtRate(p.rate) + ' ' + p.to);
      if (p.min != null && p.max != null) meta.push(fmtSats(p.min) + ' to ' + fmtSats(p.max) + ' ' + p.from);
      else if (p.minXmr != null && p.maxXmr != null) meta.push(fmtXmr(p.minXmr) + ' to ' + fmtXmr(p.maxXmr) + ' ' + p.from);
      if (p.liq != null) meta.push(fmtSats(p.liq) + ' ' + (p.unit || '') + ' available');
      wrap.append(el('div', 'pair',
        el('div', 'pair-legs', coinChip(p.from), el('span', 'pair-arrow', '→'), coinChip(p.to)),
        meta.length ? el('div', 'pair-meta muted', meta.join(' · ')) : null));
    }
    body.append(wrap);
  }
  // Neutral outcome counts, NOT a "success rate" (which reads as maker fault). Most non-completions
  // are taker-side or chain timing, and a refund is a safe outcome, so we show what happened, not a score.
  if (info.stats && info.stats.completed != null) {
    const st = info.stats, c = st.completed, r = st.refunded || 0, f = st.failed || 0, total = c + r + f;
    if (total > 0) {
      const parts = [c + ' completed'];
      if (r) parts.push(r + ' safely refunded');
      if (f) parts.push(f + ' unfinished');
      body.append(kv('Swap sessions (self-reported)', total + ' session' + (total === 1 ? '' : 's') + ': ' + parts.join(' · ')));
    }
  }
  const btn = el('a', 'formbtn', 'Swap with this maker →');
  btn.href = '/swap.html?maker=' + encodeURIComponent(m.maker_id);
  body.append(el('div', 'row', btn));
  return el('div', 'card', head, body);
}

// Anti-flicker: a fingerprint of the roster’s rendered fields, so an unchanged 20s poll doesn’t
// wipe and redraw every card. Rebuild only when the signature actually changes.
let lastSig = '';
function rosterSig(makers) {
  return makers.map((m) => {
    const info = m.info || {};
    const pc = Array.isArray(info.pairs) ? info.pairs.length : 0;
    const st = info.stats ? [info.stats.completed, info.stats.refunded, info.stats.failed, info.stats.success_rate].join('/') : '';
    return [m.maker_id, m.connected_since, info.name || '', pc, info.xmr && info.xmr.enabled ? 1 : 0, st].join(':');
  }).join('|');
}

async function load() {
  const host = $('makers-host'), dot = $('net-dot'), txt = $('net-text');
  try {
    const j = await (await fetch(ROSTER, { headers: { accept: 'application/json' } })).json();
    const makers = (Array.isArray(j.makers) ? j.makers : []).slice(0, 100); // cap: never render an unbounded roster
    dot.className = 'dot ' + (makers.length ? 'dot-ok' : 'dot-off');
    txt.textContent = makers.length ? (makers.length + ' maker' + (makers.length === 1 ? '' : 's') + ' online') : 'No makers online right now.';
    const sig = makers.length ? rosterSig(makers) : 'empty';
    if (sig !== lastSig) {
      if (makers.length) host.replaceChildren(...makers.map(makerCard));
      else host.replaceChildren(el('div', 'card', el('div', 'card-body', el('p', 'muted', 'No makers are online. Run one and join. See "Be your own maker" below.'))));
      lastSig = sig;
    }
  } catch { dot.className = 'dot dot-off'; txt.textContent = 'Could not reach the relay roster.'; } // keep last-good cards on a transient poll failure
}
document.addEventListener('DOMContentLoaded', () => {
  const host = $('makers-host');
  if (host) host.replaceChildren(el('div', 'card', el('div', 'card-body', el('p', 'muted', 'Loading makers…')))); // seed a skeleton so there’s no blank gap
  load();
  setInterval(load, 20000);
});
