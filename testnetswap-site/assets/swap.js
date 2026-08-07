// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * TestnetSwap in-browser swap app (tBTC <-> tLTC, HTLC). Non-custodial: each swap
 * uses a fresh key generated and held ONLY in this browser (localStorage). The flow
 * is: quote (over the relay) -> deposit to an address only this browser controls ->
 * the shared swap-taker engine runs the atomic swap against the maker -> you receive
 * the other coin. If the maker stalls after you lock, you refund your deposit after
 * the timelock. The site server never sees keys or coins.
 *
 * Tradeoff vs a custodial exchange: your tab must stay open to finish the swap (the
 * browser is the taker). Closing it is safe: reopen to resume or refund.
 */
import * as sc from '/vendor/swap-core/src/index.js';
import { runHtlcTaker, genHtlcKeys, htlcFundingAddress, refundHtlc } from '/vendor/swap-taker/taker.js';
import { connectRelay } from '/vendor/swap-taker/relay.js';
import { esploraChain } from '/vendor/swap-taker/esplora.js';
import qrcode from '/vendor/qrcode.mjs';
import * as xmrswap from './xmr-swap.js';   // tXMR -> tBTC (adaptor swap); loads its heavy deps lazily

const meta = (n) => { const e = document.querySelector('meta[name="' + n + '"]'); return e && e.content; };
const RELAY = (window.TESTNETSWAP_RELAY || meta('testnetswap-relay') || 'wss://relay.testnetswap.com/');
const API = (window.TESTNETSWAP_API || meta('testnetswap-api') || '/api').replace(/\/$/, '');
// Multi-maker network: the roster lists makers online; the taker binds to one via ?maker=<id>.
const ROSTER = (window.TESTNETSWAP_ROSTER || meta('testnetswap-roster') || (RELAY.replace(/^ws/, 'http').replace(/\/?$/, '') + '/roster'));
let ROSTER_MAKERS = [];
let lastRosterSig = '';           // signature of the last-rendered maker option set; skip the rebuild when unchanged (so an open dropdown / current selection survives the 30s poll)
let selectedMaker = null;
let makerDeeplinkWarned = false; // so the ?maker= "not online" notice fires at most once
let xmrSettle = ['tBTC'];        // settle coins the selected maker offers for XMR swaps (tBTC and/or tLTC)
const relayUrl = () => (selectedMaker ? RELAY + (RELAY.includes('?') ? '&' : '?') + 'maker=' + encodeURIComponent(selectedMaker) : RELAY);
const FAUCET = 'https://cypherfaucet.com';
const FAUCET_SLUG = { tBTC: 'btc-testnet', tLTC: 'ltc-testnet' };
// SECURITY NOTE: the taker verifies the maker’s on-chain lock (the check that gates revealing
// its secret) against these explorers, so ideally they are INDEPENDENT of the operator.
//  - tBTC: mempool.space (independent). Good.
//  - tLTC: testnetscan.com (operator-run), used ONLY because Litecoin testnet has no reliable
//    independent Esplora right now (litecoinspace.org is stalled tens of thousands of blocks
//    behind). This is an accepted TESTNET tradeoff (no real value at stake). For a trustless
//    LTC leg with real stakes, point tLTC at an independent, well-synced Esplora instead.
const ESPLORA = { tBTC: 'https://mempool.space/testnet4/api', tLTC: 'https://testnetscan.com/ltc-testnet/api' };
const LS = 'testnetswap.swaps.v1';
const FEE_BUFFER = 1500; // sats the deposit must exceed the swap amount by (network fee)
const FAUCET_PAYOUT = 1_000_000; // CypherFaucet pays a fixed 0.01 coin (1e6 sats) per claim; "Fund from faucet" only helps when one claim covers the whole deposit
// Confirmations the taker waits on the maker's lock before revealing the secret (the irreversible
// step). Default 2 to match the maker's own deposit-confirmation gate: revealing on a SHALLOWER
// confirmation than the maker required is unsafe. The T1 refund does NOT back this: once the secret
// is public a malicious maker can claim the taker's contract with it before T1, so a reorg that
// drops the maker's lock plus a maker double-spend of that input would strand the taker. Raise via
// window/meta for deeper reorg safety on higher-stakes deployments. The XMR path defaults to 3.
const MIN_CONF = Math.max(1, Number(window.TESTNETSWAP_MIN_CONF ?? meta('testnetswap-min-conf') ?? 2) || 2);
// Rough sat cost of the taker’s redeem (claim) tx: a 1-input P2WSH spend + 1 output at ~2 sat/vB.
// Used only to show an honest "you keep (after ~claim fee)" estimate; the receipt shows the actual.
const REDEEM_FEE_EST = 350;

const chains = { tBTC: esploraChain({ api: ESPLORA.tBTC }), tLTC: esploraChain({ api: ESPLORA.tLTC }) };
const hx = sc.bytesToHex, unhx = sc.hexToBytes;
const $ = (id) => document.getElementById(id);
const el = (tag, props, ...kids) => { const e = document.createElement(tag); if (props) for (const k in props) { const v = props[k]; if (v == null) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); } return e; };
const fmt = (sats) => { let s = (sats / 1e8).toFixed(8); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; };
const toSats = (s) => Math.round(parseFloat(s) * 1e8);
const explorerTx = (coin, txid) => { try { return sc.getCoin(coin).explorer + '/tx/' + txid; } catch { return '#'; } };
const explorerAddr = (coin, a) => { try { return sc.getCoin(coin).explorer + '/address/' + a; } catch { return '#'; } };
const validAddr = (coin, a) => { try { sc.btc.Address(sc.getCoin(coin).network).decode(a); return true; } catch { return false; } };
// BIP21-style payment URI (wallets prefill address + amount from a QR).
const payUri = (coin, addr, sats) => (coin === 'tLTC' ? 'litecoin:' : 'bitcoin:') + addr + '?amount=' + (sats / 1e8);
// Inline SVG QR (self-contained, no external requests, CSP-safe).
function qrSvg(text) { try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { return ''; } }
// A copyable technical value: mono text + a tiny copy button.
function copyable(text, display) {
  const b = el('button', { class: 'copy mini', type: 'button', title: 'Copy', onclick: () => { if (b.dataset.copied) return; b.dataset.copied = '1'; try { navigator.clipboard && navigator.clipboard.writeText(text); } catch {} const o = b.textContent; b.textContent = '✓'; setTimeout(() => { b.textContent = o; delete b.dataset.copied; }, 1000); } }, '⧉');
  return el('span', { class: 'copyable' },
    el('span', { class: 'mono' }, display || text),
    b,
  );
}

const state = { from: 'tLTC', to: 'tBTC', quote: null, busy: false };
let deepTo = null; // a deep-linked ?to= settle coin, remembered to re-apply once the maker offers it (XMR path)

/* -------------------------------------------------- persistence (recovery-safe) */
function load() { try { return JSON.parse(localStorage.getItem(LS)) || []; } catch (e) { console.error('[swap] could not parse saved swaps:', e); return []; } }
// Throws loudly on failure (quota/disabled); callers persist recovery BEFORE moving
// coins, so a failed save must abort the swap rather than silently lose the key.
function save(recs) { try { localStorage.setItem(LS, JSON.stringify(recs)); } catch (e) { throw new Error('could not save swap state to this browser (storage full or blocked): ' + (e.message || e)); } }
function put(rec) { const recs = load().filter((r) => r.id !== rec.id); recs.push(rec); save(recs); }
function drop(id) { save(load().filter((r) => r.id !== id)); }
function kmHex(km) { return { secret: hx(km.secret), fundPriv: hx(km.fundPriv), recvPriv: hx(km.recvPriv), refundPriv: hx(km.refundPriv) }; }
function kmFromHex(o) { const secret = unhx(o.secret), fundPriv = unhx(o.fundPriv), recvPriv = unhx(o.recvPriv), refundPriv = unhx(o.refundPriv); return { secret, secretHash: sc.secretHashOf(secret), fundPriv, fundPub: sc.getPublicKey(fundPriv), recvPriv, recvPub: sc.getPublicKey(recvPriv), refundPriv, refundPub: sc.getPublicKey(refundPriv) }; }
function newId() { return hx(sc.randomSecret()).slice(0, 12); }

/* ---- recovery backup / restore: refund an in-flight swap from another device or after a browser wipe ---- */
// Download a swap as a JSON backup. It holds this swap key material, so it can refund the deposit
// from another device or after this browser is cleared; keep the file private (testnet coins only).
function downloadJSON(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function backupHtlc(r) { downloadJSON('testnetswap-recovery-' + r.id + '.json', { app: 'testnetswap', kind: 'htlc', version: 1, record: r }); }
// Restore a swap from a backup file (HTLC or XMR) so its refund/reclaim becomes available here.
// Validates the wrapper + the record shape, then routes to the matching store and re-renders.
function restoreFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(String(reader.result)); } catch { alert('That file is not a valid TestnetSwap backup.'); return; }
    if (!data || data.app !== 'testnetswap' || !data.record) { alert('That file is not a valid TestnetSwap backup.'); return; }
    if (data.kind === 'htlc') {
      const rec = data.record;
      if (!rec.id || !rec.from || !rec.to || !rec.km || !rec.recovery) { alert('This backup is missing the data needed to refund (it may be from before the swap was funded).'); return; }
      try { put(rec); } catch (e) { alert('Could not save the restored swap: ' + ((e && e.message) || e)); return; }
      renderSwaps();
      try { $('recovery').scrollIntoView({ behavior: 'smooth' }); } catch {}
    } else if (data.kind === 'xmr') {
      const existing = xmrswap.getRecovery();
      if (existing && existing.lockOutpoint && (!data.record.lockOutpoint || existing.lockOutpoint.txid !== data.record.lockOutpoint.txid)) {
        alert('You already have a different unreclaimed Monero swap saved here. Reclaim or Clear it first (on the swap page) before restoring another backup, so its recovery data is not overwritten.'); return;
      }
      if (!xmrswap.importRecovery(data.record)) { alert('This backup is missing the data needed to reclaim.'); return; }
      renderSwaps(); // surface it in My swaps
      xmrswap.renderRecovery($('flow'), showMsg);
      try { $('flow').scrollIntoView({ behavior: 'smooth' }); } catch {}
    } else { alert('Unknown backup type.'); }
  };
  reader.readAsText(file);
}

