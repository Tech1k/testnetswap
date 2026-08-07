// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * tXMR -> tBTC atomic swap, folded into the unified swap widget (taker = Alice).
 * swap.js delegates here when the "from" coin is tXMR. Non-custodial: fresh ephemeral
 * keys in this tab; the user deposits tXMR straight to the combined 2-of-2 lock address
 * (that IS tx_lock) and receives tBTC at their own address. Recovery is persisted BEFORE
 * the lock, so a maker stall is always reclaimable. All swap crypto is the audited
 * swap-xmr toolkit (vendored, byte-identical); the ~7 MB Monero engine loads lazily.
 *
 * Exposes: preview(), run(), hasRecovery(), renderRecovery(). Renders its flow into the
 * container swap.js hands it, so the HTLC path in swap.js is untouched.
 */
import '/vendor/swap-taker/buffer-shim.js';
import * as sc from '/vendor/swap-core/src/index.js';
import * as btc from '/vendor/swap-core/vendor/btc-signer.mjs';
import * as as from '/vendor/swap-xmr/src/adaptorswap.js';
import * as driver from '/vendor/swap-xmr/src/driver.js';
import { esploraBtcChain } from '/vendor/swap-xmr/src/adapters.js';
import { loadXmrCrypto } from '/vendor/swap-xmr/src/crypto.js';
import { runXmrTaker, runXmrResume, requestXmrQuote, reclaimXmr } from '/vendor/swap-taker/taker.js';
import * as engine from '/vendor/monero-engine.mjs';
import { connectRelay } from '/vendor/swap-taker/relay.js';
import qrcode from '/vendor/qrcode.mjs';

const meta = (n) => { const e = document.querySelector('meta[name="' + n + '"]'); return e && e.content; };
const RELAY = (window.TESTNETSWAP_RELAY || meta('testnetswap-relay') || 'wss://relay.testnetswap.com/');
const relayUrlFor = (makerId) => (makerId ? RELAY + (RELAY.includes('?') ? '&' : '?') + 'maker=' + encodeURIComponent(makerId) : RELAY);
// Settle coin = what the Monero swaps INTO. tBTC verifies against mempool.space (independent);
// tLTC against testnetscan (operator-run, the accepted testnet tradeoff, same as the HTLC path).
const ESPLORA = { tBTC: 'https://mempool.space/testnet4/api', tLTC: 'https://testnetscan.com/ltc-testnet/api' };
const ESPLORA_TBTC = ESPLORA.tBTC;                                  // default for the tx-link helper
const SETTLE_NET = { tBTC: sc.BTC_TESTNET4, tLTC: sc.LTC_TESTNET };
const settleNet = (c) => SETTLE_NET[c] || sc.BTC_TESTNET4;
const settleApi = (c) => ESPLORA[c] || ESPLORA_TBTC;
// Confirmations to wait on the maker’s tBTC lock before locking tXMR. Defaults to 3 (higher than the
// HTLC path): a reorg strand here is PERMANENT; the adaptor path has no independent timelock refund,
// so recovery depends on the maker’s cooperative on-chain refund bound to the lock outpoint.
const MIN_CONF = Math.max(1, Number(window.TESTNETSWAP_MIN_CONF_XMR ?? meta('testnetswap-min-conf-xmr') ?? 3) || 3);
// Monero remote nodes per network, as an ORDERED fallback list (comma-separated override via
// window/meta). A flaky public node is what defeated earlier live runs, so wallet creation and
// height lookups try each node in turn. Any extra node must also be in the /swap.html CSP
// connect-src. The from-ticker IS the network (tXMR = testnet, sXMR = stagenet).
const nodeList = (v, dflt) => String(v || dflt).split(',').map((s) => s.trim()).filter(Boolean);
const XMR_NODES = {
  testnet: nodeList(window.TESTNETSWAP_XMR_NODES_TESTNET || meta('testnetswap-xmr-nodes-testnet'), 'https://xmr-testnet-node.librenode.com'),
  stagenet: nodeList(window.TESTNETSWAP_XMR_NODES_STAGENET || meta('testnetswap-xmr-nodes-stagenet'), 'https://xmr-stagenet-node.librenode.com'),
};
const XMR_NETS = ['testnet', 'stagenet'];
const TICKER_NET = { tXMR: 'testnet', sXMR: 'stagenet' };
// Lightweight Monero-address sanity check: base58 (Bitcoin alphabet) + plausible length + a network
// version-prefix char (testnet 9/A/B, stagenet 5/7). Not a full checksum verify, just enough to catch
// a typo or a wrong-network paste before a refund address is baked in. The reclaim card also
// stays editable, so even a bad address that slips through can still be corrected.
const XMR_B58 = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
const XMR_PREFIX = { testnet: /^[9AB]/, stagenet: /^[57]/ };
export function isXmrAddr(addr, fromCoin) {
  const a = String(addr || '').trim();
  const net = TICKER_NET[fromCoin] || 'testnet';
  if (a.length < 90 || a.length > 110 || !XMR_B58.test(a)) return false;
  return (XMR_PREFIX[net] || XMR_PREFIX.testnet).test(a);
}
const nodesFor = (net) => (XMR_NODES[net] && XMR_NODES[net].length ? XMR_NODES[net] : XMR_NODES.testnet);
// Open a monero-ts wallet, trying each configured node until one is REACHABLE. createWalletFull
// connects lazily (it resolves even against a dead daemon), so it can’t detect a bad node; we
// probe /get_height (engine.getDaemonHeight) first and only bind a wallet to a node that answers.
async function createWalletAny(m, net, walletOpts, onNode) {
  const nodes = nodesFor(net); let lastErr;
  for (const uri of nodes) {
    try {
      const h = Number(await engine.getDaemonHeight(uri));
      if (!(h > 0)) throw new Error('no height from ' + uri);
      const w = await m.createWalletFull({ ...walletOpts, networkType: netTypeFor(m, net), server: { uri }, password: '' });
      onNode && onNode(uri); return w;
    } catch (e) { lastErr = e; }
  }
  throw new Error('could not reach any Monero ' + net + ' node (' + nodes.length + ' tried): ' + (lastErr && lastErr.message || lastErr));
}
const netTypeFor = (m, net) => (net === 'stagenet' ? m.MoneroNetworkType.STAGENET : m.MoneroNetworkType.TESTNET);
const STORE_KEY = 'testnetswap_xmr_recovery';
const PICO = 1e12, SATS = 1e8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) { const v = attrs[k]; if (v == null) continue; if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }   // no `html:`/innerHTML branch on purpose: nothing can route text through innerHTML here (QR is built as a parsed node via qrNode)
  for (const c of kids) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
