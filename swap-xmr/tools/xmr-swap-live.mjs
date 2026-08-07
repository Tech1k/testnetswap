// SPDX-License-Identifier: AGPL-3.0-or-later
// LIVE end-to-end orchestrated tXMR -> tBTC swap: runs the REAL bobSwap + aliceSwap
// drivers over an in-memory transport against REAL chains (esplora for BTC, monero-ts
// for XMR). Bob = maker (BTC provider), Alice = taker (XMR provider). Slow (~1h:
// Monero 10-block unlock to spend the faucet output + to sweep). Funds from CypherFaucet.
//   node tools/xmr-swap-live.mjs
import { createRequire } from 'node:module';
import moneroTs from 'monero-ts';
import * as btc from '../../swap-core/vendor/btc-signer.mjs';
import * as sc from '../../swap-core/src/index.js';
import * as as from '../src/adaptorswap.js';
import * as driver from '../src/driver.js';
import * as adapters from '../src/adapters.js'; // M10: use the REAL (fixed) adapters, not a fork

const require = createRequire(import.meta.url);
const x = require('../crypto/pkg-node/swap_xmr_crypto.js');
const NET = sc.BTC_TESTNET4, API = sc.COINS.tBTC.api;
const XMR_NODE = 'https://xmr-testnet-node.librenode.com', XMR_NET = 'testnet';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (u) => Buffer.from(u).toString('hex'), fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const LOCK_SATS = 40000, XMR_PICO = 5_000_000_000n;

async function get(p) { const r = await fetch(API + p); const t = await r.text(); if (!r.ok) throw new Error(`GET ${p}: ${r.status} ${t}`); try { return JSON.parse(t); } catch { return t; } }
async function post(p, body) { const r = await fetch(API + p, { method: 'POST', body }); const t = (await r.text()).trim(); if (!r.ok) throw new Error(`POST ${p}: ${t}`); return t; }
async function faucetOnce(network, address) { const r = await fetch('https://cypherfaucet.com/api/v1/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network, address }) }); return [r.status, await r.text()]; }
// Retry the faucet on transient failures (503 send_failed / 429 rate / network); it's flaky.
async function faucet(network, address, tries = 12, waitMs = 30000) {
  let last = [0, ''];
  for (let i = 0; i < tries; i++) {
    try { last = await faucetOnce(network, address); } catch (e) { last = [0, String(e.message || e)]; }
    if (last[0] === 200) return last;
    log(`  faucet ${network} ${i + 1}/${tries}: ${last[0]} ${String(last[1]).slice(0, 120)}`);
    await sleep(waitMs);
  }
  return last; // caller logs; the subsequent waitUtxo/unlocked-wait still gives it a chance if a prior claim lands
}
async function retry(label, fn, tries = 8, waitMs = 20000) { for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { log(`  retry ${label} ${i + 1}/${tries}: ${e.message}`); await sleep(waitMs); } } throw new Error(label + ' failed'); }

// ---- in-memory transport pair ----
class T { constructor() { this.peer = null; this.buf = []; this.w = []; }
  send(m) { queueMicrotask(() => this.peer._d(JSON.parse(JSON.stringify(m)))); }
  _d(m) { const i = this.w.findIndex((w) => w.type === m.type); if (i >= 0) this.w.splice(i, 1)[0].resolve(m); else this.buf.push(m); }
  recv(type, ms = 1.8e6) { const i = this.buf.findIndex((m) => m.type === type); if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, resolve: res }; this.w.push(w); setTimeout(() => { const j = this.w.indexOf(w); if (j >= 0) { this.w.splice(j, 1); rej(new Error('recv timeout ' + type)); } }, ms); }); } }
function pair() { const a = new T(), b = new T(); a.peer = b; b.peer = a; return [a, b]; }