/* -------------------------------------------------- status */
async function loadStatus() {
  if (applySelectedMakerStatus()) return; // a non-operator maker is selected → its roster status owns the badge (U18)
  const dot = $('status-dot'), txt = $('status-text'), extra = $('status-extra');
  try {
    const r = await fetch(API + '/status', { headers: { accept: 'application/json' } });
    const s = await r.json();
    if (s.maker_online) { dot.className = 'dot dot-ok'; txt.textContent = 'Maker online'; extra.textContent = s.version ? 'v' + s.version : ''; }
    else { dot.className = 'dot dot-off'; txt.textContent = 'Maker offline'; extra.textContent = 'Swaps are paused. Your funds are unaffected.'; }
    applyXmrCaps(s.xmr);
  } catch { dot.className = 'dot dot-off'; txt.textContent = 'Maker unreachable'; extra.textContent = 'Your funds are unaffected.'; if (!state.busy) applyXmrCaps(null); } // hide the tXMR/sXMR options when /api/status can’t be fetched (guarded so a running swap isn’t disturbed)
}

// Offer exactly the Monero networks the maker serves (from /api/status). Hides tXMR/sXMR
// options the maker doesn’t run, and the whole XMR path when it is off. Idempotent (polled).
function applyXmrCaps(xmr) {
  const sel = $('from-sel'); if (!sel) return;
  const allowed = (xmr && xmr.enabled && Array.isArray(xmr.tickers)) ? xmr.tickers : [];
  // Settle coins this maker offers for XMR (tBTC always; tLTC if advertised). Reset a now-invalid pick.
  const settle = (xmr && xmr.enabled && Array.isArray(xmr.settle)) ? xmr.settle.filter((c) => c === 'tBTC' || c === 'tLTC') : [];
  const prevSettle = [...xmrSettle].sort().join(',');
  xmrSettle = settle.length ? settle : ['tBTC'];
  // Refresh the receive dropdown whenever the offered settle set CHANGES (order-insensitive, so a maker
  // that merely reorders the array doesn't rebuild the dropdown every poll), e.g. /api/status arrives
  // after tXMR was picked and adds tLTC, not only when the pick went invalid, or a newly-offered coin
  // never appears. Before the re-sync, re-apply a deep-linked ?to= once the maker offers it (else the
  // page snapped it away before status loaded). syncLegs() -> populateReceive() rebuilds + snaps.
  if (isXmrFrom() && !state.busy && [...xmrSettle].sort().join(',') !== prevSettle) {
    const prevTo = state.to;
    if (deepTo && xmrSettle.includes(deepTo)) { state.to = deepTo; deepTo = null; }
    syncLegs();
    if (state.to !== prevTo) { state.quote = null; scheduleQuote(); }
  }
  let dropped = false;
  for (const opt of Array.from(sel.options)) {
    if (opt.value === 'tXMR' || opt.value === 'sXMR') {
      const show = allowed.includes(opt.value);
      opt.hidden = !show; opt.disabled = !show;
      if (!show && state.from === opt.value) dropped = true;
    }
  }
  // Never rewrite the form out from under a running swap/reclaim (a 30s poll could otherwise
  // flip from-coin to tLTC and hide the tXMR refund leg mid-swap).
  if (dropped && !state.busy) { state.from = 'tLTC'; state.to = 'tBTC'; syncLegs(); scheduleQuote(); }
}

// When a NON-operator maker is selected, reflect ITS roster-observed connectivity + advertised XMR
// caps instead of the operator’s /api/status; otherwise the badge could read "online" while the
// chosen maker is offline, and the tXMR/sXMR options could mismatch what it serves.
const selEntry = () => ROSTER_MAKERS.find((m) => m.maker_id === selectedMaker) || null;
function applySelectedMakerStatus() {
  const e = selEntry();
  if (!e || e.default) return false; // operator/default maker → loadStatus() owns the badge
  const dot = $('status-dot'), txt = $('status-text'), extra = $('status-extra');
  if (dot && txt) { dot.className = 'dot dot-ok'; txt.textContent = 'Maker online'; } // roster lists only connected makers
  if (extra) extra.textContent = (e.info && e.info.version) ? 'v' + String(e.info.version) : '';
  applyXmrCaps(e.info && e.info.xmr);
  return true;
}

/* -------------------------------------------------- maker network (roster) */
// Populate the maker selector from the relay roster. ALL roster strings are rendered with
// textContent (via new Option), never innerHTML, since they come from untrusted makers.
async function loadRoster() {
  const sel = $('maker-sel'), row = $('maker-row');
  try {
    const j = await (await fetch(ROSTER, { headers: { accept: 'application/json' } })).json();
    ROSTER_MAKERS = (Array.isArray(j.makers) ? j.makers : []).slice(0, 100); // cap: never render an unbounded roster
    if (!sel) return;
    if (state.busy) { applySelectedMakerStatus(); return; } // don’t reshuffle the selector mid-swap (U21)
    // Skip the rebuild when the option set is byte-identical to what’s already rendered: a 30s poll
    // that calls sel.replaceChildren() would otherwise close an open dropdown / reset a fresh pick.
    const sig = ROSTER_MAKERS.map((m) => { const nm = (m.info && typeof m.info.name === 'string' && m.info.name) ? m.info.name : ('maker ' + String(m.maker_id).slice(0, 8)); const np = (m.info && Array.isArray(m.info.pairs)) ? m.info.pairs.length : 0; return String(m.maker_id) + '|' + nm + '|' + (m.default ? 1 : 0) + '|' + (m.vouched ? 1 : 0) + '|' + np; }).join('~');
    if (sig === lastRosterSig) { applySelectedMakerStatus(); return; }
    lastRosterSig = sig;
    const prev = selectedMaker;
    sel.replaceChildren();
    for (const m of ROSTER_MAKERS) {
      const nm = (m.info && typeof m.info.name === 'string' && m.info.name) ? m.info.name : ('maker ' + String(m.maker_id).slice(0, 8));
      const np = (m.info && Array.isArray(m.info.pairs)) ? m.info.pairs.length : 0;
      // Show a short maker_id fragment next to the (spoofable) name so a name-collision can’t hide the
      // real counterparty at the point of choice; mirrors the dashboard’s unforgeable-id display.
      // ✓ = operator-vouched (relay-config trust hint); ★ = default maker. Both are plain text in the option label.
      const mark = (m.default ? '★' : '') + (m.vouched ? '✓' : '');
      sel.append(new Option((mark ? mark + ' ' : '') + nm + ' · ' + String(m.maker_id).slice(0, 6) + (np ? ' · ' + np + ' pairs' : ''), m.maker_id));
    }
    const ids = ROSTER_MAKERS.map((m) => m.maker_id);
    const want = new URLSearchParams(location.search).get('maker');
    selectedMaker = (want && ids.includes(want)) ? want : (prev && ids.includes(prev)) ? prev : (j.default_maker && ids.includes(j.default_maker)) ? j.default_maker : (ids[0] || null);
    if (selectedMaker) sel.value = selectedMaker;
    const multi = ROSTER_MAKERS.length > 1;
    if (row) row.style.display = multi ? 'flex' : 'none';
    const note = $('maker-note'); if (note) note.style.display = multi ? '' : 'none'; // U19: safety reassurance next to the picker
    // U20: a ?maker= deep-link whose maker isn’t currently online silently fell back before; say so (once).
    if (want && !ids.includes(want) && selectedMaker && !makerDeeplinkWarned) { makerDeeplinkWarned = true; showMsg('warn', "That maker isn’t online right now. Using another available maker instead."); }
    if (!state.busy && selectedMaker !== prev) scheduleQuote(); // re-quote against the chosen maker
    applySelectedMakerStatus(); // reflect the chosen maker’s connectivity/caps immediately (U18)
  } catch { ROSTER_MAKERS = []; lastRosterSig = ''; if (row) row.style.display = 'none'; }
}
function onMakerChange() { selectedMaker = $('maker-sel').value; state.quote = null; if (!applySelectedMakerStatus()) loadStatus(); if (!state.busy) scheduleQuote(); }