export const fmtXmr = (pico) => (Number(pico) / PICO).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
export const fmtBtc = (sats) => (Number(sats) / SATS).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
// Build the QR as a PARSED SVG node (never innerHTML): the qrcode lib emits an <svg> of <rect>s; parse it in
// an inert document and import the root <svg>, so no path in el() touches innerHTML with any string.
function qrNode(t) {
  try {
    const q = qrcode(0, 'M'); q.addData(t); q.make();
    const svg = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const node = doc.documentElement;
    if (!node || doc.querySelector('parsererror') || String(node.nodeName).toLowerCase() !== 'svg') return null;
    return document.importNode(node, true);
  } catch { return null; }
}
function addrBox(text) {
  const b = el('button', { class: 'copy mini', type: 'button', onclick: () => { if (b.dataset.copied) return; b.dataset.copied = '1'; try { navigator.clipboard && navigator.clipboard.writeText(text); } catch {} const o = b.textContent; b.textContent = '✓'; setTimeout(() => { b.textContent = o; delete b.dataset.copied; }, 1000); } }, 'copy');
  return el('div', { class: 'addrbox' }, el('span', { class: 'mono' }, text), b);
}
// Settle-aware tx link: uses the settle coin’s own esplora base (tBTC/mempool, tLTC/testnetscan)
// so an XMR->tLTC redeem doesn’t get pointed at mempool.space (wrong chain / dead link).
const settleTxLink = (coin, txid) => el('a', { href: settleApi(coin).replace('/api', '') + '/tx/' + txid, target: '_blank', rel: 'noopener', class: 'ext' }, 'view tx');
// Monero "view tx": BTC/LTC have solid explorers; Monero testnet/stagenet explorers are community-run,
// so the operator supplies one (window global or <meta>), else we show the txid alone (still verifiable
// in your own wallet). e.g. window.TESTNETSWAP_XMR_EXPLORER_STAGENET = 'https://explorer.example/'.
const xmrExplorer = (net) => { try { return (typeof window !== 'undefined' && window['TESTNETSWAP_XMR_EXPLORER_' + String(net).toUpperCase()]) || (document.querySelector('meta[name="testnetswap-xmr-explorer-' + net + '"]') || {}).content || ''; } catch { return ''; } };
const xmrTxNode = (net, txid) => { const t = String(txid || ''); if (!/^[0-9a-f]{64}$/i.test(t)) return el('span', { class: 'muted' }, '(tx pending)'); const base = xmrExplorer(net); return base ? el('a', { href: base.replace(/\/+$/, '') + '/tx/' + t, target: '_blank', rel: 'noopener', class: 'ext' }, 'view tx') : el('span', { class: 'mono muted', title: t }, t.slice(0, 10) + '…'); };
const fmtElapsed = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return m ? (m + 'm ' + String(s % 60).padStart(2, '0') + 's') : (s + 's'); };

/* ---- lazy deps: WASM crypto + the Monero wallet engine ---- */
let _deps = null, _x = null;
// Just the WASM swap crypto (small). The forward-resume path needs only this (settle chain + relay, no
// Monero wallet), so it skips the ~7 MB engine that loadDeps additionally pulls.
async function loadXmrCryptoOnce(onStep) { if (!_x) { onStep && onStep('Loading swap crypto…'); _x = await loadXmrCrypto(); } return _x; }
async function loadDeps(onStep) {
  if (_deps) return _deps;
  const x = await loadXmrCryptoOnce(onStep);
  onStep && onStep('Loading the Monero engine (~7 MB, first time only)…');
  await engine.load();
  _deps = { x };
  return _deps;
}
async function chainHeight(net) { for (const uri of nodesFor(net)) { try { const h = Number(await engine.getDaemonHeight(uri)); if (h > 0) return h; } catch {} } return 0; }

/* ---- Monero chain adapter: lock() = user deposits to the combined address; sweep() = reclaim ---- */
function makeXmrChain({ net, getViewParams, onDeposit, onDepositTick, onNode, onSyncProgress, onDepositTxid, pollMs = 12000, tries = 1200 }) {
  return {
    async lock({ address, amount }) {
      const { viewPriv, restoreHeight } = getViewParams();
      if (!viewPriv) throw new Error('internal: missing combined view key for the lock deposit');
      onDeposit && onDeposit(address, amount);
      const m = await engine.load();
      const opts = { primaryAddress: address, privateViewKey: viewPriv, restoreHeight };
      // Additive-only progress: surface the wallet's chain scan so a slow node isn't a black box. Fully
      // isolated (try/catch) so a listener-API mismatch can NEVER affect the deposit detection below.
      const attachProgress = async (wallet) => { try { const L = new m.MoneroWalletListener(); L.onSyncProgress = (h, s, e, pct) => { try { onSyncProgress && onSyncProgress(pct); } catch {} }; await wallet.addListener(L); } catch {} };
      let w = await createWalletAny(m, net, opts, onNode);
      await attachProgress(w);
      let fails = 0;
      try {
        for (let i = 0; i < tries; i++) {
          try {
            await w.sync(); fails = 0;
            const bal = await w.getBalance();
            if (bal >= BigInt(amount)) {
              let hash = 'xmr-lock';
              try { for (const t of await w.getTxs()) { const inc = t.getIncomingTransfers && t.getIncomingTransfers(); if (inc && inc.length) hash = t.getHash(); } } catch {}
              try { onDepositTxid && onDepositTxid(hash); } catch {}
              return hash;
            }
            onDepositTick && onDepositTick(bal);
          } catch {
            // The bound node may have died mid-wait; after a few consecutive failures, fail over
            // to another configured node (createWalletFull won’t do this on its own).
            if (++fails >= 4) { onNode && onNode('reconnecting to another Monero node…'); try { await w.close(); } catch {} try { w = await createWalletAny(m, net, opts, onNode); await attachProgress(w); fails = 0; } catch {} }
          }
          await sleep(pollMs);
        }
        throw new Error('timed out waiting for your Monero deposit');
      } finally { try { await w.close(); } catch {} }
    },
    async sweep({ privateSpendKey, privateViewKey, primaryAddress, restoreHeight, dest }) {
      const m = await engine.load();
      const opts = { privateSpendKey, privateViewKey, primaryAddress, restoreHeight: restoreHeight || 0 };
      let w = await createWalletAny(m, net, opts, onNode);
      let fails = 0;
      try {
        let unlocked = false;
        for (let i = 0; i < tries; i++) {
          try { await w.sync(); fails = 0; if ((await w.getUnlockedBalance()) > 0n) { unlocked = true; break; } }
          catch { if (++fails >= 4) { onNode && onNode('reconnecting to another Monero node…'); try { await w.close(); } catch {} try { w = await createWalletAny(m, net, opts, onNode); fails = 0; } catch {} } }
          await sleep(pollMs);
        }
        if (!unlocked) throw new Error('no unlocked Monero to reclaim yet (still maturing). Retry shortly');
        const txs = await w.sweepUnlocked({ address: dest, relay: true });
        const ids = (txs || []).map((t) => t.getHash());
        if (!ids.length) throw new Error('sweep produced no transaction');
        return ids;
      } finally { try { await w.close(); } catch {} }
    },
  };
}