const main = async () => {
  // Keys: random per run by default; or STABLE from env so a flaky-faucet run can be
  // pre-funded once and re-run (BOB_FUND_KEY / ALICE_XMR_KEY = 64-hex).
  const bobFundKey = process.env.BOB_FUND_KEY || x.gen_secret_share();
  const aliceXmrKey = process.env.ALICE_XMR_KEY || x.gen_secret_share();
  const aliceBtcDestKey = x.gen_secret_share();
  const bobKM = as.genKeyMaterial(x), aliceKM = as.genKeyMaterial(x);
  // M10: the SAME production adapters the maker uses (fixed waitConfirmed/getUnlockedBalance/
  // multi-UTXO/findSpend), so this live run actually exercises shipped code.
  const btcChain = adapters.esploraBtcChain({ btc, sc, x, api: API, network: NET, fundKeyHex: bobFundKey, feeRate: 2 });
  log('Bob BTC funding addr:', btcChain.fundAddr, process.env.BOB_FUND_KEY ? '(stable, from env)' : '');

  // Fund Bob's BTC; skip the faucet if it's already funded (lets you pre-fund a stable
  // address when the faucet is down), then wait for a CONFIRMED utxo (buildLockFunding needs it).
  const bobNeed = LOCK_SATS + 2000;
  if (await hasConfirmedUtxo(btcChain.fundAddr, bobNeed)) { log('Bob already funded, skipping faucet'); }
  else {
    log('faucet tBTC -> Bob…', ...(await faucet('btc-testnet', btcChain.fundAddr)));
    try { await waitUtxo(btcChain.fundAddr); } catch (e) {
      throw new Error(`Bob not funded (faucet down?). Pre-fund ${btcChain.fundAddr} with >= ${bobNeed} sats from any tBTC source, set BOB_FUND_KEY=${bobFundKey}, and re-run. (${e.message})`);
    }
  }
  await btcChain.waitConfirmed(await waitUtxo(btcChain.fundAddr), 1).catch(() => {});

  // Alice's XMR funding wallet (stable key if ALICE_XMR_KEY set) + Bob's XMR sweep dest
  const startH = await xmrHeight();
  const aliceRestore = process.env.ALICE_XMR_KEY ? 1 : startH; // a pre-funded key needs an earlier scan height
  const aliceXmrWallet = moneroTs.createWalletFull({ networkType: moneroTs.MoneroNetworkType.TESTNET, server: { uri: XMR_NODE }, privateSpendKey: aliceXmrKey, restoreHeight: aliceRestore, password: '' });
  const aliceXmrAddr = await (await aliceXmrWallet).getPrimaryAddress();
  const bobSweepWallet = await moneroTs.createWalletFull({ networkType: moneroTs.MoneroNetworkType.TESTNET, server: { uri: XMR_NODE }, privateSpendKey: x.gen_secret_share(), restoreHeight: startH, password: '' });
  const bobSweepDest = await bobSweepWallet.getPrimaryAddress(); await bobSweepWallet.close();
  log('Alice XMR addr:', aliceXmrAddr, process.env.ALICE_XMR_KEY ? '(stable, from env)' : '');
  // request the faucet (harmless if already funded; the unlocked-balance wait below decides)
  log('faucet tXMR -> Alice…', ...(await faucet('xmr-testnet', aliceXmrAddr)));
  // wait for Alice's faucet XMR to be SPENDABLE (unlocked = 10 confs), not merely seen
  { const aw = await aliceXmrWallet; const need = XMR_PICO + 100_000_000n;
    let okUnlocked = false;
    for (let i = 0; i < 300; i++) { try { await aw.sync(); const u = await aw.getUnlockedBalance(); if (u >= need) { okUnlocked = true; break; } if (i % 3 === 0) log(`  alice tXMR: balance=${await aw.getBalance()} unlocked=${u}`); } catch (e) { log('  alice sync:', e.message); } await sleep(20000); }
    if (!okUnlocked) throw new Error('alice tXMR never unlocked'); }
  log('Alice tXMR unlocked; starting the orchestrated swap');

  const xmr = adapters.moneroXmrEngine({ moneroTs, node: XMR_NODE, networkType: moneroTs.MoneroNetworkType.TESTNET, fundWallet: aliceXmrWallet });
  const [ta, tb] = pair();
  const common = { sendCoinNetwork: NET, moneroNetwork: XMR_NET, t1Blocks: 72, t2Blocks: 72, lockAmount: LOCK_SATS, minConf: 1, xmrAmount: Number(XMR_PICO), xmrRestoreHeight: startH };
  const [bobRes, aliceRes] = await Promise.all([
    driver.bobSwap({ x, btc, transport: tb, chains: { btc: btcChain, xmr }, km: bobKM, params: { ...common, xmrSweepDest: bobSweepDest } }),
    driver.aliceSwap({ x, btc, transport: ta, chains: { btc: btcChain, xmr }, km: aliceKM, params: { ...common, aliceBtcDest: btc.p2wpkh(fromHex(x.secp_pubkey(aliceBtcDestKey)), NET).address } }),
  ]);
  log('✓ Alice redeemed BTC:', aliceRes.redeemTxid);
  log('✓ Bob swept XMR:', bobRes.sweepTxids.join(','));
  log('DONE. Full live orchestrated tXMR -> tBTC swap complete.');
  process.exit(0);
};
async function waitUtxo(addr) { for (let i = 0; i < 40; i++) { try { const u = await get(`/address/${addr}/utxo`); if (u.length) return u[0].txid; } catch {} await sleep(5000); } throw new Error('no utxo ' + addr); }
async function hasConfirmedUtxo(addr, minSats) { try { const u = await get(`/address/${addr}/utxo`); return (u || []).filter((o) => o.status && o.status.confirmed).reduce((s, o) => s + o.value, 0) >= minSats; } catch { return false; } }
async function xmrHeight() { const w = await moneroTs.createWalletFull({ networkType: moneroTs.MoneroNetworkType.TESTNET, server: { uri: XMR_NODE }, password: '' }); const h = Number(await w.getDaemonHeight()); await w.close(); return h; }
main().catch((e) => { log('ERR', e.message); process.exit(1); });