/* -------------------------------------------------- quote (over the relay) */
let quoteTimer = null, quoteCountdown = null;
let refundTimer = null; // re-checks refund availability while any funded, unsettled swap is open (a 'Locked' swap can cross its T1 while the tab sits idle)
function scheduleQuote() { clearTimeout(quoteTimer); quoteTimer = setTimeout(doQuote, 350); }
const isXmrFrom = () => state.from === 'tXMR' || state.from === 'sXMR';
async function doQuote() {
  if (isXmrFrom()) return doXmrQuote();
  const msg = $('quote-msg'); const startBtn = $('start-btn');
  state.quote = null; startBtn.disabled = true;
  const sats = toSats($('amount').value);
  // State-accurate disabled label (quotes auto-fetch on input; the button is never a "click to quote"):
  if (!(sats > 0)) { startBtn.textContent = 'Enter an amount'; $('receive').textContent = '-'; hideMsg(); return; }
  startBtn.textContent = 'Getting a quote…'; $('receive').textContent = '…';
  let relay = null;
  try {
    relay = await connectRelay(relayUrl());
    if (relay.hello && relay.hello.maker_online === false) throw new Error('No maker is online right now.');
    relay.send(sc.buildMessage.requestQuote({ from: state.from, to: state.to, sendSats: sats }));
    const q = await relay.recv('quote', 15000);
    state.quote = q;
    $('receive').textContent = fmt(q.recv_sats);
    $('rate').textContent = '1 ' + state.from + ' ≈ ' + Number(q.rate).toPrecision(6) + ' ' + state.to;
    $('fee').textContent = '~' + fmt(FEE_BUFFER) + ' ' + state.from + ' (added to your deposit)';
    $('floor').textContent = '~' + fmt(Math.max(0, q.recv_sats - REDEEM_FEE_EST)) + ' ' + state.to;
    $('minmax').textContent = fmt(q.min_sats) + ' to ' + fmt(q.max_sats) + ' ' + state.from;
    $('timelocks').textContent = 'yours ~' + q.t1_hours + 'h · maker ~' + q.t2_hours + 'h';
    // Feature: live quote-expiry countdown; auto-refreshes the quote when it lapses.
    if (quoteCountdown) clearInterval(quoteCountdown);
    const exp = $('quote-expiry');
    if (q.expiry) {
      const upd = () => {
        if (state.quote !== q) { clearInterval(quoteCountdown); return; }
        const left = Math.round(q.expiry - Date.now() / 1000);
        if (left <= 0) { clearInterval(quoteCountdown); if (state.busy) { if (exp) exp.textContent = 'locked'; } else { if (exp) exp.textContent = 'refreshing…'; scheduleQuote(); } return; }
        if (exp) exp.textContent = 'in ' + left + 's';
      };
      upd(); quoteCountdown = setInterval(upd, 1000);
    } else if (exp) { exp.textContent = 'live'; }
    hideMsg();
    startBtn.disabled = false; startBtn.textContent = 'Start swap';
  } catch (e) {
    $('receive').textContent = '-';
    startBtn.textContent = /offline|no maker/i.test(e.message || '') ? 'Maker offline' : 'No quote available';
    showMsg('warn', e.message || 'Could not get a quote.');
  } finally { try { relay && relay.close(); } catch {} }
}
function showMsg(kind, text) { const m = $('quote-msg'); m.className = 'msg ' + kind; m.textContent = text; m.style.display = ''; }
function hideMsg() { $('quote-msg').style.display = 'none'; }

/* -------------------------------------------------- tXMR -> tBTC (adaptor swap) branch */
async function doXmrQuote() {
  const startBtn = $('start-btn'); state.quote = null;
  const amt = parseFloat($('amount').value);
  if (!(amt > 0)) { $('receive').textContent = '-'; hideMsg(); startBtn.disabled = true; startBtn.textContent = 'Enter an amount'; return; }
  $('receive').textContent = '…'; startBtn.disabled = true;
  await xmrswap.preview({
    fromCoin: state.from,
    toCoin: state.to,
    makerId: selectedMaker,
    sendPico: amt * 1e12,
    onQuote: (q) => { state.quote = q; $('receive').textContent = xmrswap.fmtBtc(q.lock_sats); $('rate').textContent = '1 ' + state.from + ' ≈ ' + (q.rate != null ? Number(q.rate).toPrecision(4) : '?') + ' ' + state.to + (q.network ? ' · Monero ' + q.network : ''); hideMsg(); startBtn.disabled = false; startBtn.textContent = 'Start swap'; },
    onErr: (e) => { $('receive').textContent = '-'; showMsg('warn', (e && e.message) || 'Could not get a quote.'); },
  });
}
async function startXmrSwap() {
  // H3: never start a new Monero swap while an unreclaimed lock is saved in THIS browser. The reclaim
  // blob lives in a single localStorage slot; starting a new swap overwrites it the instant the new
  // maker lock confirms, permanently stranding the first swap's locked XMR (the adaptor path has no
  // timelock refund). Force the user to reclaim or explicitly clear the existing swap first.
  if (xmrswap.hasRecovery()) {
    showMsg('bad', 'A previous Monero swap left a recovery record in this browser. If you sent Monero in it, Reclaim it below first. If you never sent any Monero, nothing is locked, so just Clear it. Either way, do that before starting a new swap, which would overwrite the record.');
    xmrswap.renderRecovery($('flow'), showMsg);
    try { $('flow').scrollIntoView({ behavior: 'smooth' }); } catch {}
    return;
  }
  const amt = parseFloat($('amount').value);
  const dest = ($('dest').value || '').trim();
  const xmrRefund = ($('xmr-refund') && $('xmr-refund').value || '').trim();
  if (!(amt > 0)) { showMsg('warn', 'Enter a ' + state.from + ' amount.'); return; }
  if (!validAddr(state.to, dest)) { showMsg('bad', 'Enter a valid ' + state.to + ' receive address.'); return; }
  if (!xmrRefund) { showMsg('bad', 'Enter your ' + state.from + ' refund address (where Monero returns if the swap stalls).'); return; }
  if (!xmrswap.isXmrAddr(xmrRefund, state.from)) { showMsg('bad', 'That does not look like a valid Monero address for ' + state.from + '. Double-check your refund address (this is where your Monero returns if the swap stalls).'); return; }
  hideMsg(); // clear any stale guard/validation banner now that a swap is actually starting
  state.busy = true;
  $('amount').disabled = $('dest').disabled = $('start-btn').disabled = true;
  if ($('xmr-refund')) $('xmr-refund').disabled = true;
  if ($('from-sel')) $('from-sel').disabled = true;
  if ($('to-sel')) $('to-sel').disabled = true;
  if ($('maker-sel')) $('maker-sel').disabled = true;
  $('start-btn').textContent = 'Swapping…';
  try { await xmrswap.run({ fromCoin: state.from, toCoin: state.to, makerId: selectedMaker, sendPico: amt * 1e12, btcDest: dest, xmrRefund, minLockSats: (state.quote && state.quote.lock_sats) || null, root: $('flow') }); }
  finally {
    // Always release the form once the run returns (success OR interrupt). Previously only the success
    // path re-enabled it (via "Swap again"), so an interrupted XMR swap left the whole form disabled
    // until a page reload. A lingering recovery still blocks a NEW XMR swap via the hasRecovery() guard;
    // an HTLC swap is fine. renderSwaps() refreshes the Monero card now that we're no longer busy.
    state.busy = false; resetForm(); renderSwaps();
  }
}

/* -------------------------------------------------- the swap flow */
async function startSwap() {
  if (state.busy) return;
  if (isXmrFrom()) return startXmrSwap();
  const sats = toSats($('amount').value);
  const dest = ($('dest').value || '').trim();
  if (!state.quote || !(sats > 0)) { showMsg('warn', 'Get a quote first.'); return; }
  if (!validAddr(state.to, dest)) { showMsg('bad', 'Enter a valid ' + state.to + ' receive address.'); return; }
  const km = genHtlcKeys(sc);
  // recvSats is the rate the user agreed to; enforced as a floor at execution (M-1).
  const rec = { id: newId(), ts: Date.now(), from: state.from, to: state.to, sendSats: sats, recvSats: state.quote.recv_sats, dest, km: kmHex(km), stage: 'deposit', depositAddr: htlcFundingAddress(sc, km, state.from) };
  try { put(rec); } catch (e) { showMsg('bad', e.message || 'Could not start: storage unavailable.'); return; }
  runRecord(rec);
}