/* ---- recovery persistence ---- */
// Throws (does NOT swallow) so a failed persist ABORTS before any tXMR is locked; otherwise a stall
// would be unrecoverable with no reclaim data. Mirrors the HTLC save() fail-closed behavior.
// Let the host page (its "My swaps" list) react when this single-slot recovery appears or is cleared,
// without coupling the two modules. No-op outside a browser.
const notifyRecoveryChanged = () => { try { if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new CustomEvent('testnetswap:xmr-recovery-changed')); } catch {} };
const saveRec = (r) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(r)); } catch (e) { throw new Error('could not save reclaim data to this browser (storage full or blocked): ' + (e.message || e)); } notifyRecoveryChanged(); };
const clearRec = () => { try { localStorage.removeItem(STORE_KEY); } catch {} notifyRecoveryChanged(); };
export function getRecovery() { try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
export function hasRecovery() { const r = getRecovery(); return !!(r && r.lockOutpoint && r.km); }
// Download the reclaim record as a backup file so a stalled swap can be reclaimed from another
// device or after clearing this browser. It holds the swap key material, so keep the file private.
function downloadJSON(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Import a reclaim backup so the reclaim card + refund become available here. Validates the same
// shape hasRecovery requires, and refuses anything else so a bad file cannot half-write the store.
export function importRecovery(rec) {
  if (!rec || !rec.lockOutpoint || !rec.km) return false;
  // H3: never clobber a DIFFERENT unreclaimed swap already saved here. A same-outpoint re-import is
  // idempotent and allowed; a different one is refused so its recovery data survives.
  const existing = getRecovery();
  if (existing && existing.lockOutpoint && existing.lockOutpoint.txid !== rec.lockOutpoint.txid) return false;
  saveRec(rec);
  return true;
}

/* ---- flow rendering (into the container swap.js provides) ---- */
// Real event order: the maker locks the settle coin first, it confirms, THEN you deposit Monero, then
// redeem. Labels are settle/from-aware (tBTC vs tLTC, tXMR vs sXMR) so they match the actual swap.
const buildSteps = (fromCoin, toCoin) => [['locked', 'Maker locks ' + toCoin], ['confirm', 'Confirm lock'], ['deposit', 'You deposit ' + fromCoin], ['redeem', 'Receive ' + toCoin]];
function flowShell(root) {
  root.replaceChildren();
  const head = el('div', { class: 'flow-head muted', style: 'display:none;font-size:13px;margin-bottom:8px;gap:10px;align-items:baseline' });
  const msg = el('div', { class: 'msg', style: 'display:none' });
  const tracker = el('div', { class: 'flow-steps', style: 'margin-top:14px' });
  const deposit = el('div', { class: 'card', style: 'display:none;margin-top:14px' });
  const done = el('div', { class: 'card', style: 'display:none;margin-top:14px' });
  root.append(head, msg, tracker, deposit, done);
  root.style.display = '';
  return { head, msg, tracker, deposit, done };
}
const showMsg = (m, kind, text) => { m.className = 'msg ' + kind; m.textContent = text; m.style.display = ''; };
// Mirror the HTLC tracker markup: the state class rides on the .flow-step-ico span (so done=green,
// active=accent+pulse via CSS), the label carries .flow-step-label, and not-yet-reached steps emit
// 'pending' (which CSS mutes) instead of a bare '' that never lit up.
function tracker(host, steps, active, done, subs = {}) {
  host.replaceChildren(...steps.map(([k, label]) => {
    const state = done.has(k) ? 'done' : (k === active ? 'active' : 'pending');
    return el('div', { class: 'flow-step ' + state },
      el('span', { class: 'flow-step-ico' + (state === 'done' ? ' done' : state === 'active' ? ' active' : '') }, state === 'done' ? '✓' : state === 'active' ? '◐' : '○'),
      el('div', { class: 'flow-step-main' },
        el('div', { class: 'flow-step-label' }, label),
        subs[k] ? el('div', { class: 'flow-step-sub muted', style: 'font-size:12px;margin-top:2px' }, subs[k]) : null));
  }));
}
function renderDeposit(host, address, amountPico, net, fromCoin, toCoin) {
  const uri = 'monero:' + address + '?tx_amount=' + (Number(amountPico) / PICO);
  // Reclaim backup, offered HERE on purpose: onBeforeLock already persisted (and read-back-verified)
  // the recovery blob before any lock, so it is complete by the time this screen shows. Saving it to
  // another device NOW means a lost tab/browser after you send is still reclaimable. Guarded on
  // hasRecovery() so it can never hand out an empty/partial file that would leave you unable to reclaim
  // (identical format to the reclaim-card Backup, so the two files are interchangeable).
  const dlBackup = el('button', { class: 'formbtn ghost', type: 'button', style: 'margin-top:10px', title: 'Downloads this swap’s reclaim file. It holds the key material to recover your ' + (fromCoin || 'tXMR') + ' from another device if this browser is lost. Keep it private.' }, 'Download reclaim backup');
  dlBackup.addEventListener('click', () => {
    const rec = getRecovery();
    if (!hasRecovery() || !rec) { alert('Reclaim data is not saved yet, so a backup would be empty. Do not send ' + (fromCoin || 'tXMR') + ' until this works.'); return; }
    downloadJSON('testnetswap-xmr-recovery.json', { app: 'testnetswap', kind: 'xmr', version: 1, record: rec });
  });
  host.replaceChildren(
    el('div', { class: 'card-header' }, 'Send exactly ' + fmtXmr(amountPico) + ' ' + (fromCoin || 'tXMR') + (net ? ' (Monero ' + net + ')' : '')),
    el('div', { class: 'card-body' }, el('div', { class: 'deposit-grid' },
      el('a', { class: 'qr', href: uri, title: 'Open in your Monero wallet' }, qrNode(uri)),
      el('div', { class: 'deposit-side' },
        el('p', { class: 'muted', style: 'margin:.2em 0 .6em;font-size:13px' }, 'The 2-of-2 lock address on Monero ' + (net || 'testnet') + '. Send from a wallet on that network. The maker already locked its ' + (toCoin || 'tBTC') + '; sending here locks your side. Keep this tab open.'),
        addrBox(address),
        el('div', { class: 'msg warn', style: 'margin-top:8px;font-size:12px' }, 'Send this exact amount. Sending MORE is lost to the maker (you still receive only the agreed ' + (toCoin || 'tBTC') + '). Prefer the QR, which fills the amount for you; if you send in several transactions keep the total at or below this and top up, never over. Sending less just waits until the full amount arrives.'),
        el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' }, 'Need ' + (net || 'testnet') + ' Monero? ', el('a', { href: 'https://cypherfaucet.com/xmr-' + (net || 'testnet'), target: '_blank', rel: 'noopener', class: 'ext' }, 'Get some from CypherFaucet →')),
        el('div', {},
          dlBackup,
          el('div', { class: 'muted', style: 'margin-top:4px;font-size:12px' }, 'Optional but recommended before you send: reclaim your ' + (fromCoin || 'tXMR') + ' from another device if this browser is lost.')),
        el('div', { class: 'muted dep-status', style: 'margin-top:8px;font-size:13px' }, 'Waiting for your deposit. Detection can lag while your wallet syncs the node; once it is seen, the maker waits for Monero’s ~10-block unlock before it completes.')))));
  host.style.display = '';
}

/* ---- quote preview (called by swap.js on amount change) ---- */
export async function preview({ fromCoin = 'tXMR', toCoin = 'tBTC', makerId = null, sendPico, onQuote, onErr }) {
  const want = TICKER_NET[fromCoin] || 'testnet';
  let relay;
  try {
    relay = await connectRelay(relayUrlFor(makerId));
    const q = await requestXmrQuote({ transport: relay, fromCoin, toCoin, sendPico: Math.round(sendPico), quoteOnly: true });
    if (q.network && q.network !== want) throw new Error('maker returned ' + q.network + ', expected ' + want);
    onQuote && onQuote(q);
  } catch (e) { onErr && onErr(e); } // a maker that doesn’t serve this network fast-fails here with its reason
  finally { relay && relay.close && relay.close(); }
}

/* ---- run the swap (called by swap.js start) ---- */
export async function run({ fromCoin = 'tXMR', toCoin = 'tBTC', makerId = null, sendPico, btcDest, xmrRefund, minLockSats = null, root, onMsg = () => {} }) {
  const want = TICKER_NET[fromCoin] || 'testnet';
  const ui = flowShell(root);
  const steps = buildSteps(fromCoin, toCoin);
  const done = new Set();
  const subs = {};
  let lockTxid = null; // the maker's settle-coin lock txid, for the "view tx" link on the confirm step
  const advance = (active, ...doneKeys) => { doneKeys.forEach((k) => done.add(k)); tracker(ui.tracker, steps, active, done, subs); };
  advance('locked');
  const say = (kind, text) => { showMsg(ui.msg, kind, text); onMsg(kind, text); };
  // Hoisted so the catch/cleanup path can always stop the display timers, even if we throw before setup.
  let stopTimers = () => {}, stopMaturation = () => {};
  try {
    if (!btcDest) throw new Error('enter a ' + toCoin + ' receive address');
    if (!xmrRefund) throw new Error('enter a ' + fromCoin + ' refund address (where your Monero returns if the swap stalls)');
    if (!isXmrAddr(xmrRefund, fromCoin)) throw new Error('that does not look like a valid Monero ' + want + ' address. Double-check your refund address before locking your ' + fromCoin);
    // Indeterminate progress bar while the ~7 MB engine downloads + inits, so a slow first load
    // doesn’t look frozen. Reduced-motion falls back to a full static bar via CSS.
    const bar = el('div', { class: 'pbar indet' }, el('span', {}));
    ui.msg.after(bar);
    say('', 'Loading the Monero engine (~7 MB, first time only)…');
    let x;
    try { ({ x } = await loadDeps((s) => say('', s))); } finally { bar.remove(); }

    const relay = await connectRelay(relayUrlFor(makerId));
    const q = await requestXmrQuote({ transport: relay, fromCoin, toCoin, sendPico: Math.round(sendPico), quoteOnly: false });
    // Rate-honesty floor (parity with the HTLC minRecvSats guard): the execution quote is fetched fresh,
    // so a maker could quote high in the preview and return less here. Refuse (BEFORE any XMR is locked)
    // if the amount dropped materially below what you were shown (2% slippage tolerated for rounding).
    if (minLockSats != null && Number(q.lock_sats) < Math.floor(Number(minLockSats) * 0.98)) {
      throw new Error('the maker now offers ' + fmtBtc(q.lock_sats) + ' ' + toCoin + ', below your quoted ' + fmtBtc(minLockSats) + ' ' + toCoin + '. Not locking your ' + fromCoin + '; get a fresh quote and try again.');
    }
    const net = q.network || want;
    if (!XMR_NETS.includes(net) || net !== want) throw new Error('maker served ' + net + ', but you selected ' + fromCoin + ' (' + want + ')');
    const restoreHeight = await chainHeight(net);
    // Fail closed: if no Monero node answered, chainHeight() is 0 and both the lock wallet and a
    // later reclaim would rescan from genesis (very slow / can time out). Refuse to lock until a
    // node is reachable rather than silently degrade to restoreHeight=0.
    if (!restoreHeight || restoreHeight <= 0) throw new Error('could not reach a Monero ' + net + ' node to read the chain height. Not locking your ' + fromCoin + '. Retry when a node is reachable.');

    // ---- flow detail (parity with the HTLC flow): amounts header, a live elapsed timer, per-step tx
    // links + a Monero maturation counter. All read-only display over data the flow already has. ----
    const sendAmt = fmtXmr(q.xmr_pico != null ? q.xmr_pico : Math.round(sendPico)) + ' ' + fromCoin;
    const recvAmt = fmtBtc(q.lock_sats) + ' ' + toCoin;
    const started = Date.now();
    const elapsedEl = el('span', { class: 'mono' }, '0s');
    ui.head.replaceChildren(el('span', {}, sendAmt + ' → ~' + recvAmt), el('span', { style: 'margin-left:auto' }, 'elapsed ', elapsedEl));
    ui.head.style.display = 'flex';
    const timers = [setInterval(() => { elapsedEl.textContent = fmtElapsed(Date.now() - started); }, 1000)];
    stopTimers = () => { timers.forEach((t) => clearInterval(t)); timers.length = 0; };
    let depositTxid = null, matureTimer = null;
    // Estimate the sXMR lock's confirmations toward the ~10-block Monero unlock the maker waits for, from
    // the daemon tip captured at deposit detection (conservative: detection lags the tx block, so it runs
    // a touch low; the maker may release just before it visibly hits 10). Lightweight height poll only.
    const startMaturation = () => {
      if (matureTimer) return;
      chainHeight(net).then((h0) => {
        if (!h0 || matureTimer) return;
        const MATURE = 10;
        const tick = async () => {
          let h = 0; try { h = await chainHeight(net); } catch {}
          const c = h > h0 ? Math.min(MATURE, h - h0) : 0; const left = Math.max(0, MATURE - c);
          subs.redeem = el('span', {}, 'your ' + fromCoin + ' maturing on Monero: ~' + c + '/' + MATURE + ' confirmations' + (left ? ' (~' + (left * 2) + ' min left)' : ', releasing soon'));
          advance('redeem', 'locked', 'confirm', 'deposit');
        };
        tick(); matureTimer = setInterval(tick, 30000); timers.push(matureTimer);
      }).catch(() => {});
    };
    stopMaturation = () => { if (matureTimer) { clearInterval(matureTimer); const i = timers.indexOf(matureTimer); if (i >= 0) timers.splice(i, 1); matureTimer = null; } };

    const km = as.genKeyMaterial(x);
    const params = {
      fromCoin, toCoin,                                   // coin tickers -> the driver emits coin-correct status notes (no hardcoded tBTC/tXMR)
      sendCoinNetwork: settleNet(toCoin), moneroNetwork: net,
      t1Blocks: q.t1_blocks, t2Blocks: q.t2_blocks, lockAmount: q.lock_sats, minConf: MIN_CONF,
      xmrAmount: q.xmr_pico != null ? q.xmr_pico : Math.round(sendPico),
      xmrRestoreHeight: restoreHeight, xmrSweepDest: xmrRefund, aliceBtcDest: btcDest,
      setupTimeoutMs: 60000, lockTimeoutMs: 3600000, redeemTimeoutMs: 3600000,
      onStatus: (phase, note, meta) => {
        if (meta && meta.txid && (phase === 'maker_locked' || phase === 'confirming')) lockTxid = meta.txid;
        if (phase === 'maker_locked' || phase === 'confirming') advance('confirm', 'locked');
        else if (phase === 'xmr_locked' || phase === 'redeeming') {
          advance('redeem', 'locked', 'confirm', 'deposit'); ui.deposit.style.display = 'none';
          if (depositTxid) subs.deposit = el('span', {}, 'sent ' + sendAmt + ' · ', xmrTxNode(net, depositTxid));
          if (phase === 'xmr_locked') startMaturation(); else stopMaturation();
        }
        // Coin-aware notes: the driver hardcodes tBTC/tXMR in these, wrong on XMR->tLTC or a stagenet
        // (sXMR) swap. Render fromCoin/toCoin text for the coin-bearing phases (onConf enriches 'confirming').
        if (phase === 'maker_locked') say('ok', 'The maker locked its ' + toCoin + '.');
        else if (phase === 'confirming') say('ok', 'Verifying the ' + toCoin + ' lock on-chain…');
        else if (phase === 'xmr_locked') say('ok', 'Your ' + fromCoin + ' is locked. The maker now waits for it to mature (~10 Monero blocks, roughly 20 min) before it releases your ' + toCoin + '. This is the longest step; the tab is not frozen, keep it open.');
        else if (phase === 'redeeming') say('ok', 'Redeeming your ' + toCoin + '…');
        else if (phase === 'resuming') say('warn', note); // relay dropped mid-wait; the taker is reconnecting + re-requesting
        else if (note) say('ok', note);
      },
    };
    let viewParams = { viewPriv: null, restoreHeight };
    const xmrChain = makeXmrChain({
      net,
      getViewParams: () => viewParams,
      onDeposit: (address, amount) => { advance('deposit', 'locked', 'confirm'); renderDeposit(ui.deposit, address, amount, net, fromCoin, toCoin); say('ok', 'Now send your ' + fromCoin + ' (Monero ' + net + ') to the address below.'); },
      onDepositTick: (bal) => { const d = ui.deposit.querySelector('.dep-status'); if (d) d.textContent = (bal > 0n) ? ('Seen ' + fmtXmr(bal) + ' ' + fromCoin + ' so far…') : 'Synced to the chain tip; waiting for your deposit to arrive…'; },
      onSyncProgress: (pct) => { const d = ui.deposit.querySelector('.dep-status'); if (d && pct != null && pct < 0.999) d.textContent = 'Scanning the Monero chain for your deposit… ' + Math.min(99, Math.max(0, Math.round(pct * 100))) + '%'; },
      onNode: (info) => { if (/reconnect/.test(String(info))) say('warn', 'Monero node unresponsive: ' + info); },
      onDepositTxid: (txid) => { depositTxid = txid; },
    });
    // onConf drives the "Confirm lock" step live. The driver blocks in waitConfirmed(lp.txid, minConf)
    // with no per-block ticks, so without this the UI sits on a flat "waiting" for the 20+ min a testnet
    // lock can take. This chain's waitConfirmed runs ONLY during that maker-lock wait (the redeem uses
    // broadcast, not waitConfirmed), so every tick here belongs to the confirm step.
    const btcChain = esploraBtcChain({ btc, sc, x, api: settleApi(toCoin), network: settleNet(toCoin), fundKeyHex: km.btcKey,
      onConf: (c, need) => {
        const shown = Math.max(0, Math.min(c, need));
        // Sub-line under "Confirm lock": the live count plus a link to the real maker lock tx on the
        // settle coin's own explorer (opens in a new tab). href is scheme-fixed (https://.../tx/) so
        // the txid can only fill the path, and the label is textContent; no injection surface.
        subs.confirm = el('span', {}, shown + '/' + need + ' confirmations',
          lockTxid ? el('span', { class: 'muted' }, ' · ', el('a', { href: settleApi(toCoin).replace('/api', '') + '/tx/' + lockTxid, target: '_blank', rel: 'noopener', class: 'ext' }, 'view tx')) : null);
        advance('confirm', 'locked');
        say('ok', 'Waiting for the ' + toCoin + ' lock to reach ' + need + ' confirmations (' + shown + '/' + need + '). Testnet blocks are irregular, so this can take 20+ minutes. Nothing of yours is committed yet. You have not sent any ' + fromCoin + ', so it is safe to keep this tab open and wait.');
      } });

    const onBeforeLock = async (recovery) => {
      viewParams = { viewPriv: recovery.ctx.combinedViewPriv, restoreHeight };
      // H3 (run()-side guard): if a DIFFERENT unreclaimed swap slipped into the single recovery slot
      // during this swap's pre-lock window (e.g. a backup imported mid-swap, when the start-time guard
      // saw an empty slot), refuse to overwrite it. Abort THIS swap before locking; nothing of ours is
      // committed yet, so the other swap's only on-device recovery survives.
      const prior = getRecovery();
      if (prior && prior.lockOutpoint && recovery.lockOutpoint && prior.lockOutpoint.txid !== recovery.lockOutpoint.txid) {
        throw new Error('another unreclaimed Monero swap is saved in this browser. Not locking your ' + fromCoin + '; reclaim or clear it first.');
      }
      saveRec({ ...recovery, toCoin, sendPico, btcDest, xmrRefund, makerId, xmrRestoreHeight: restoreHeight, at: Math.floor(Date.now() / 1000) });
      // Fail closed: confirm the reclaim blob actually persisted (read-back) BEFORE any tXMR is
      // locked. If storage silently dropped it, a stall would be unrecoverable.
      if (!hasRecovery()) throw new Error('could not persist reclaim data to this browser (storage full or blocked). Not locking your ' + fromCoin);
    };

    say('ok', 'Waiting for the maker to lock ' + toCoin + ' on-chain…');
    // relayFactory + sc enable resume: if the relay WS drops during the long redeem-adaptor wait, the
    // taker reconnects on a fresh relay and re-requests the adaptor (authenticated) instead of dying into
    // a multi-hour reclaim. Falls back to reclaim if it can't recover in time.
    const res = await runXmrTaker({ x, btc, as, driver, transport: relay, chains: { btc: btcChain, xmr: xmrChain }, km, params, onBeforeLock, sc, relayFactory: () => connectRelay(relayUrlFor(makerId)) });

    stopMaturation(); stopTimers();
    // REDEEM_FEE_SATS matches the driver's redeemTemplate default (the redeem output = lock - fee), so
    // net received = the maker's quoted lock minus that on-chain fee. Used for both the step sub-line and
    // the receipt so they agree.
    const REDEEM_FEE_SATS = 1000;
    const grossSats = Number(q.lock_sats);
    const netSats = Math.max(0, grossSats - REDEEM_FEE_SATS);
    const netAmt = fmtBtc(netSats) + ' ' + toCoin;
    if (depositTxid) subs.deposit = el('span', {}, 'sent ' + sendAmt + ' · ', xmrTxNode(net, depositTxid));
    subs.redeem = el('span', {}, 'received ' + netAmt + ' · ', settleTxLink(toCoin, res && res.redeemTxid));
    ['deposit', 'locked', 'confirm', 'redeem'].forEach((k) => done.add(k)); tracker(ui.tracker, steps, null, done, subs);
    ui.deposit.style.display = 'none';
    // Keep the reclaim blob until the redeem CONFIRMS, not merely broadcasts: the redeem reveals your key
    // share, and a low-fee redeem dropped from mempools before it confirms would otherwise leave you with
    // no way to reclaim. Poll in the background; clear on confirmation, else keep it so the swap stays
    // recoverable (My swaps / a backup). The receipt already shows; this only governs when we forget.
    (async () => { for (let i = 0; i < 80; i++) { try { const o = await btcChain.getOutput(res.redeemTxid, 0); if (o && o.confirmed) { clearRec(); return; } } catch {} await new Promise((r) => setTimeout(r, 15000)); } })();
    say('ok', 'Swap complete. ' + toCoin + ' redeemed to your address.');
    // Receipt at parity with the HTLC flow: sent/quoted/fee/net, duration, and every leg's tx link.
    const kv = (label, value) => el('div', { class: 'kv' }, el('span', { class: 'muted' }, label), (value && value.nodeType) ? value : el('span', {}, value));
    ui.done.replaceChildren(
      el('div', { class: 'card-header' }, '✓ Swap complete', el('div', { class: 'muted', style: 'font-size:13px;font-weight:400' }, 'You received ' + netAmt)),
      el('div', { class: 'card-body receipt' },
        kv('Sent', sendAmt),
        kv('Quoted', fmtBtc(grossSats) + ' ' + toCoin),
        kv('Claim network fee', '−' + fmtBtc(REDEEM_FEE_SATS) + ' ' + toCoin),
        kv('Net received', el('b', { class: 'pos' }, netAmt)),
        kv('Duration', fmtElapsed(Date.now() - started)),
        kv('Redeem tx', (res && res.redeemTxid) ? settleTxLink(toCoin, res.redeemTxid) : el('span', { class: 'muted' }, '-')),
        kv('Your ' + fromCoin + ' deposit', depositTxid ? xmrTxNode(net, depositTxid) : el('span', { class: 'muted' }, '-')),
        kv('Maker lock tx', lockTxid ? settleTxLink(toCoin, lockTxid) : el('span', { class: 'muted' }, '-')),
        el('p', { class: 'muted', style: 'font-size:13px;margin-top:10px' }, 'The maker claims your ' + fromCoin + ' with the now-shared key. Nothing more to do.'),
        el('div', { class: 'row', style: 'margin-top:12px;gap:8px' },
          el('button', { class: 'formbtn', type: 'button', onclick: () => { try { window.dispatchEvent(new CustomEvent('testnetswap:swap-again')); } catch {} } }, 'Swap again'))));
    ui.done.style.display = '';
    relay.close && relay.close();
    return { ok: true };
  } catch (e) {
    stopMaturation(); stopTimers();
    const reason = (e && e.message) || String(e);
    try { console.error('[xmr-swap] interrupted:', e); } catch {}
    const rec = getRecovery();
    // Surface the ACTUAL failure (it used to be swallowed the moment a reclaim blob existed). If you
    // already deposited, the swap can only land in reclaim, but you still need to see WHY it stopped
    // (e.g. the settle-coin redeem broadcast was rejected) so a real bug is visible, not hidden.
    if (rec && rec.lockOutpoint) { say('warn', 'Swap interrupted (' + reason + '). If you already sent your ' + fromCoin + ', reclaim it below; if you never sent any, nothing is locked, so you can Clear it.'); renderReclaim(ui.deposit, rec, say); ui.deposit.style.display = ''; }
    else { say('bad', reason); }
    return { ok: false, error: e };
  }
}

/* ---- reclaim (stall recovery) ---- */
function renderReclaim(host, rec, say) {
  const fromCoin = rec.moneroNetwork === 'stagenet' ? 'sXMR' : 'tXMR';   // the from-ticker IS the network
  const settle = rec.toCoin || 'tBTC';
  const m = el('div', { class: 'msg', style: 'display:none;margin-top:10px' });
  const fwdMsg = el('div', { class: 'msg', style: 'display:none;margin-top:10px' });
  // Forward-continue (primary): try to FINISH and receive the settle coin before offering the backward reclaim.
  const finishBtn = el('button', { class: 'formbtn', type: 'button', title: 'Reconnect to the maker and finish the swap so you receive your ' + settle + '. Use this if you already sent your ' + fromCoin + '.' }, 'Finish swap (receive ' + settle + ')');
  finishBtn.addEventListener('click', () => resumeForward(rec, finishBtn, fwdMsg, host));
  // Always editable + pre-filled: a wrong/typo’d refund address MUST be correctable here, or the Monero
  // would be stranded against a sweep target that can’t receive it. doReclaim reads this field.
  const destInput = el('input', { type: 'text', value: rec.xmrRefund || '', placeholder: 'your ' + fromCoin + ' refund address', style: 'width:100%;margin:6px 0 4px' });
  const btn = el('button', { class: 'formbtn', type: 'button' }, 'Reclaim my ' + fromCoin);
  btn.addEventListener('click', () => doReclaim(rec, destInput, m, btn));
  const backupBtn = el('button', { class: 'formbtn ghost', type: 'button', title: 'Download a backup file to reclaim from another device or after clearing this browser' }, 'Backup');
  backupBtn.addEventListener('click', () => downloadJSON('testnetswap-xmr-recovery.json', { app: 'testnetswap', kind: 'xmr', version: 1, record: rec }));
  // Escape hatch: forget an abandoned recovery so a new swap can start. Guarded by a confirm and a
  // strong warning, because clearing without a backup loses the only way to reclaim the locked XMR.
  const clearBtn = el('button', { class: 'formbtn ghost', type: 'button', title: 'Forget this saved swap on this browser. Back it up first: clearing loses the ability to reclaim.' }, 'Clear');
  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear this saved Monero swap? You will LOSE the ability to reclaim its locked ' + fromCoin + ' from this browser unless you have a backup (use Backup first). Continue?')) return;
    clearRec();
    const cleared = el('div', { class: 'card-body muted' }, 'Cleared. If you kept a backup, restore it later to reclaim.');
    host.replaceChildren(cleared);
    // Auto-hide the notice, but NOT if a new swap has since taken over this container (run()'s flowShell
    // replaces its children). Without this guard the stale timer hides the running swap's flow, leaving a
    // frozen-looking "Swapping…" with nothing visible.
    setTimeout(() => { if (host.contains(cleared)) host.style.display = 'none'; }, 4000);
  });
  host.replaceChildren(
    el('div', { class: 'card-header' }, 'Finish or reclaim this Monero swap'),
    el('div', { class: 'card-body' },
      el('p', { class: 'muted', style: 'margin:.2em 0 .6em;font-size:14px' }, 'If you already sent your ' + fromCoin + ', you can finish the swap now and receive your ' + settle + '. Reclaiming your ' + fromCoin + ' instead is the fallback for when the maker is gone or it is too late to finish.'),
      finishBtn, fwdMsg,
      el('hr', { style: 'border:none;border-top:1px solid rgba(255,255,255,.12);margin:14px 0' }),
      el('p', { class: 'muted', style: 'margin:.2em 0 .8em;font-size:14px' }, 'If you sent ' + fromCoin + ' in a swap that did not finish, Reclaim gets it back (the Monero equivalent of a refund): it chases the maker’s on-chain refund and sweeps your ' + fromCoin + ' to your address. Expect up to a few hours (the on-chain cancel/refund timelocks, then Monero’s ~20-minute maturity); keep this tab open and retry if needed. If you never sent any ' + fromCoin + ', nothing is locked, so just Clear below.'),
      el('div', { class: 'muted', style: 'font-size:13px' }, 'Sweep your ' + fromCoin + ' to this address (correct it if wrong):'),
      destInput,
      el('div', { class: 'row', style: 'gap:8px;margin-top:6px' }, btn, backupBtn, clearBtn), m));
}
async function doReclaim(rec, destInput, m, btn) {
  const show = (kind, t) => showMsg(m, kind, t);
  const fromCoin = rec.moneroNetwork === 'stagenet' ? 'sXMR' : 'tXMR';   // the from-ticker IS the network
  const dest = (destInput && destInput.value.trim()) || rec.xmrRefund; // prefer the editable field so a wrong saved address can be corrected
  if (!dest) { show('bad', 'Enter your ' + fromCoin + ' refund address.'); return; }
  if (!isXmrAddr(dest, fromCoin)) { show('bad', 'That doesn’t look like a valid Monero address. Double-check it.'); return; }
  btn.disabled = true; show('', 'Loading engine + chasing the maker’s refund on-chain…');
  try {
    const { x } = await loadDeps((s) => show('', s));
    const rnet = rec.moneroNetwork || 'testnet';
    const settle = rec.toCoin || 'tBTC';              // older reclaim blobs predate toCoin -> tBTC
    // The driver's progress notes hardcode 'tXMR' / 'maker BTC'; relabel to this swap's actual coins.
    const relabel = (s) => String(s).replace(/tXMR/g, fromCoin).replace(/maker BTC/g, 'maker ' + settle);
    const btcChain = esploraBtcChain({ btc, sc, x, api: settleApi(settle), network: settleNet(settle), fundKeyHex: rec.km.btcKey });
    const xmrChain = makeXmrChain({ net: rnet, getViewParams: () => ({ viewPriv: rec.ctx.combinedViewPriv, restoreHeight: rec.xmrRestoreHeight || 0 }), onNode: (info) => { if (/reconnect/.test(String(info))) show('', 'Monero node unresponsive: ' + info); } });
    const res = await reclaimXmr({ x, btc, as, driver, chains: { btc: btcChain, xmr: xmrChain }, recovery: rec, sendCoinNetwork: settleNet(settle), xmrDest: dest, aliceBtcDest: rec.btcDest, onProgress: (s) => show('', relabel(s)) });
    clearRec();
    if (res && res.state === 'punished') show('ok', 'The maker cancelled but never refunded, so the swap was punished. The maker’s ' + settle + ' is now yours: ' + res.punishTxid);
    else show('ok', 'Reclaimed. ' + fromCoin + ' swept home: ' + ((res && res.sweepTxids) || []).join(', '));
  } catch (e) { show('bad', 'Reclaim failed (safe to retry): ' + ((e && e.message) || e)); btn.disabled = false; }
}

