// SPDX-License-Identifier: AGPL-3.0-or-later
/* TestnetSwap storefront: read-only. Fetches the maker’s status/discovery API
 * and renders live rate, liquidity, uptime, and a quote calculator. The "Swap
 * now" button opens the in-browser swap app (/swap.html), where the swap keys are
 * generated and held only in the tab. This script never touches keys or coins.
 * No build step, no deps. */
(function () {
  'use strict';

  var meta = function (n) { var e = document.querySelector('meta[name="' + n + '"]'); return e && e.content; };
  // API base: same-origin /api in production (reverse-proxied to the maker),
  // overridable via <meta name="testnetswap-api"> or window.TESTNETSWAP_API.
  var API = (window.TESTNETSWAP_API || meta('testnetswap-api') || '/api').replace(/\/$/, '');
  var WALLET = (window.TESTNETSWAP_WALLET || meta('testnetswap-wallet') || 'https://testnetwallet.net').replace(/\/$/, '');
  // Relay roster (multi-maker network): used only for the "N makers online" hero badge.
  var RELAY = (window.TESTNETSWAP_RELAY || meta('testnetswap-relay') || 'wss://relay.testnetswap.com/');
  var ROSTER = (window.TESTNETSWAP_ROSTER || meta('testnetswap-roster') || (RELAY.replace(/^ws/, 'http').replace(/\/?$/, '') + '/roster'));

  var $ = function (id) { return document.getElementById(id); };
  var state = { from: 'tLTC', to: 'tBTC', pairs: {}, valid: false };
  // Once live data has loaded at least once, a later transient refresh failure keeps the last-good
  // DOM instead of blanking everything; only the status dot/text flip. See loadStatus/loadPairs.
  var loadedOnce = false;
  // Monero caps advertised by the maker (null when XMR is off). Drives the tXMR/sXMR options in
  // the send dropdown + the inline estimate; the real quote/flow runs on the swap page.
  var xmrCaps = null;
  function isXmrFrom() { return state.from === 'tXMR' || state.from === 'sXMR'; }

  function fmt(n, dp) {
    if (n == null || isNaN(n)) return '-';
    var s = Number(n).toFixed(dp == null ? 8 : dp);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  // Set a stat value as "<number> <small>UNIT</small>" using DOM nodes only (never innerHTML),
  // matching the textContent-only posture of the XMR tiles. Renders '-' when the value is absent.
  function setValWithUnit(el, v, dp, unit) {
    if (!el) return;
    if (v == null) { el.textContent = '-'; return; }
    var small = document.createElement('small'); small.textContent = unit;
    el.replaceChildren(document.createTextNode(fmt(v, dp) + ' '), small);
  }

  // Build a `.stat` tile (label + value) with stable ids so dynamically-added XMR tiles can be
  // updated in place on later polls instead of rebuilt. Text is set by the caller via textContent.
  function makeStatTile(tileId, kId, vId) {
    var d = document.createElement('div'); d.className = 'stat'; d.id = tileId;
    var k = document.createElement('div'); k.className = 'k'; k.id = kId;
    var v = document.createElement('div'); v.className = 'v'; v.id = vId;
    d.appendChild(k); d.appendChild(v);
    return d;
  }
  function pairKey(f, t) { return f + '>' + t; }
  function curPair() { return state.pairs[pairKey(state.from, state.to)]; }

  async function getJSON(path, timeoutMs) {
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, timeoutMs || 8000);
    try {
      var r = await fetch(API + path, { signal: ac.signal, headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // ---- status (online / uptime / version) ----
  async function loadStatus() {
    var dot = $('status-dot'), txt = $('status-text'), extra = $('status-extra');
    try {
      var s = await getJSON('/status');
      loadedOnce = true;
      if (s.maker_online) {
        dot.className = 'dot dot-ok'; txt.textContent = 'Maker online';
        var bits = [];
        if (s.version) bits.push('v' + s.version);
        if (s.uptime_pct_24h != null) bits.push(s.uptime_pct_24h + '% uptime (24h)');
        else if (s.uptime_secs != null) bits.push('up ' + humanDur(s.uptime_secs));
        extra.textContent = bits.join(' · ');
      } else {
        dot.className = 'dot dot-off'; txt.textContent = 'Maker offline';
        extra.textContent = 'Swaps are temporarily paused. The site and your funds are unaffected.';
      }
      $('s-uptime').textContent = s.uptime_pct_24h != null ? s.uptime_pct_24h + '%' : (s.uptime_secs != null ? humanDur(s.uptime_secs) : '-');
      applyXmrCaps(s.xmr);
      return s;
    } catch (e) {
      dot.className = 'dot dot-off'; txt.textContent = 'Maker unreachable';
      // Only tear down the live data on a cold first load; a transient refresh failure keeps last-good.
      if (!loadedOnce) {
        extra.textContent = 'Can’t reach the maker right now. The site and your funds are unaffected.';
        $('s-uptime').textContent = '-';
        applyXmrCaps(null);
      }
      return null;
    }
  }

  function humanDur(secs) {
    secs = Math.floor(secs);
    var d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  // ---- cumulative all-time stats (shown once the first swap has settled) ----
  async function loadStats() {
    try {
      var s = await getJSON('/stats');
      if (!s || !s.ok || !(s.total > 0)) return;
      $('totals-card').style.display = '';
      $('s-swaps').textContent = s.completed != null ? String(s.completed) : '-';
      $('s-success').textContent = s.success_rate != null ? Math.round(s.success_rate * 100) + '%' : '-';
      var vol = s.volume || {};
      setValWithUnit($('s-vol-ltc'), vol.tLTC, 4, 'tLTC');
      setValWithUnit($('s-vol-btc'), vol.tBTC, 6, 'tBTC');
      renderVolTiles(s.volume_sats || {});
    } catch (e) { /* stats are optional */ }
  }

  // Append/refresh XMR volume tiles in the all-time totals grid, only for a Monero ticker with
  // recorded volume. Values are DERIVED from the RAW volume_sats field (XMR is denominated in pico,
  // 1e12), per the volume-units contract. Tiles are added on first non-zero volume, updated in place
  // on later polls, and removed if a coin’s volume drops to 0. HTLC tiles keep their fixed ids above.
  function renderVolTiles(volSats) {
    var grid = $('totals-grid'); if (!grid) return;
    ['tXMR', 'sXMR'].forEach(function (coin) {
      var raw = volSats && volSats[coin];
      var key = coin.toLowerCase();
      var tile = $('s-vol-' + key + '-tile');
      if (!(raw > 0)) { if (tile) tile.remove(); return; }
      if (!tile) { tile = makeStatTile('s-vol-' + key + '-tile', 's-vol-' + key + '-k', 's-vol-' + key); grid.appendChild(tile); }
      $('s-vol-' + key + '-k').textContent = coin + ' volume';
      var small = document.createElement('small'); small.textContent = coin;
      $('s-vol-' + key).replaceChildren(document.createTextNode(fmt(raw / 1e12, 6) + ' '), small);
    });
  }

  // ---- maker network: a live "N makers online" badge linking to /network ----
  // Read-only, best-effort. The roster is the multi-maker directory; if it’s unreachable
  // the badge simply stays hidden and the rest of the hero is unaffected.
  async function loadNetwork() {
    var badge = $('net-badge'), dot = $('net-dot'), txt = $('net-text');
    if (!badge) return;
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, 8000);
    try {
      var r = await fetch(ROSTER, { signal: ac.signal, headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      var n = Array.isArray(j.makers) ? j.makers.length : 0;
      if (n > 0) {
        dot.className = 'dot dot-ok';
        txt.textContent = n + ' maker' + (n === 1 ? '' : 's') + ' online';
        badge.style.display = '';
      } else { badge.style.display = 'none'; }
    } catch (e) {
      badge.style.display = 'none';
    } finally { clearTimeout(t); }
  }

  // ---- pairs (rate / min / max / liquidity) ----
  async function loadPairs() {
    try {
      var d = await getJSON('/pairs');
      loadedOnce = true;
      state.pairs = {};
      (d.pairs || []).forEach(function (p) { state.pairs[pairKey(p.from, p.to)] = p; });
      // liquidity tiles (HTLC pools) + the pairs strip (every supported direction + rate)
      var ltc2btc = state.pairs[pairKey('tLTC', 'tBTC')];
      var btc2ltc = state.pairs[pairKey('tBTC', 'tLTC')];
      setValWithUnit($('s-liq-btc'), ltc2btc ? ltc2btc.liquidity_free : null, 8, 'tBTC');
      setValWithUnit($('s-liq-ltc'), btc2ltc ? btc2ltc.liquidity_free : null, 8, 'tLTC');
      renderPairs();
      renderLegStatic();
      updateQuote();
    } catch (e) {
      if (!loadedOnce) { ['s-liq-btc', 's-liq-ltc'].forEach(function (id) { $(id).textContent = '-'; }); } // keep last-good tiles on a transient refresh failure
    }
  }

  // Valid receive coins for the current send coin: tLTC and tBTC are fixed HTLC partners; XMR
  // settles to the maker’s advertised settle coins (tBTC always, plus tLTC when advertised).
  function receiveTargets() {
    if (isXmrFrom()) return (xmrCaps && xmrCaps.settle) || ['tBTC'];
    return state.from === 'tLTC' ? ['tBTC'] : ['tLTC'];
  }
  // Rebuild the receive dropdown from those targets, but only when the target set actually changes,
  // so a mid-session re-render (30s poll) never clobbers the user’s pick. Keeps state.to in the set.
  var toTargetsKey = '';
  function populateReceive() {
    var sel = $('to-sel'); if (!sel) return;
    var targets = receiveTargets();
    var key = targets.join(',');
    if (key !== toTargetsKey) {
      toTargetsKey = key;
      sel.replaceChildren();
      targets.forEach(function (c) {
        var o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o);
      });
    }
    if (targets.indexOf(state.to) < 0) state.to = targets[0];
    sel.value = state.to;
  }

  // Map the selected coin to its round icon and point the dropdown’s leading <img> at it, so the icon
  // tracks the pick (tXMR/sXMR share the Monero icon). Called from renderLegStatic on every change.
  function setIco(imgId, coin) {
    var map = { tBTC: 'btc', tLTC: 'ltc', tXMR: 'xmr', sXMR: 'xmr' };
    var img = $(imgId), file = map[coin];
    if (img && file) img.src = '/assets/coins/' + file + '.svg';
  }

  function renderLegStatic() {
    var sel = $('from-sel'); if (sel) sel.value = state.from;
    populateReceive();
    setIco('from-ico', state.from);
    setIco('to-ico', state.to);
    if (isXmrFrom()) {
      var xr = xmrCaps && xmrCaps.rates ? xmrCaps.rates[state.to] : null;
      $('rate').textContent = xr != null ? ('1 ' + state.from + ' ≈ ' + fmt(xr) + ' ' + state.to) : '-';
      $('minmax').textContent = (xmrCaps && xmrCaps.min_pico != null) ? (fmt(xmrCaps.min_pico / 1e12) + ' to ' + fmt(xmrCaps.max_pico / 1e12) + ' ' + state.from) : '-';
      // Show the maker’s XMR-funding free liquidity for the settle coin when advertised. status.xmr.free
      // is in SATS (settle coin is an HTLC coin) → /1e8 for display; '-' when unfunded/absent.
      var xfree = (xmrCaps && xmrCaps.free) ? xmrCaps.free[state.to] : null;
      $('liq').textContent = (xfree > 0) ? (fmt(xfree / 1e8) + ' ' + state.to) : '-';
      return;
    }
    var p = curPair();
    $('minmax').textContent = p ? (fmt(p.min) + ' to ' + fmt(p.max) + ' ' + state.from) : '-';
    $('liq').textContent = p ? (fmt(p.liquidity_free) + ' ' + p.liquidity_unit) : '-';
    $('rate').textContent = p ? ('1 ' + state.from + ' ≈ ' + fmt(p.rate) + ' ' + state.to) : '-';
  }

  // Show the tXMR/sXMR options in the send dropdown only when the maker advertises Monero, and
  // capture its caps for the inline estimate. Mirrors the swap page’s applyXmrCaps. Idempotent (polled).
  function applyXmrCaps(xmr) {
    var sel = $('from-sel'); if (!sel) return;
    var enabled = !!(xmr && xmr.enabled && xmr.tickers && xmr.tickers.length);
    if (enabled) {
      var settle = (xmr.settle && xmr.settle.length) ? xmr.settle.filter(function (c) { return c === 'tBTC' || c === 'tLTC'; }) : ['tBTC'];
      xmrCaps = { tickers: xmr.tickers, settle: settle.length ? settle : ['tBTC'], rates: xmr.rates || {}, free: xmr.free || {}, min_pico: xmr.min_pico, max_pico: xmr.max_pico };
    } else { xmrCaps = null; }
    renderXmrLiveTiles();
    var allowed = enabled ? xmr.tickers : [];
    var dropped = false;
    Array.prototype.forEach.call(sel.options, function (opt) {
      if (opt.value === 'tXMR' || opt.value === 'sXMR') {
        var show = allowed.indexOf(opt.value) >= 0;
        opt.hidden = !show; opt.disabled = !show;
        if (!show && state.from === opt.value) dropped = true;
      }
    });
    // Maker turned XMR off while it was selected → fall back to the default HTLC pair.
    if (dropped) { state.from = 'tLTC'; state.to = 'tBTC'; $('flip').disabled = false; renderLegStatic(); updateQuote(); }
  }

  // Coin icon <img> for a rate row. Identity is carried by the coin’s own brand mark, so the rate
  // and limit values stay in plain ink (never color-coded). tXMR/sXMR share the Monero icon.
  function coinIcoImg(coin) {
    var map = { tBTC: 'btc', tLTC: 'ltc', tXMR: 'xmr', sXMR: 'xmr' };
    var img = document.createElement('img');
    img.src = '/assets/coins/' + (map[coin] || 'btc') + '.svg';
    img.alt = ''; img.setAttribute('aria-hidden', 'true');
    return img;
  }
  // Trim a rate to ~6 significant figures so a reciprocal like 1/0.005 prints "200", not a long tail.
  function fmtRate(r) { var n = Number(r); return (isFinite(n) && n > 0) ? String(Number(n.toPrecision(6))) : '-'; }
  function sp(cls, txt) { var s = document.createElement('span'); if (cls) s.className = cls; if (txt != null) s.textContent = txt; return s; }
  // A pair’s send-side min/max in coin units (the API carries both coin-unit and *_sats fields).
  function pairMin(p) { return p && p.min != null ? p.min : (p && p.min_sats != null ? p.min_sats / 1e8 : null); }
  function pairMax(p) { return p && p.max != null ? p.max : (p && p.max_sats != null ? p.max_sats / 1e8 : null); }
  // One rate row: coins on the left; the rate (in the receive coin) + the send-side min/max, right-
  // aligned so the row width is used. Reads as "1 <from> = <rate> <to>" (surfaced in the title).
  function rateRow(from, to, rate, min, max) {
    var coins = sp('rate-coins');
    coins.append(coinIcoImg(from), from, sp('ar', '→'), coinIcoImg(to), to);
    var num = sp('rate-num'); num.append(fmtRate(rate), sp('u', to));
    var meta = sp('rate-meta'); meta.append(num);
    if (min != null && max != null) meta.append(sp('rate-lim', fmt(min) + ' to ' + fmt(max) + ' ' + from));
    var row = sp('rate-row'); row.title = '1 ' + from + ' = ' + fmtRate(rate) + ' ' + to;
    row.append(coins, meta);
    return row;
  }
  // Build the Live rate list: HTLC both directions, plus every advertised XMR ticker x settle coin
  // (so XMR → tLTC and the stagenet sXMR pairs show, not just XMR → tBTC). Rebuilt on each poll.
  function renderPairs() {
    var host = $('pairs-strip'); if (!host) return;
    var rows = [];
    var l2b = state.pairs[pairKey('tLTC', 'tBTC')], b2l = state.pairs[pairKey('tBTC', 'tLTC')];
    if (l2b) rows.push(rateRow('tLTC', 'tBTC', l2b.rate, pairMin(l2b), pairMax(l2b)));
    if (b2l) rows.push(rateRow('tBTC', 'tLTC', b2l.rate, pairMin(b2l), pairMax(b2l)));
    if (xmrCaps && xmrCaps.tickers) {
      var xmin = xmrCaps.min_pico != null ? xmrCaps.min_pico / 1e12 : null;
      var xmax = xmrCaps.max_pico != null ? xmrCaps.max_pico / 1e12 : null;
      xmrCaps.tickers.forEach(function (tk) {
        (xmrCaps.settle || []).forEach(function (st) {
          var r = xmrCaps.rates ? xmrCaps.rates[st] : null;
          if (r != null) rows.push(rateRow(tk, st, r, xmin, xmax));
        });
      });
    }
    host.replaceChildren.apply(host, rows);
  }

  // Refresh the XMR liquidity tiles: one "XMR → <settle> free" tile per settle coin the maker
  // advertises (its dedicated xmr-funding balance, distinct from the HTLC-pool tiles). Rates now live
  // in the pairs strip, so no rate tile here. Inserted before uptime, updated in place, removed when off.
  function renderXmrLiveTiles() {
    var grid = $('stats'); if (!grid) return;
    var upt = $('s-uptime'); var before = upt ? upt.closest('.stat') : null;
    ['tBTC', 'tLTC'].forEach(function (st) {
      var id = 's-xmr-free-' + st, tileId = id + '-tile';
      var offered = xmrCaps && xmrCaps.settle && xmrCaps.settle.indexOf(st) >= 0;
      var freeSats = (offered && xmrCaps.free) ? xmrCaps.free[st] : null;   // SATS → /1e8 for display
      var tile = $(tileId);
      if (freeSats == null) { if (tile) tile.remove(); return; }
      if (!tile) { tile = makeStatTile(tileId, id + '-k', id); grid.insertBefore(tile, before); }
      $(id + '-k').textContent = 'XMR → ' + st + ' free';
      $(id).textContent = fmt(freeSats / 1e8) + ' ' + st;
    });
    renderPairs();
  }

  // Send-coin dropdown changed. HTLC pairs quote inline; XMR is previewed from the advertised rate
  // and the button deep-links to the swap page, where the heavy adaptor quote/flow actually runs.
  function onFromChange() {
    state.from = $('from-sel').value;
    $('flip').disabled = isXmrFrom(); // XMR is one-way; only HTLC pairs can flip
    populateReceive();                // derive/clamp state.to for the new send coin
    renderLegStatic();
    updateQuote();
  }

  // Receive-coin dropdown changed. Only offers a real choice when the send coin has >1 valid
  // target (e.g. XMR settling to both tBTC and tLTC). Re-quote for the new destination.
  function onToChange() {
    state.to = $('to-sel').value;
    renderLegStatic();
    updateQuote();
  }

  // XMR estimate from the maker’s advertised rate (the homepage doesn’t run the heavy adaptor
  // quote). The binding quote is fetched on the swap page, where the button deep-links.
  function xmrPreview(amt) {
    var msg = $('quote-msg');
    var settle = state.to;
    var rate = xmrCaps && xmrCaps.rates ? xmrCaps.rates[settle] : null;
    if (rate == null) { $('receive').textContent = '-'; show(msg, 'warn', 'This maker doesn’t quote ' + state.from + ' → ' + settle + '.'); return; }
    var lo = (xmrCaps.min_pico != null) ? xmrCaps.min_pico / 1e12 : null;
    var hi = (xmrCaps.max_pico != null) ? xmrCaps.max_pico / 1e12 : null;
    $('receive').textContent = fmt(amt * rate);
    $('rate').textContent = '1 ' + state.from + ' ≈ ' + fmt(rate) + ' ' + settle;
    if (lo != null && amt < lo) { show(msg, 'warn', 'Below the minimum (' + fmt(lo) + ' ' + state.from + ').'); return; }
    if (hi != null && amt > hi) { show(msg, 'warn', 'Above the maximum (' + fmt(hi) + ' ' + state.from + ').'); return; }
    hide(msg);
    setValid(true, amt);
  }

  // ---- quote ----
  var quoteTimer = null;
  function updateQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(doQuote, 250);
  }
  async function doQuote() {
    var amt = parseFloat($('amount').value);
    var msg = $('quote-msg');
    setValid(false);
    if (!(amt > 0)) { $('receive').textContent = '-'; hide(msg); return; }
    if (isXmrFrom()) { xmrPreview(amt); return; } // XMR: estimate locally, deep-link to the swap page
    $('receive').textContent = '…'; // show pending, not the stale number, while a slow quote is in flight
    try {
      var q = await getJSON('/quote?from=' + state.from + '&to=' + state.to + '&amount=' + encodeURIComponent(amt));
      if (q.ok) {
        $('receive').textContent = fmt(q.receive);
        $('rate').textContent = '1 ' + state.from + ' ≈ ' + fmt(q.rate) + ' ' + state.to;
        hide(msg);
        setValid(true, amt);
      } else {
        $('receive').textContent = '-';
        show(msg, 'warn', q.reason || 'Quote unavailable.');
      }
    } catch (e) {
      $('receive').textContent = '-';
      show(msg, 'bad', 'Could not reach the maker for a quote.');
    }
  }

  function setValid(ok, amt) {
    state.valid = ok;
    var btn = $('swap-btn');
    if (ok) {
      btn.setAttribute('aria-disabled', 'false');
      btn.style.opacity = '';
      btn.href = '/swap.html?from=' + state.from + '&to=' + state.to + '&amount=' + encodeURIComponent(amt);
    } else {
      btn.setAttribute('aria-disabled', 'true');
      btn.style.opacity = '0.5';
      btn.removeAttribute('href');
    }
  }
  function show(el, kind, text) { el.className = 'msg ' + kind; el.textContent = text; el.style.display = ''; }
  function hide(el) { el.style.display = 'none'; }

  function flip() {
    if (isXmrFrom()) return; // XMR is one-directional (no tBTC/tLTC -> XMR yet)
    var f = state.from; state.from = state.to; state.to = f;
    renderLegStatic();
    updateQuote();
  }

  // ---- wire up ----
  document.addEventListener('DOMContentLoaded', function () {
    $('amount').addEventListener('input', updateQuote);
    $('from-sel').addEventListener('change', onFromChange);
    $('to-sel').addEventListener('change', onToChange);
    $('flip').addEventListener('click', flip);
    $('swap-btn').addEventListener('click', function (e) {
      if (state.valid !== true || this.getAttribute('aria-disabled') === 'true') { e.preventDefault(); }
    });
    populateReceive(); // seed the receive dropdown so it’s never empty, even before data loads
    loadStatus();
    loadPairs();
    loadStats();
    loadNetwork();
    setInterval(function () { loadStatus(); loadPairs(); loadStats(); loadNetwork(); }, 30000); // refresh live data
  });
})();