// Drive a persisted record to completion (resumable). L-5: this is the single busy
// gate; every entry point (start / resume) routes through here.
async function runRecord(rec) {
  if (state.busy) return;
  state.busy = true;
  // The quote is committed once the swap starts, so freeze the expiry countdown; otherwise it lapses
  // mid-swap and sits on "refreshing…" forever (a busy swap never re-quotes).
  if (quoteCountdown) clearInterval(quoteCountdown);
  { const qe = $('quote-expiry'); if (qe) qe.textContent = 'locked'; }
  $('amount').disabled = $('dest').disabled = $('flip').disabled = $('start-btn').disabled = true;
  if ($('maker-sel')) $('maker-sel').disabled = true;
  const km = kmFromHex(rec.km);
  const depositAddr = rec.depositAddr;
  const need = rec.sendSats + FEE_BUFFER;
  const flow = $('flow');
  const setFlow = (...nodes) => { flow.replaceChildren(...nodes); };
  const txlink = (coin, txid) => { const t = String(txid); return el('a', { class: 'mono-link', style: 'display:inline;margin:0', href: explorerTx(coin, t), target: '_blank', rel: 'noopener' }, t.slice(0, 20) + '…'); };
  const kvRow = (label, val) => el('div', { class: 'kv' }, el('span', { class: 'muted' }, label), (val && val.nodeType) ? val : el('span', {}, String(val)));
  const fmtElapsed = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return (s >= 60 ? Math.floor(s / 60) + 'm ' : '') + (s % 60) + 's'; };
  // Protocol facts captured as the swap runs; surfaced in the Advanced panel + the receipt.
  // meta.secret is the user’s own preimage (public once revealed on-chain); it lives only in
  // this closure, is shown ONLY after completion, and never persists or reaches a status link.
  const meta = { hashlock: hx(km.secretHash), secret: hx(km.secret), started: 0, fundTxid: null, makerTxid: null, makerAddr: null, redeemTxid: null, times: {} };
  let tick = null;

  // Refined stepped tracker: every leg lights up (with its txid / confirmations) as it
  // happens, plus a live elapsed timer and an Advanced panel exposing the HTLC internals.
  const STEPS = [
    { key: 'deposit', label: 'Deposit ' + rec.from },
    { key: 'lock',    label: 'Lock your ' + rec.from + ' in the contract' },
    { key: 'maker',   label: 'Maker locks ' + rec.to },
    { key: 'confirm', label: 'Confirm the maker’s lock' },
    { key: 'receive', label: 'Receive your ' + rec.to },
  ];
  const stStep = {}; STEPS.forEach((s) => (stStep[s.key] = { state: 'pending', detail: null }));
  const setStep = (key, state, detail) => { stStep[key].state = state; if (detail !== undefined) stStep[key].detail = detail; };
  const advanceTo = (key) => { let hit = false; for (const s of STEPS) { if (s.key === key) { if (stStep[s.key].state !== 'done') stStep[s.key].state = 'active'; hit = true; } else if (!hit && stStep[s.key].state !== 'done') stStep[s.key].state = 'done'; } };
  const ico = (state) => el('span', { class: 'flow-step-ico' + (state === 'done' ? ' done' : state === 'active' ? ' active' : '') }, state === 'done' ? '✓' : state === 'active' ? '◐' : '○');

  // Re-derive the taker’s own HTLC-A contract from public params (for the internals panel).
  const takerContract = () => { try { if (rec.recovery && rec.recovery.makerRecvPubkey && rec.recovery.t1) return sc.takerContractParams({ secretHash: km.secretHash, makerRecvPubkey: unhx(rec.recovery.makerRecvPubkey), takerRefundPubkey: km.refundPub, t1: rec.recovery.t1, sendCoin: rec.from }); } catch {} return null; };
  const stamp = (ms) => new Date(ms).toLocaleTimeString();
  // Feature: per-step timeline (timestamps + step durations).
  const timeline = () => {
    const rows = []; let prev = meta.started || meta.times.deposit;
    for (const s of STEPS) { const t = meta.times[s.key]; if (!t) continue; rows.push(kvRow(s.label, stamp(t) + (prev && t > prev ? '  · +' + fmtElapsed(t - prev) : ''))); prev = t; }
    return rows.length ? el('div', { class: 'adv-sub' }, el('div', { class: 'adv-sub-h' }, 'Timeline'), ...rows) : null;
  };
  // Feature: the 4-leg atomic-swap flow, with this swap’s real amounts.
  const flowDiagram = () => {
    const legs = [
      ['You lock ' + fmt(rec.sendSats) + ' ' + rec.from + ' in HTLC-A', 'refundable to you after T1'],
      ['Maker locks ' + fmt(rec.recvSats) + ' ' + rec.to + ' in HTLC-B', 'refundable to the maker after T2 (T2 < T1)'],
      ['You claim HTLC-B (revealing secret S) and receive your ' + rec.to, 'this is the only place S becomes public'],
      ['Maker sees S on-chain, claims HTLC-A, receives your ' + rec.from, 'atomic: either both legs settle, or both refund'],
    ];
    return el('div', { class: 'adv-sub' }, el('div', { class: 'adv-sub-h' }, 'How this swap works (atomic, non-custodial)'),
      el('ol', { class: 'flowdiag' }, ...legs.map(([main, sub]) => el('li', {}, el('b', {}, main), el('div', { class: 'muted', style: 'font-size:12px' }, sub)))));
  };
  // Feature: full HTLC internals + a copyable raw-JSON view.
  const advPanel = () => {
    const tc = takerContract();
    const done = stStep.receive.state === 'done';
    const raw = { from: rec.from, to: rec.to, send_sats: rec.sendSats, recv_sats: rec.recvSats, recv_actual: rec.recvActual || undefined, hashlock: meta.hashlock, t1: (rec.recovery && rec.recovery.t1) || undefined, taker_contract: tc && tc.address, taker_fund_txid: meta.fundTxid || undefined, maker_contract: meta.makerAddr || undefined, maker_lock_txid: meta.makerTxid || undefined, redeem_txid: meta.redeemTxid || undefined };
    return el('details', { class: 'adv', style: 'margin-top:10px' },
      el('summary', {}, 'Advanced details'),
      el('div', { class: 'adv-body' },
        flowDiagram(),
        timeline(),
        el('div', { class: 'adv-sub' }, el('div', { class: 'adv-sub-h' }, 'HTLC internals'),
          kvRow('Protocol', 'HTLC · P2WSH · hashlock + CLTV timelock · atomic'),
          kvRow('Hashlock (H)', copyable(meta.hashlock)),
          (done && meta.secret) ? kvRow('Secret (S, now public)', copyable(meta.secret)) : null,
          (rec.recovery && rec.recovery.t1) ? kvRow('Your refund at (T1)', new Date(rec.recovery.t1 * 1000).toLocaleString()) : null,
          tc ? kvRow('Your contract (HTLC-A)', el('a', { class: 'mono', href: explorerAddr(rec.from, tc.address), target: '_blank', rel: 'noopener' }, tc.address)) : null,
          tc ? kvRow('Witness script', copyable(hx(tc.witnessScript))) : null,
          meta.makerAddr ? kvRow('Maker contract (HTLC-B)', el('a', { class: 'mono', href: explorerAddr(rec.to, meta.makerAddr), target: '_blank', rel: 'noopener' }, meta.makerAddr)) : null,
          kvRow('Your deposit', el('a', { class: 'mono', href: explorerAddr(rec.from, depositAddr), target: '_blank', rel: 'noopener' }, depositAddr)),
          meta.fundTxid ? kvRow('Your contract tx', txlink(rec.from, meta.fundTxid)) : null,
          meta.makerTxid ? kvRow('Maker lock tx', txlink(rec.to, meta.makerTxid)) : null,
          meta.redeemTxid ? kvRow('Your redeem tx', txlink(rec.to, meta.redeemTxid)) : null,
        ),
        el('details', { class: 'adv adv-raw' }, el('summary', {}, 'Raw (JSON)'), el('pre', { class: 'raw' }, JSON.stringify(raw, null, 2))),
      ),
    );
  };
  const renderTracker = () => {
    const done = STEPS.filter((s) => stStep[s.key].state === 'done').length;
    const anyActive = STEPS.some((s) => stStep[s.key].state === 'active');
    setFlow(
      el('div', { class: 'flow-head' },
        el('div', { class: 'card-sub', style: 'margin:0' }, fmt(rec.sendSats) + ' ' + rec.from + ' → ~' + fmt(rec.recvSats) + ' ' + rec.to),
        meta.started ? el('span', { class: 'muted mono flow-elapsed', style: 'font-size:12px' }, fmtElapsed(Date.now() - meta.started)) : null,
      ),
      el('div', { class: 'pbar' }, el('span', { style: 'width:' + Math.round((done / STEPS.length) * 100) + '%' })),
      el('div', { class: 'flow-steps' }, ...STEPS.map((s) => el('div', { class: 'flow-step ' + stStep[s.key].state },
        ico(stStep[s.key].state),
        el('div', { class: 'flow-step-main' }, el('div', { class: 'flow-step-label' }, s.label), stStep[s.key].detail ? el('div', { class: 'flow-step-detail' }, stStep[s.key].detail) : null),
      ))),
      advPanel(),
      anyActive ? el('div', { class: 'muted', style: 'font-size:13px;margin-top:8px' }, 'Runs in this tab. Keep it open until it finishes.') : null,
    );
  };
  const onStatus = (stage, detail, extra) => {
    const x = extra || {};
    if (stage === 'quoting' || stage === 'locking') advanceTo('lock');
    else if (stage === 'locked') { meta.fundTxid = x.txid || meta.fundTxid; meta.times.lock = Date.now(); setStep('lock', 'done', x.txid ? el('span', {}, 'Your ' + rec.from + ' contract: ', txlink(x.coin || rec.from, x.txid)) : null); advanceTo('maker'); }
    else if (stage === 'waiting') { advanceTo('maker'); setStep('maker', 'active', 'Waiting for the maker to lock its ' + rec.to + ' on-chain. Testnet blocks are irregular, so this can take a few minutes; nothing of yours is committed beyond your deposit.'); }
    else if (stage === 'maker_locked') { meta.makerTxid = x.txid || meta.makerTxid; meta.makerAddr = x.contract_addr || meta.makerAddr; meta.times.maker = Date.now(); setStep('maker', 'done', x.txid ? el('span', {}, 'Locked ' + rec.to + ': ', txlink(x.coin || rec.to, x.txid)) : null); advanceTo('confirm'); }
    else if (stage === 'confirming') setStep('confirm', 'active', el('span', {}, 'Waiting for confirmation' + (x.needed ? ' (' + (x.confirmations || 0) + '/' + x.needed + ')' : '') + (x.txid ? ' · ' : ''), x.txid ? txlink(x.coin || rec.to, x.txid) : null));
    else if (stage === 'redeeming') { meta.times.confirm = meta.times.confirm || Date.now(); setStep('confirm', 'done'); advanceTo('receive'); setStep('receive', 'active', x.txid ? el('span', {}, 'Redeem broadcast, waiting to confirm · ', txlink(x.coin || rec.to, x.txid)) : ('Claiming your ' + rec.to + ', revealing the secret…')); }
    else if (stage === 'done') { meta.redeemTxid = x.txid || meta.redeemTxid; meta.times.receive = Date.now(); setStep('receive', 'done', x.txid ? el('span', {}, 'Received: ', txlink(x.coin || rec.to, x.txid)) : null); }
    renderTracker();
  };

  try {
    // H-1: a record that already has recovery is FUNDED; never re-run/re-fund it
    // (that would re-quote a different contract and risk a double-deposit). The safe
    // path for a funded-but-unfinished swap is refund-after-T1.
    if (rec.recovery) { renderStalled(rec); return; }

    if (rec.stage === 'deposit') {
      const status = el('div', { class: 'swap-line wait', role: 'status', 'aria-live': 'polite' }, 'Waiting for your deposit…');
      const uri = payUri(rec.from, depositAddr, need);
      const qr = el('a', { class: 'qr', href: uri, title: 'Open in your ' + rec.from + ' wallet', 'aria-label': 'Deposit QR: tap to open in wallet' });
      qr.innerHTML = qrSvg(uri);
      // Cancel is ONLY safe BEFORE any coins reach the deposit address: dropping the record here
      // destroys the sole copy of the deposit key (km), which would strand any coins already sent.
      // So we disable it the instant the poll sees value, AND re-check UTXOs on click to catch a
      // just-broadcast mempool tx the poll hasn’t reported yet. Invariant: never drop km once coins arrive.
      let coinsSeen = false;
      const cancelBtn = el('button', { class: 'formbtn ghost', type: 'button', title: 'Cancel this swap (only before you send any coins)' }, 'Cancel');
      const lockCancel = () => { coinsSeen = true; cancelBtn.disabled = true; cancelBtn.textContent = 'Sent, can’t cancel'; cancelBtn.title = 'You’ve sent coins to this address; cancel is disabled to protect them'; };
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        let utxos = [];
        try { utxos = await chains[rec.from].getUtxos(depositAddr); } catch { cancelBtn.disabled = false; return; }
        if (coinsSeen || (utxos && utxos.length)) { // coins already at the address; keep the record, never lose the key
          lockCancel();
          status.className = 'swap-line'; status.textContent = 'Coins already sent here. Don’t cancel. The swap continues once it confirms, or you can refund after the deadline.';
          return;
        }
        rec._cancelled = true; drop(rec.id); setFlow(); state.busy = false; resetForm(); renderSwaps();
      });
      setStep('deposit', 'active', el('div', {},
        el('p', { class: 'muted', style: 'margin:.2em 0 .5em' }, 'Send ', el('b', {}, '≥ ' + fmt(need) + ' ' + rec.from), ' to this address. Only this browser controls it. Scan the QR, or ', el('a', { class: 'site_link', href: uri }, 'open it in your wallet'), '.'),
        el('p', { class: 'muted', style: 'margin:0 0 .7em;font-size:12.5px' }, 'Sending more than this, or across several transactions, is safe; anything above the amount returns to you as change.'),
        el('div', { class: 'deposit-grid' },
          qr,
          el('div', { class: 'deposit-side' },
            addressBox(rec.from, depositAddr),
            el('div', { class: 'kv', style: 'margin-top:8px' }, el('span', { class: 'muted' }, 'Amount'), copyable(fmt(need), fmt(need) + ' ' + rec.from)),
            el('div', { class: 'row', style: 'margin-top:10px;gap:8px' },
              el('a', { class: 'formbtn', href: uri, style: 'text-decoration:none;text-align:center' }, 'Open in wallet'),
              // Only offer the faucet when a single 0.01-coin claim actually covers the deposit; a fixed
              // faucet payout is useless (and misleading) against a swap that needs many claims' worth.
              need <= FAUCET_PAYOUT ? el('button', { class: 'formbtn ghost', type: 'button', onclick: (e) => faucet(e.target, rec.from, depositAddr) }, 'Fund from faucet') : null,
              cancelBtn,
            ),
          ),
        ),
        status,
      ));
      renderTracker();
      const funded = await chains[rec.from].waitForFunding(depositAddr, need, { onPoll: (i, total, pending, err) => {
        if (rec._cancelled) return;
        if ((total || pending) && !coinsSeen) lockCancel(); // coins detected -> cancel is no longer safe
        // Live heartbeat so a lagging/flaky explorer never reads as a frozen "waiting": show the poll
        // count, and distinguish confirmed-so-far / mempool-seen / explorer-unreachable / still-watching.
        const beat = ' · checked ' + (i + 1) + '×';
        if (total) status.textContent = 'Deposit seen: ' + fmt(total) + ' / ' + fmt(need) + ' ' + rec.from + ' confirmed. Continuing when the full amount confirms.';
        else if (pending) status.textContent = 'Deposit detected in the mempool (' + fmt(pending) + ' ' + rec.from + '). Waiting for 1 confirmation…' + beat;
        else if (err) status.textContent = 'The ' + rec.from + ' explorer is slow to respond right now; still watching your deposit address…' + beat;
        else status.textContent = 'Watching your deposit address for ≥ ' + fmt(need) + ' ' + rec.from + '…' + beat;
      } });
      if (rec._cancelled) return; // user cancelled before any coins were sent
      meta.times.deposit = Date.now();
      setStep('deposit', 'done', el('span', {}, 'Deposited ' + fmt(funded.total) + ' ' + rec.from + ((funded.utxos && funded.utxos[0]) ? ' · ' : ''), (funded.utxos && funded.utxos[0]) ? txlink(rec.from, funded.utxos[0].txid) : null));
      rec.stage = 'swapping'; put(rec);
    }

    advanceTo('lock');
    meta.started = Date.now();
    tick = setInterval(() => { const t = flow.querySelector('.flow-elapsed'); if (t) t.textContent = fmtElapsed(Date.now() - meta.started); }, 1000); // tick ONLY the elapsed label; a full renderTracker() (fired on real status changes) would wipe the user’s open Advanced/Raw panels
    renderTracker();
    const relay = await connectRelay(relayUrl());
    try {
      const res = await runHtlcTaker({
        sc, transport: relay, chains, km,
        params: {
          from: rec.from, to: rec.to, sendSats: rec.sendSats, minConf: MIN_CONF, feeRate: 2,
          recvAddr: rec.dest, minRecvSats: rec.recvSats, onStatus, setupTimeoutMs: 60000, lockTimeoutMs: 3_600_000,
          // H-1/M-2: persist the COMPLETE recovery blob (awaited) BEFORE the funding
          // broadcast; if this save fails, the swap aborts before any coins move.
          onAfterFund: async (recovery) => { rec.recovery = recovery; rec.stage = 'swapping'; put(rec); },
        },
      });
      const previewed = rec.recvSats;
      if (res.confirmed === false) {
        // #1: the redeem was broadcast (secret is now public) but never confirmed inside the safe window - a
        // stalled receive chain. Do NOT declare "complete" or wipe keys: keep the recovery + redeem txid so the
        // user can keep the tab open and monitor. Post-reveal the T1 refund is UNSAFE (the maker could claim it
        // with the public secret), so renderStalled is bypassed via its redeemTxid guard. Reuse the existing
        // 'swapping' stage so the resume path treats it as in-progress (a re-render lands on renderRedeemPending).
        rec.stage = 'swapping'; rec.redeemTxid = res.redeemTxid; rec.recvActual = res.recvSats;
        put(rec);
        renderRedeemPending(rec);
      } else {
        rec.stage = 'done'; rec.redeemTxid = res.redeemTxid; rec.recvActual = res.recvSats;
        wipeKeys(rec); // L-4: swap complete; wipe the (now-dead) ephemeral keys; keep a key-free receipt (history + shareable status link)
        put(rec);
        renderDone(rec, previewed, res.recvSats);
      }
    } finally { try { relay.close(); } catch {} }
  } catch (e) {
    if (rec._cancelled) return; // F2: swap was cancelled + record dropped; don’t resurrect it via put()
    // M2: a broadcast that never landed leaves the persisted recovery void; the deposit is
    // untouched, so clear it and treat as a pre-fund retry (not a stranded "funded" swap).
    if (e && e.notFunded) { rec.recovery = undefined; rec.stage = 'deposit'; put(rec); renderRetry(rec, e.message || String(e)); }
    else if (rec.recovery) { rec.stage = 'stalled'; put(rec); renderStalled(rec); } // funded → refundable at T1
    else { rec.stage = 'deposit'; put(rec); renderRetry(rec, e.message || String(e)); } // pre-fund: deposit untouched
  } finally { if (tick) clearInterval(tick); if (!rec._cancelled) { state.busy = false; resetForm(); renderSwaps(); } } // F2: after cancel, don’t clobber a newer swap’s state

  function renderDone(r, previewed, actual) {
    const short = actual < previewed;
    setFlow(
      el('div', { class: 'receipt' },
        el('div', { class: 'receipt-head' },
          el('span', { class: 'receipt-ico' }, '✓'),
          el('div', {}, el('div', { class: 'card-sub', style: 'margin:0' }, 'Swap complete'), el('div', { class: 'muted', style: 'font-size:13px' }, 'You received ' + fmt(actual) + ' ' + r.to)),
        ),
        el('div', { class: 'quote-detail', style: 'margin-top:12px' },
          kvRow('Sent', fmt(r.sendSats) + ' ' + r.from),
          kvRow('Quoted', fmt(previewed) + ' ' + r.to),
          short ? kvRow('Claim network fee', '−' + fmt(previewed - actual) + ' ' + r.to) : null,
          kvRow('Net received', el('b', { class: 'pos' }, fmt(actual) + ' ' + r.to)),
          meta.started ? kvRow('Duration', fmtElapsed(Date.now() - meta.started)) : null,
          kvRow('Received tx', txlink(r.to, r.redeemTxid)),
          meta.fundTxid ? kvRow('Your lock tx', txlink(r.from, meta.fundTxid)) : null,
          meta.makerTxid ? kvRow('Maker lock tx', txlink(r.to, meta.makerTxid)) : null,
        ),
        el('div', { class: 'row', style: 'margin-top:12px;gap:8px' },
          el('button', { class: 'formbtn', type: 'button', onclick: () => { setFlow(); resetForm(); try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {} } }, 'Swap again'),
          canShare(r) ? el('button', { class: 'formbtn ghost', type: 'button', onclick: (e) => copyLink(e.target, r) }, 'Copy status link') : null,
        ),
      ),
    );
  }
  function renderRedeemPending(r) {
    setFlow(el('div', { class: 'msg warn' },
      el('div', {}, 'Your ' + r.to + ' redeem is broadcast but has not confirmed yet (the ' + r.to + ' chain is slow right now). Keep this tab open; it settles on its own once a block arrives.'),
      r.redeemTxid ? el('div', { class: 'row', style: 'margin-top:8px' }, el('span', { class: 'muted', style: 'font-size:13px;margin-right:6px' }, 'Redeem tx:'), txlink(r.to, r.redeemTxid)) : null,
    ));
  }
  function renderStalled(r) {
    if (r.redeemTxid) return renderRedeemPending(r); // secret already public (redeem broadcast): the T1 refund is now unsafe, so never offer it - monitor the redeem instead
    const now = Math.floor(Date.now() / 1000); const t1 = (r.recovery && r.recovery.t1) || 0;
    const canRefund = Number.isFinite(t1) && t1 > 0 && now >= t1; // L6: a missing/zero t1 is NOT "refund now"
    setFlow(el('div', { class: 'msg warn' },
      el('div', {}, 'This swap didn’t complete. Your ' + r.from + ' is locked in a contract only you can refund' + (canRefund ? ' now.' : ' after ' + new Date(t1 * 1000).toLocaleString() + '.')),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'formbtn', type: 'button', disabled: !canRefund, onclick: (e) => doRefund(e.target, r) }, canRefund ? 'Refund my ' + r.from : 'Refund available later')),
    ));
  }
  function renderRetry(r, why) {
    setFlow(el('div', { class: 'msg bad' },
      el('div', {}, 'Swap didn’t start: ' + why),
      el('p', { class: 'muted', style: 'font-size:13px;margin:.4em 0' }, 'No coins moved. Your deposit (if any) is untouched at the address only this browser controls. Retry when the maker is back.'),
      el('div', { class: 'row', style: 'margin-top:6px;gap:8px' }, el('button', { class: 'formbtn', type: 'button', onclick: () => runRecord(r) }, 'Retry swap')),
    ));
  }
}