// Forward-continue: FINISH a persisted swap (reconnect to the maker, re-request the redeem adaptor,
// broadcast the settle-coin redeem) so you receive the coin you wanted, instead of reclaiming the XMR.
// On a clean finish it clears the record and shows a receipt; on anything else it explains why and
// leaves the reclaim path below untouched (the safe fallback). Settle-chain + relay only; no XMR wallet.
async function resumeForward(rec, btn, statusEl, host) {
  const fromCoin = rec.moneroNetwork === 'stagenet' ? 'sXMR' : 'tXMR';
  const settle = rec.toCoin || 'tBTC';
  const show = (kind, t) => showMsg(statusEl, kind, t);
  const relabel = (s) => String(s).replace(/settle coin/g, settle).replace(/tXMR/g, fromCoin);
  btn.disabled = true; show('', 'Reconnecting to the maker to finish the swap…');
  try {
    const x = await loadXmrCryptoOnce((s) => show('', s)); // forward-resume is settle-chain + relay only; no Monero engine needed
    const btcChain = esploraBtcChain({ btc, sc, x, api: settleApi(settle), network: settleNet(settle), fundKeyHex: rec.km.btcKey });
    const res = await runXmrResume({
      x, btc, as, driver, chains: { btc: btcChain }, km: rec.km, persisted: rec,
      sendCoinNetwork: settleNet(settle), aliceDest: rec.btcDest, sc,
      relayFactory: () => connectRelay(relayUrlFor(rec.makerId || null)),
      onStatus: (phase, note) => { if (note) show(phase === 'resuming' ? 'warn' : '', relabel(note)); },
    });
    if (res && res.state === 'redeemed') {
      clearRec();
      host.replaceChildren(
        el('div', { class: 'card-header' }, '✓ Swap finished'),
        el('div', { class: 'card-body receipt' },
          el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Received'), el('span', {}, settle)),
          el('div', { class: 'kv' }, el('span', { class: 'muted' }, 'Redeem tx'), res.redeemTxid ? settleTxLink(settle, res.redeemTxid) : el('span', {}, '-')),
          el('p', { class: 'muted', style: 'font-size:13px;margin-top:10px' }, 'Your ' + settle + ' was redeemed to your address. The maker takes your ' + fromCoin + ' with the now-shared key. Nothing more to do.')));
      return;
    }
    // Still maturing is NOT a failure: the maker is alive and waiting on Monero's ~10-block unlock. Tell
    // the user to keep waiting and retry, and do NOT push the slower reclaim (which would be a worse outcome).
    if (res && res.reason === 'still_maturing') {
      show('warn', 'The maker is still maturing your ' + fromCoin + ' on Monero (~10 blocks; this is the longest step). Keep this tab open and click "Finish swap" again in a few minutes.');
      btn.disabled = false; return;
    }
    const why = ({
      cancelled: 'the maker already cancelled this swap on-chain', timelock_margin: 'it is too close to the refund deadline to finish safely',
      no_adaptor: 'the maker did not respond (it may be offline, or the swap has expired)', incomplete_recovery: 'this saved swap is missing data needed to finish forward',
      no_dest: 'no ' + settle + ' receive address is saved', confs_unknown: 'the ' + settle + ' explorer could not confirm the lock right now (try again shortly)',
      spent_unclassified: 'the lock was spent but could not be verified as your redeem',
    })[res && res.reason] || 'the swap could not be finished forward';
    show('warn', 'Could not finish forward: ' + why + '. Reclaim your ' + fromCoin + ' below instead.');
    btn.disabled = false;
  } catch (e) { show('bad', 'Finish failed (safe to retry, or Reclaim below): ' + ((e && e.message) || e)); btn.disabled = false; }
}

/** Render a standalone reclaim card into `container` (used on load if a stalled swap exists). */
export function renderRecovery(container, onMsg = () => {}) {
  const rec = getRecovery(); if (!rec || !rec.lockOutpoint) { container.style.display = 'none'; return; }
  renderReclaim(container, rec, (kind, t) => onMsg(kind, t));
  container.style.display = '';
}
