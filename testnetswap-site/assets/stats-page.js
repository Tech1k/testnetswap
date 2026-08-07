// SPDX-License-Identifier: AGPL-3.0-or-later
/* TestnetSwap /stats: read-only. Fetches the maker’s /api/stats + /api/status and renders
 * all-time totals, live liquidity, an activity chart, and a per-pair breakdown. Everything
 * is inline (SVG chart, no chart lib) so it stays CSP-safe. Never touches keys or coins. */
const SATS = 1e8;
const PICO = 1e12; // XMR is denominated in pico (1e12/XMR), not sats.
const COIN_ICO = { tBTC: 'btc', tLTC: 'ltc', tXMR: 'xmr', sXMR: 'xmr' };
const SVGNS = 'http://www.w3.org/2000/svg';
const meta = (n) => { const e = document.querySelector('meta[name="' + n + '"]'); return e && e.content; };
const API = (window.TESTNETSWAP_API || meta('testnetswap-api') || '/api').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const fmt = (n, dp) => { if (n == null || isNaN(n)) return '-'; let s = Number(n).toFixed(dp == null ? 8 : dp); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; };
const humanDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : '-');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
async function getJSON(path) { const r = await fetch(API + path, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

function coinName(c) {
  const wrap = el('span', 'coin-name');
  const raw = String(c || ''), i = raw.indexOf(':'), base = i >= 0 ? raw.slice(0, i) : raw, suffix = i >= 0 ? raw.slice(i + 1) : '';
  const k = COIN_ICO[base] || String(base || '').replace(/^t/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const img = document.createElement('img'); img.className = 'coin-ico'; img.src = '/assets/coins/' + k + '.svg'; img.alt = ''; img.width = 18; img.height = 18;
  img.addEventListener('error', () => { img.style.display = 'none'; }); // fall back to text-only if the icon is missing
  const label = suffix ? base + ' (' + suffix.replace(/-/g, ' ').replace(/\bxmr\b/gi, 'XMR') + ')' : base;
  wrap.append(img, el('span', null, label));
  return wrap;
}

// { tBTC: {total, committed, free}, ... } in sats -> stacked free/committed bars.
function renderLiq(liq) {
  const host = $('t-liq'); if (!host) return;
  const coins = Object.keys(liq || {}).filter((c) => (liq[c] && liq[c].total) > 0);
  if (!coins.length) { host.replaceChildren(el('div', 'muted', 'No liquidity reported.')); return; }
  host.replaceChildren(...coins.map((c) => {
    const d = liq[c] || {}, total = d.total || 0, committed = d.committed || 0, free = d.free || 0;
    const base = String(c).split(':')[0], denom = /XMR$/i.test(base) ? PICO : SATS, dp = base === 'tBTC' ? 6 : 4;
    const row = el('div', 'liq-row');
    const head = el('div', 'liq-head');
    head.append(coinName(c), el('span', 'num', fmt(free / denom, dp) + ' free / ' + fmt(total / denom, dp) + ' total'));
    const bar = el('div', 'liqbar');
    const segFree = el('span', 'seg free'); segFree.style.width = (total ? free / total * 100 : 0).toFixed(2) + '%'; segFree.title = 'Free: ' + fmt(free / denom, dp) + ' ' + c;
    const segCom = el('span', 'seg committed'); segCom.style.width = (total ? committed / total * 100 : 0).toFixed(2) + '%'; segCom.title = 'Committed: ' + fmt(committed / denom, dp) + ' ' + c;
    bar.append(segFree, segCom);
    row.append(head, bar);
    if (committed > 0) {
      const lg = el('div', 'liq-legend');
      const mk = (kind, label) => { const s = el('span', 'lg'); s.append(el('span', 'sw ' + kind), document.createTextNode(label)); return s; };
      lg.append(mk('free', 'Free ' + fmt(free / denom, dp)), mk('committed', 'Committed ' + fmt(committed / denom, dp)));
      row.append(lg);
    }
    return row;
  }));
}

// { 'YYYY-MM-DD': {completed, refunded, ...} } -> inline SVG bar chart. Renders a CONTINUOUS date
// axis (first activity .. today, capped at 30 days) with zero-filled gaps, so quiet days show as gaps
// instead of collapsing adjacent bars. Completed + safely-refunded are stacked; hover any column for
// its counts. Day keys are UTC (maker uses new Date().toISOString().slice(0,10)) so we match in UTC.
const DAY_MS = 86400000;
const utcKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const svgEl = (name, attrs) => { const e = document.createElementNS(SVGNS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
function renderChart(byDay) {
  const host = $('t-chart'); if (!host) return;
  const bd = byDay || {};
  const keys = Object.keys(bd).sort();
  if (!keys.length) { host.replaceChildren(el('div', 'muted', 'No activity recorded yet.')); return; }
  const todayMs = new Date(utcKey(Date.now()) + 'T00:00:00Z').getTime();
  const floorKey = utcKey(todayMs - 29 * DAY_MS);                 // 30-day window ceiling
  const startKey = keys[0] > floorKey ? keys[0] : floorKey;      // start at first activity, else 30d ago (string compare is date-safe)
  const days = [];
  for (let t = new Date(startKey + 'T00:00:00Z').getTime(); t <= todayMs; t += DAY_MS) days.push(utcKey(t));
  const comp = days.map((d) => (bd[d] && bd[d].completed) || 0);
  const refd = days.map((d) => (bd[d] && bd[d].refunded) || 0);
  const max = Math.max(1, ...days.map((_, i) => comp[i] + refd[i]));

  const W = 640, H = 170, padL = 26, padR = 6, padB = 22, padT = 10, n = days.length;
  const plotH = H - padB - padT, bw = (W - padL - padR) / n, base = H - padB;
  const lblStep = n <= 12 ? 1 : n <= 24 ? 2 : 7;                  // label every day on a short window, thin out on a long one

  const wrap = el('div', 'chart-wrap');                           // non-scrolling: hosts the (styled) tooltip so it can't get clipped
  const chart = el('div', 'chart');                              // horizontal-scroll container for the svg only
  const tip = el('div', 'chart-tip'); tip.hidden = true;
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
    'aria-label': 'Completed and safely refunded swaps per day, last ' + n + ' days' });
  const lbl = (x, y, anchor, s) => { const t = svgEl('text', { class: 'lbl', x, y, 'text-anchor': anchor }); t.textContent = s; return t; };

  // y gridlines + value labels (max, and midpoint when it helps) so the scale is legible
  for (const gv of (max > 1 ? [max, Math.round(max / 2)] : [max])) {
    const gy = base - (gv / max) * plotH;
    svg.appendChild(svgEl('line', { class: 'grid', x1: padL, y1: gy.toFixed(1), x2: W - padR, y2: gy.toFixed(1) }));
    svg.appendChild(lbl(padL - 4, (gy + 4).toFixed(1), 'end', String(gv)));
  }
  svg.appendChild(svgEl('line', { class: 'axis', x1: padL, y1: base, x2: W - padR, y2: base }));

  // styled hover tooltip (native <title> is laggy + unstyled): built from DOM (CSP-safe), positioned by cursor.
  const showTip = (e, i) => {
    tip.replaceChildren(el('div', 'tt-d', days[i]));
    if (comp[i] + refd[i] === 0) tip.appendChild(el('div', 'tt-z', 'No swaps'));
    else {
      if (comp[i]) { const r = el('div', 'tt-c'); r.append(el('b', null, String(comp[i])), document.createTextNode(' completed')); tip.appendChild(r); }
      if (refd[i]) { const r = el('div', 'tt-r'); r.append(el('b', null, String(refd[i])), document.createTextNode(' safely refunded')); tip.appendChild(r); }
    }
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    let x = e.clientX - box.left + 14, y = e.clientY - box.top + 14;
    if (x + tip.offsetWidth > box.width) x = e.clientX - box.left - tip.offsetWidth - 14;   // flip left near the right edge
    tip.style.left = Math.max(2, x) + 'px'; tip.style.top = Math.max(2, y) + 'px';
  };

  days.forEach((d, i) => {
    const x = padL + i * bw, cx = x + bw * 0.12, w = bw * 0.76;
    // full-height transparent hover column: hovering anywhere in the day's column shows its tooltip
    const col = svgEl('rect', { class: 'col', x: x.toFixed(1), y: padT, width: bw.toFixed(1), height: plotH.toFixed(1) });
    col.addEventListener('mouseenter', (e) => showTip(e, i));
    col.addEventListener('mousemove', (e) => showTip(e, i));
    svg.appendChild(col);
    const cH = (comp[i] / max) * plotH, rH = (refd[i] / max) * plotH;
    if (cH > 0) svg.appendChild(svgEl('rect', { class: 'bar', x: cx.toFixed(1), y: (base - cH).toFixed(1), width: w.toFixed(1), height: Math.max(2, cH).toFixed(1), rx: '2' }));
    if (rH > 0) svg.appendChild(svgEl('rect', { class: 'bar-ref', x: cx.toFixed(1), y: (base - cH - rH).toFixed(1), width: w.toFixed(1), height: Math.max(2, rH).toFixed(1), rx: '2' }));
    if (i % lblStep === 0 || i === n - 1) svg.appendChild(lbl((cx + w / 2).toFixed(1), base + 14, 'middle', d.slice(5)));
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; });

  const legend = el('div', 'chart-legend');
  const key = (cls, label) => { const s = el('span', 'lg'); s.append(el('span', 'sw ' + cls), document.createTextNode(label)); return s; };
  legend.append(key('c', 'Completed'), key('r', 'Safely refunded'));
  chart.appendChild(svg); wrap.append(chart, tip);
  host.replaceChildren(legend, wrap);
}

// { 'tLTC->tBTC': count } -> proportional bars, biggest first.
function renderPairs(bp) {
  const host = $('t-pairs'); if (!host) return;
  const keys = Object.keys(bp || {}).sort((a, b) => bp[b] - bp[a]);
  if (!keys.length) { host.replaceChildren(el('div', 'muted', 'No completed swaps yet.')); return; }
  const max = Math.max(...keys.map((k) => bp[k]));
  host.replaceChildren(...keys.map((k) => {
    const [f, t] = k.split('->');
    const row = el('div', 'pair-row');
    const top = el('div', 'pair-top');
    top.append(el('span', null, f + ' → ' + t), el('span', 'n', bp[k] + ' swap' + (bp[k] === 1 ? '' : 's')));
    const bar = el('div', 'pair-bar');
    const s = document.createElement('span'); s.style.width = (bp[k] / max * 100).toFixed(1) + '%';
    bar.append(s);
    row.append(top, bar);
    return row;
  }));
}

// { tBTC: sats, tLTC: sats, tXMR: pico, ... } -> one stat tile per coin, unit chosen per coin.
function renderVolume(vol) {
  const grid = $('t-stats'); if (!grid) return;
  grid.querySelectorAll('.vol-tile').forEach((n) => n.remove());
  const v = vol || {};
  const coins = ['tLTC', 'tBTC'].concat(Object.keys(v).filter((c) => c !== 'tLTC' && c !== 'tBTC'));
  coins.forEach((c) => {
    const isXmr = /XMR$/i.test(c), denom = isXmr ? PICO : SATS, dp = (c === 'tBTC' || isXmr) ? 6 : 4;
    const stat = el('div', 'stat vol-tile');
    stat.appendChild(el('div', 'k', c + ' volume'));
    const val = el('div', 'v');
    val.append(document.createTextNode(fmt((v[c] || 0) / denom, dp) + ' '), el('small', null, c));
    stat.appendChild(val);
    grid.appendChild(stat);
  });
}

async function load() {
  try {
    const s = await getJSON('/status');
    const dot = $('status-dot'), txt = $('status-text');
    if (s.maker_online) { dot.className = 'dot dot-ok'; txt.textContent = 'Maker online'; }
    else { dot.className = 'dot dot-off'; txt.textContent = 'Maker offline'; }
    $('status-extra').textContent = s.version ? 'v' + s.version : '';
    if (s.active_swaps != null) $('t-active').textContent = String(s.active_swaps);
    renderLiq(s.liquidity);
  } catch { $('status-dot').className = 'dot dot-off'; $('status-text').textContent = 'Maker unreachable'; }

  try {
    const st = await getJSON('/stats');
    $('t-completed').textContent = st.completed != null ? String(st.completed) : '0';
    $('t-refunded').textContent = st.refunded != null ? String(st.refunded) : '0';
    $('t-success').textContent = st.success_rate != null ? Math.round(st.success_rate * 100) + '%' : '-';
    if (st.active_swaps != null) $('t-active').textContent = String(st.active_swaps);
    renderVolume(st.volume_sats);
    $('t-since').textContent = st.first_at ? ('Since ' + humanDate(st.first_at) + ' · last swap ' + humanDate(st.last_at)) : 'No swaps recorded yet.';
    renderChart(st.by_day);
    renderPairs(st.by_pair);
  } catch { $('t-completed').textContent = '-'; $('t-since').textContent = 'Stats unavailable.'; }
}

document.addEventListener('DOMContentLoaded', () => { load(); setInterval(load, 30000); });