async function doRefund(btn, rec) {
  btn.disabled = true; btn.textContent = 'Refunding…';
  try {
    const r = await refundHtlc({ sc, chains, recovery: rec.recovery, destAddress: rec.recovery.fundAddr });
    rec.stage = 'refunded'; rec.refundTxid = r.refundTxid; wipeKeys(rec); put(rec); // keep a key-free receipt; the refund key is now spent/dead
    $('flow').replaceChildren(el('div', { class: 'msg ok' }, el('div', {}, '✓ Refunded your ' + rec.from + '.'), el('a', { class: 'mono-link', href: explorerTx(rec.from, r.refundTxid), target: '_blank', rel: 'noopener' }, r.refundTxid)));
    renderSwaps();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Refund my ' + rec.from;
    // In-UI error next to the button (not a blocking alert). The refund is idempotent, so retrying is safe.
    const err = el('div', { class: 'msg bad refund-err', style: 'margin-top:8px' }, 'Refund failed (safe to retry): ' + (e.message || e));
    const host = btn.parentNode;
    if (host) { const prev = host.querySelector('.refund-err'); if (prev) prev.replaceWith(err); else host.appendChild(err); }
  }
}

async function faucet(btn, coin, address) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Requesting…';
  try {
    const r = await fetch(FAUCET + '/api/v1/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network: FAUCET_SLUG[coin], address }) });
    btn.textContent = r.ok ? 'Faucet sent, waiting…' : 'Faucet busy, try later';
  } catch { btn.textContent = 'Faucet unreachable'; }
  finally { setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 4000); }
}

function addressBox(coin, addr) {
  const b = el('button', { class: 'copy', type: 'button', onclick: () => { if (b.dataset.copied) return; b.dataset.copied = '1'; navigator.clipboard && navigator.clipboard.writeText(addr); const o = b.textContent; b.textContent = '✓'; setTimeout(() => { b.textContent = o; delete b.dataset.copied; }, 1100); } }, 'copy');
  const box = el('div', { class: 'addrbox' },
    el('span', { class: 'mono', id: 'dep-addr' }, addr),
    b,
  );
  return el('div', {}, box, el('a', { class: 'muted', style: 'font-size:12px', href: explorerAddr(coin, addr), target: '_blank', rel: 'noopener' }, 'view on explorer ↗'));
}

/* -------------------------------------------------- keys / shareable status link */
// The PUBLIC, key-FREE subset of the recovery blob. NEVER includes refundPrivHex or the
// secret; only on-chain-public identifiers + the hashlock (a public hash). This is all a
// read-only status link is allowed to carry.
const PUB_RECOVERY = ['kind', 'from', 'to', 'sendSats', 'recvSats', 't1', 'secretHash', 'makerRecvPubkey', 'fundTxid', 'fundVout', 'fundAddr'];
function pubRecovery(rv) { const o = {}; for (const k of PUB_RECOVERY) if (rv && rv[k] !== undefined) o[k] = rv[k]; return o; }
// Once a swap is settled (done/refunded), drop ALL spend authority: wipe km entirely and
// strip the refund key from recovery; keeping only the key-free receipt/status fields.
function wipeKeys(rec) { rec.km = undefined; if (rec.recovery) rec.recovery = pubRecovery(rec.recovery); }

// A read-only status blob: public identifiers only, enough to derive on-chain status.
function statusBlob(rec) {
  const rv = rec.recovery || {};
  return { v: 1, from: rec.from, to: rec.to, sendSats: rec.sendSats, recvSats: rec.recvSats, recvActual: rec.recvActual, ts: rec.ts,
    t1: rv.t1, secretHash: rv.secretHash, fundTxid: rv.fundTxid, fundVout: rv.fundVout, fundAddr: rv.fundAddr || rec.depositAddr,
    redeemTxid: rec.redeemTxid, refundTxid: rec.refundTxid };
    // NOTE: `dest` (the payout address) is deliberately NOT shared; the viewer never uses it,
    // and it would let a link holder link the swap to the recipient address.
}
// Shareable only once there’s something on-chain to look at (funded contract, or a finished swap).
function canShare(rec) { return !!(rec.recovery && rec.recovery.fundTxid) || !!rec.redeemTxid || !!rec.refundTxid; }
function b64u(s) { return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s); }
function statusHash(rec) { return '#s=' + b64u(JSON.stringify(statusBlob(rec))); }
function statusUrl(rec) { return location.origin + location.pathname + statusHash(rec); }
function readStatusFragment() {
  const h = location.hash || '';
  if (h.slice(0, 3) !== '#s=') return null;
  const coins = ['tBTC', 'tLTC'];
  try { const b = JSON.parse(unb64u(h.slice(3))); return (b && b.v === 1 && coins.includes(b.from) && coins.includes(b.to)) ? b : null; } catch { return null; }
}
async function copyLink(btn, rec) {
  const url = statusUrl(rec); const o = btn.textContent;
  try { await navigator.clipboard.writeText(url); btn.textContent = '✓ copied'; } catch { prompt('Copy this status link:', url); }
  setTimeout(() => (btn.textContent = o), 1400);
}

/* -------------------------------------------------- my swaps (history + actionable) */
function swapLabel(rec) {
  if (rec.stage === 'done') return { text: 'Completed', cls: 'dot-ok' };
  if (rec.stage === 'refunded') return { text: 'Refunded', cls: 'dot-warn' };
  const funded = !!(rec.recovery && rec.recovery.fundTxid);
  if (!funded) return { text: 'Awaiting deposit', cls: 'dot-off' };
  const now = Math.floor(Date.now() / 1000); const t1 = rec.recovery.t1 || 0;
  return (t1 && now >= t1) ? { text: 'Stalled, refundable', cls: 'dot-warn' } : { text: 'Locked', cls: 'dot-off' };
}
// Number of swaps shown before older/terminal ones fold under a "Show N older" button.
const SWAPS_VISIBLE_CAP = 4;
function swapCard(r) {
  const now = Math.floor(Date.now() / 1000);
  const settled = r.stage === 'done' || r.stage === 'refunded';
  const funded = !funded_settled(r) && !!(r.recovery && r.recovery.fundTxid);
  const t1 = funded ? (r.recovery.t1 || 0) : 0;
  const canRefund = funded && Number.isFinite(t1) && t1 > 0 && now >= t1; // L6
  const lbl = swapLabel(r);
  const actions = [];
  if (!settled && !funded) actions.push(el('button', { class: 'formbtn', type: 'button', onclick: () => runRecord(r) }, 'Continue'));
  if (funded) actions.push(el('button', { class: 'formbtn', type: 'button', disabled: !canRefund, onclick: (e) => doRefund(e.target, r) }, canRefund ? 'Refund my ' + r.from : 'Refund at ' + new Date(t1 * 1000).toLocaleString()));
  if (funded) actions.push(el('button', { class: 'formbtn ghost', type: 'button', title: 'Download a backup file to refund this swap from another device or after clearing your browser', onclick: () => backupHtlc(r) }, 'Backup'));
  if (canShare(r)) {
    actions.push(el('button', { class: 'formbtn ghost', type: 'button', onclick: () => { history.replaceState(null, '', statusHash(r)); renderStatusView(statusBlob(r)); } }, 'View status'));
    actions.push(el('button', { class: 'formbtn ghost', type: 'button', title: 'Anyone with this link can see this swap’s addresses, amounts and times, but cannot move funds.', onclick: (e) => copyLink(e.target, r) }, 'Copy status link'));
  }
  actions.push(el('button', { class: 'formbtn ghost', type: 'button', onclick: () => {
    // A NON-settled record still holds spend authority (km / refund key) in this browser -
    // deleting it is irreversible and can strand any coins already at the deposit/contract.
    // Gate the scary warning on that, NOT on `funded` (a deposit-stage record has km too).
    const msg = settled
      ? 'Remove this swap from history?'
      : 'Forget this swap? Only do this once any funds at the deposit address / contract are recovered. The private key, held only by this browser, will be permanently deleted and cannot be restored.';
    if (confirm(msg)) { drop(r.id); renderSwaps(); }
  } }, settled ? 'Remove' : 'Forget'));
  const settledTx = r.stage === 'done' ? { c: r.to, id: r.redeemTxid, label: 'Received in' } : r.stage === 'refunded' ? { c: r.from, id: r.refundTxid, label: 'Refunded in' } : null;
  return el('div', { class: 'card' },
    el('div', { class: 'card-header' }, fmt(r.sendSats) + ' ' + r.from + ' → ' + r.to, el('span', { class: 'badge swap-badge' }, el('span', { class: 'dot ' + lbl.cls }, '●'), ' ' + lbl.text)),
    el('div', { class: 'card-body' },
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Started'), el('span', {}, new Date(r.ts).toLocaleString())),
      r.depositAddr ? el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Deposit address'), el('a', { class: 'mono', style: 'font-size:12px', href: explorerAddr(r.from, r.depositAddr), target: '_blank', rel: 'noopener' }, r.depositAddr.slice(0, 16) + '…')) : null,
      (settledTx && settledTx.id) ? el('div', { class: 'kv' }, el('span', { class: 'muted' }, settledTx.label), el('a', { class: 'mono', style: 'font-size:12px', href: explorerTx(settledTx.c, settledTx.id), target: '_blank', rel: 'noopener' }, settledTx.id.slice(0, 16) + '…')) : null,
      funded ? el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:4px' }, 'Your ' + r.from + ' is locked in a contract only you can refund after the deadline. (Resuming a mid-flight swap isn’t supported yet. The safe path is to refund.)') : null,
      el('div', { class: 'row', style: 'margin-top:10px;gap:8px' }, ...actions),
    ),
  );
}
// A Monero (adaptor) swap persists as a SINGLE recovery blob (not the HTLC record array), so it was
// never in this list. Surface it here too, as a compact card whose action opens the full Finish/Reclaim
// flow (renderRecovery); so both swap types live under "My swaps".
function xmrSwapCard(r) {
  const fromCoin = r.moneroNetwork === 'stagenet' ? 'sXMR' : 'tXMR';
  const toCoin = r.toCoin || 'tBTC';
  const amt = (r.sendPico != null) ? xmrswap.fmtXmr(r.sendPico) : '?';
  // Never let this card replace a LIVE swap's flow with a reclaim/finish UI (that would start a
  // concurrent reclaim and abort the running swap). Guarded here and by the render gate in renderSwaps.
  const open = () => { if (state.busy) return; xmrswap.renderRecovery($('flow'), showMsg); try { $('flow').scrollIntoView({ behavior: 'smooth' }); } catch {} };
  return el('div', { class: 'card' },
    el('div', { class: 'card-header' }, amt + ' ' + fromCoin + ' → ' + toCoin,
      el('span', { class: 'badge swap-badge' }, el('span', { class: 'dot dot-warn' }, '●'), ' Unfinished, recoverable')),
    el('div', { class: 'card-body' },
      r.at ? el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Started'), el('span', {}, new Date(r.at * 1000).toLocaleString())) : null,
      (r.lockOutpoint && r.lockOutpoint.txid) ? el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Your ' + fromCoin + ' lock'), el('span', { class: 'mono', style: 'font-size:12px' }, String(r.lockOutpoint.txid).slice(0, 16) + '…')) : null,
      el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:4px' }, 'A Monero swap that did not finish in this browser. Finish it to receive your ' + toCoin + ', or reclaim your ' + fromCoin + '.'),
      el('div', { class: 'row', style: 'margin-top:10px;gap:8px' },
        el('button', { class: 'formbtn', type: 'button', onclick: open }, 'Finish or reclaim')),
    ),
  );
}
function renderSwaps() {
  const host = $('recovery');
  const recs = load().slice().sort((a, b) => b.ts - a.ts);
  const xr = xmrswap.hasRecovery() ? xmrswap.getRecovery() : null;
  const hasXmr = !!(xr && xr.lockOutpoint);
  // Keep a background re-render running while any funded-but-unsettled swap exists, so a 'Locked'
  // swap that crosses its T1 timelock while the tab sits idle flips to an enabled 'Refund' on its
  // own. Clear it once none remain so the interval never stacks.
  const needTimer = recs.some((r) => r.recovery && r.recovery.fundTxid && r.stage !== 'done' && r.stage !== 'refunded');
  // The TIMED re-render is guarded: skip it while the user is focused inside the list or a refund
  // error is showing, so the periodic refresh never steals focus, collapses "Show older", or wipes
  // an in-place error. Direct renderSwaps() calls (on real swap events) still render unconditionally.
  if (needTimer && !refundTimer) refundTimer = setInterval(() => { const h = $('recovery'); if (h && !h.contains(document.activeElement) && !h.querySelector('.refund-err')) renderSwaps(); }, 30000);
  else if (!needTimer && refundTimer) { clearInterval(refundTimer); refundTimer = null; }
  if (!recs.length && !hasXmr) { host.replaceChildren(); return; }
  // Actionable/in-flight swaps first (awaiting deposit, locked, stalled-refundable); always
  // shown and expanded; settled/terminal ones (completed/refunded) fill the rest up to a cap,
  // with any remainder folded under a "Show N older" toggle.
  const active = recs.filter((r) => !funded_settled(r));
  const terminal = recs.filter((r) => funded_settled(r));
  const shownTerminal = terminal.slice(0, Math.max(0, SWAPS_VISIBLE_CAP - active.length));
  const hidden = terminal.slice(shownTerminal.length);
  const nodes = [el('div', { class: 'card-sub', style: 'margin:2px 2px 8px' }, 'My swaps')];
  if (hasXmr && !state.busy) nodes.push(xmrSwapCard(xr)); // the (single) in-flight Monero swap; but NOT while one is live in the flow (it's already shown there; a card action would clobber it)
  for (const r of active) nodes.push(swapCard(r));
  for (const r of shownTerminal) nodes.push(swapCard(r));
  if (hidden.length) {
    const older = el('div', { class: 'swaps-older', style: 'display:none' }, ...hidden.map(swapCard));
    const btn = el('button', { class: 'formbtn ghost swaps-older-toggle', type: 'button' }, 'Show ' + hidden.length + ' older');
    btn.addEventListener('click', () => { older.style.display = ''; btn.remove(); });
    nodes.push(btn, older);
  }
  host.replaceChildren(...nodes);
}
// A funded-but-unsettled record is refund-only; a settled one is history.
function funded_settled(r) { return r.stage === 'done' || r.stage === 'refunded'; }

/* -------------------------------------------------- read-only status viewer (Tier 2) */
// True iff any witness item is the preimage of secretHash; i.e. the spender revealed the
// secret (a maker claiming the taker’s contract), which distinguishes a successful swap
// from a refund. Uses only the PUBLIC secretHash; no keys involved.
function secretRevealed(witness, secretHashHex) {
  if (!Array.isArray(witness) || !secretHashHex) return false;
  for (const w of witness) { try { if (hx(sc.sha256(unhx(w))) === secretHashHex) return true; } catch {} }
  return false;
}
// Read-only fetch straight from the independent explorer (same origins as `chains`, already
// in CSP). We use it for the AUTHORITATIVE outspend flag: chains.getSpend drops `spent:true`
// when it can’t also fetch the witness, which would mislabel a settled swap as still 'locked'.
async function rawGet(coin, path) {
  const base = ESPLORA[coin]; if (!base) throw new Error('unknown coin');
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);   // fail fast on a slow explorer
  try {
    const r = await fetch(base + path, { signal: ac.signal }); const t = await r.text();
    if (!r.ok) throw new Error('GET ' + path + ': ' + r.status);
    try { return JSON.parse(t); } catch { return t; }
  } finally { clearTimeout(to); }
}
async function deriveStatus(b) {
  const fromChain = chains[b.from];
  const now = Math.floor(Date.now() / 1000);
  if (b.refundTxid) return { state: 'refunded', txc: b.from, txid: b.refundTxid };
  if (b.redeemTxid) return { state: 'completed', txc: b.to, txid: b.redeemTxid };
  if (!b.fundTxid || b.fundVout == null || !fromChain) return { state: 'pending' };
  let os; try { os = await rawGet(b.from, '/tx/' + encodeURIComponent(b.fundTxid) + '/outspend/' + Number(b.fundVout)); } catch (e) { return { state: 'error', why: e.message || String(e) }; }
  if (os && os.spent) {
    // A spend is on-chain; but wait for it to confirm before a terminal verdict (a 0-conf
    // spend can be RBF’d/dropped).
    if (!(os.status && os.status.confirmed)) return { state: 'settling', txc: b.from, txid: os.txid };
    let spender = null; try { spender = await rawGet(b.from, '/tx/' + encodeURIComponent(os.txid)); } catch {}
    // A refund pays back to fundAddr; a maker claiming the taker’s contract reveals the secret
    // (witness preimage of secretHash) and pays elsewhere. Prefer the witness signal; fall back
    // to the payout-address heuristic when the witness isn’t readable.
    const revealed = !!(spender && Array.isArray(spender.vin) && spender.vin.some((v) => v.txid === b.fundTxid && Number(v.vout) === Number(b.fundVout) && secretRevealed(v.witness, b.secretHash)));
    const paysFund = !!(spender && Array.isArray(spender.vout) && b.fundAddr && spender.vout.some((o) => o.scriptpubkey_address === b.fundAddr));
    if (revealed) return { state: 'completed', txc: b.from, txid: os.txid };
    if (paysFund) return { state: 'refunded', txc: b.from, txid: os.txid };
    return { state: 'completed', txc: b.from, txid: os.txid }; // spent, not back to you → the maker claimed it
  }
  let out = null; try { out = await fromChain.getOutput(b.fundTxid, b.fundVout); } catch {}
  if (out && out.value > 0) return (b.t1 && now >= b.t1) ? { state: 'refundable' } : { state: 'locked', confirmations: out.confirmations };
  return { state: 'pending' };
}
const STATUS_UI = {
  completed:  { cls: 'ok',   txt: (b) => { const got = b.recvActual != null ? b.recvActual : b.recvSats; const note = (b.recvActual != null && b.recvSats != null && b.recvActual < b.recvSats) ? ' (' + fmt(b.recvSats) + ' quoted − network fee)' : ''; return '✓ Completed. You received ' + fmt(got) + ' ' + b.to + '.' + note; } },
  refunded:   { cls: 'warn', txt: (b) => '↩ Refunded. Your ' + b.from + ' deposit was returned.' },
  locked:     { cls: '',     txt: (b, s) => '● In progress. Your ' + b.from + ' is locked in the contract, awaiting completion.' + (s.confirmations ? ' (' + s.confirmations + ' conf)' : '') },
  settling:   { cls: '',     txt: () => '● Settling. A transaction is in the mempool; waiting for it to confirm.' },
  refundable: { cls: 'warn', txt: (b) => '● Stalled. This swap didn’t complete. The ' + b.from + ' is refundable now, but only from the browser that created it.' },
  pending:    { cls: '',     txt: () => '… Waiting. The contract isn’t visible on-chain yet.' },
  error:      { cls: 'bad',  txt: (b, s) => 'Couldn’t reach the explorer to check status' + (s.why ? ' (' + s.why + ')' : '') + '. Try Refresh status.' },
};
function renderStatusView(b) {
  let card = $('status-view');
  if (!card) {
    card = el('div', { class: 'card', id: 'status-view' });
    const main = $('main'); const hero = main.querySelector('.hero');
    main.insertBefore(card, hero ? hero.nextSibling : main.firstChild);
  }
  const body = el('div', { class: 'card-body' });
  const render = (s) => {
    const ui = STATUS_UI[s.state] || STATUS_UI.pending;
    body.replaceChildren(
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Swap'), el('span', {}, fmt(b.sendSats) + ' ' + b.from + ' → ' + fmt(b.recvSats) + ' ' + b.to)),
      b.ts ? el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Started'), el('span', {}, new Date(b.ts).toLocaleString())) : null,
      (typeof b.fundAddr === 'string' && b.fundAddr) ? el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Your deposit'), el('a', { class: 'mono', style: 'font-size:12px', href: explorerAddr(b.from, b.fundAddr), target: '_blank', rel: 'noopener' }, b.fundAddr.slice(0, 18) + '…')) : null,
      el('div', { class: 'msg ' + ui.cls, style: 'margin-top:10px' },
        el('div', {}, ui.txt(b, s)),
        s.txid ? el('a', { class: 'mono-link', href: explorerTx(s.txc, s.txid), target: '_blank', rel: 'noopener' }, s.txid) : null,
      ),
      el('div', { class: 'row', style: 'margin-top:10px;gap:8px' },
        el('button', { class: 'formbtn ghost', type: 'button', onclick: (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; go(); } }, 'Refresh status'),
        el('button', { class: 'formbtn ghost', type: 'button', onclick: () => { history.replaceState(null, '', location.pathname + location.search); card.remove(); } }, 'Start a new swap'),
      ),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'Read-only status. Your keys never left the browser that created this swap. Any refund/action happens there. Anyone with this link can see the swap’s addresses, amounts and times (but cannot move funds).'),
    );
  };
  const go = async () => { render(await deriveStatus(b)); };
  card.replaceChildren(el('div', { class: 'card-header' }, 'Swap status'), body);
  body.replaceChildren(el('div', { class: 'muted' }, 'Checking on-chain…'));
  go();
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* -------------------------------------------------- form wiring */
// Valid receive coins for the chosen send coin: XMR settles to the maker’s advertised coins
// (tBTC always, tLTC when offered); the HTLC pair is strictly the other of tLTC/tBTC.
function receiveTargets() { return isXmrFrom() ? xmrSettle : (state.from === 'tLTC' ? ['tBTC'] : ['tLTC']); }
// Rebuild #to-sel’s options from the valid targets, but only when the target set actually
// changes (a needless replaceChildren() would clobber the user’s pick / close the dropdown).
// If state.to is no longer valid, snap it to the first target.
function populateReceive() {
  const sel = $('to-sel'); if (!sel) return;
  const targets = receiveTargets();
  if (!targets.includes(state.to)) state.to = targets[0];
  const cur = Array.from(sel.options).map((o) => o.value).join(',');
  if (cur !== targets.join(',')) sel.replaceChildren(...targets.map((c) => new Option(c, c)));
  sel.value = state.to;
}
// Map the selected coin to its round icon and point the dropdown’s leading <img> at it, so the icon
// tracks the pick (tXMR/sXMR share the Monero icon). Called from syncLegs on every change.
const COIN_ICO = { tBTC: 'btc', tLTC: 'ltc', tXMR: 'xmr', sXMR: 'xmr' };
function setIco(imgId, coin) { const img = $(imgId), file = COIN_ICO[coin]; if (img && file) img.src = '/assets/coins/' + file + '.svg'; }
function syncLegs() {
  const sel = $('from-sel'); if (sel) sel.value = state.from;
  populateReceive();
  const ts = $('to-sel'); if (ts) ts.value = state.to;
  setIco('from-ico', state.from);
  setIco('to-ico', state.to);
  $('dest-coin').textContent = state.to;
  const d = $('dest'); if (d) d.placeholder = 'Paste your ' + state.to + ' address';
  setXmrMode(isXmrFrom());
}
function setXmrMode(on) {
  const fl = document.querySelector('.flip'); if (fl) fl.style.display = on ? 'none' : '';
  // XMR is one-way (no HTLC pair to flip); the #to-sel dropdown now handles switching the settle coin.
  const flipBtn = $('flip'); if (flipBtn) flipBtn.disabled = on;
  const leg = $('xmr-refund-leg'); if (leg) leg.style.display = on ? '' : 'none';
  // Hide #minmax too: doXmrQuote never repopulates it, so a stale 'X to Y tLTC' from a prior HTLC
  // pair would otherwise linger on a tXMR swap. Un-hides (with fee/floor/expiry) back in HTLC mode.
  ['minmax', 'fee', 'floor', 'quote-expiry'].forEach((id) => { const e = $(id); const kv = e && e.closest && e.closest('.kv'); if (kv) kv.style.display = on ? 'none' : ''; });
  const adv = document.querySelector('details.adv'); if (adv) adv.style.display = on ? 'none' : '';
}
function onFromChange() {
  state.from = $('from-sel').value; state.quote = null;
  populateReceive(); // re-derive the valid receive coin(s) for the new send coin (snaps state.to if needed)
  syncLegs(); scheduleQuote();
}
function onToChange() {
  state.to = $('to-sel').value; state.quote = null; deepTo = null; // a manual pick overrides any remembered deep-link
  syncLegs(); scheduleQuote();
}
function resetForm() { $('amount').disabled = $('dest').disabled = $('flip').disabled = false; ['maker-sel', 'from-sel', 'to-sel', 'xmr-refund'].forEach((id) => { if ($(id)) $(id).disabled = false; }); $('start-btn').disabled = !state.quote; $('start-btn').textContent = state.quote ? 'Start swap' : 'Get a quote'; }
function flip() { if (isXmrFrom()) return; const f = state.from; state.from = state.to; state.to = f; syncLegs(); scheduleQuote(); } // HTLC-only: XMR is one-way

// Deep-link prefill (e.g. TestnetWallet’s "Swap" button just links here). All params optional:
//   ?from=tLTC|tBTC|tXMR|sXMR  coin you send (XMR -> tBTC, or tLTC if the maker offers it; tLTC<->tBTC otherwise)
//   ?to=tBTC|tLTC              receive coin for the HTLC pair (derived from `from` if omitted)
//   ?amount=<number>          prefills the send amount
//   ?dest=<address>           prefills the receive address (only if it validates for the receive coin)
//   ?refund=<monero address>  prefills the tXMR refund address for a Monero swap (validated)
//   ?maker=<id>               handled separately in loadRoster()
// Every value is validated before use and only ever assigned to an input .value (never HTML), so a
// malformed/hostile param is simply ignored; no injection, no bad state.
function applyQuery() {
  const p = new URLSearchParams(location.search);
  const f = p.get('from'), t = p.get('to'), a = p.get('amount');
  const dest = (p.get('dest') || '').trim(), refund = (p.get('refund') || '').trim();
  const validTo = ['tBTC', 'tLTC'];
  if (f === 'tXMR' || f === 'sXMR') { state.from = f; state.to = validTo.includes(t) ? t : 'tBTC'; deepTo = validTo.includes(t) ? t : null; } // deepTo: applyXmrCaps re-applies `t` once the maker offers it (status loads after this runs)
  else if (f === 'tLTC' || f === 'tBTC') { state.from = f; state.to = (validTo.includes(t) && t !== f) ? t : (f === 'tLTC' ? 'tBTC' : 'tLTC'); }
  if (a && parseFloat(a) > 0) $('amount').value = a;
  if (dest && validAddr(state.to, dest)) { const d = $('dest'); if (d) d.value = dest; }
  if (refund && isXmrFrom() && $('xmr-refund') && xmrswap.isXmrAddr(refund, state.from)) $('xmr-refund').value = refund;
}

document.addEventListener('DOMContentLoaded', () => {
  const shared = readStatusFragment();           // a bookmarked/shared read-only status link
  if (shared) renderStatusView(shared);
  applyQuery();
  if (xmrswap.hasRecovery()) { const r = xmrswap.getRecovery(); state.from = (r && r.moneroNetwork === 'stagenet') ? 'sXMR' : 'tXMR'; state.to = 'tBTC'; } // surface an unfinished XMR swap
  syncLegs();
  $('amount').addEventListener('input', scheduleQuote);
  $('flip').addEventListener('click', flip);
  if ($('from-sel')) $('from-sel').addEventListener('change', onFromChange);
  if ($('to-sel')) $('to-sel').addEventListener('change', onToChange);
  if ($('maker-sel')) $('maker-sel').addEventListener('change', onMakerChange);
  $('start-btn').addEventListener('click', startSwap);
  const rf = $('restore-file'), rb = $('restore-btn');
  if (rb && rf) { rb.addEventListener('click', () => rf.click()); rf.addEventListener('change', () => { if (rf.files && rf.files[0]) restoreFromFile(rf.files[0]); rf.value = ''; }); }
  loadStatus(); loadRoster(); scheduleQuote(); renderSwaps(); // an unfinished Monero swap now surfaces as a card in My swaps (renderSwaps), not auto-opened in the flow
  window.addEventListener('testnetswap:xmr-recovery-changed', () => renderSwaps()); // keep the Monero card in sync when it's saved/cleared/finished
  window.addEventListener('testnetswap:swap-again', () => { state.busy = false; $('flow').replaceChildren(); resetForm(); renderSwaps(); try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {} }); // XMR "Swap again": unlock the form + clear the completed flow
  setInterval(loadStatus, 30000); setInterval(loadRoster, 30000);
});
