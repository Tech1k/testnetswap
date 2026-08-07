// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the maker-daemon XMR integration: a taker (aliceSwap) drives a full
// tXMR->tBTC swap THROUGH the maker's xmr-handler (quote preamble + per-session
// routing + bobSwap), over mock chains. Real crypto/tx/recovery. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sc from '@testnetswap/swap-core';
import { driver, adaptorswap as as, loadXmrCrypto } from '@testnetswap/swap-xmr';
import { createXmrHandler } from '../src/xmr-handler.js';
import { Stats } from '../src/stats.js';

const btc = sc.btc;
const NET = sc.BTC_TESTNET4;
const enc = (u) => Buffer.from(u).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const addrToScript = (a) => enc(btc.OutScript.encode(btc.Address(NET).decode(a)));

function mockBtc() {
  const outs = {}; const wit = {}; let n = 0;
  return {
    async buildLockFunding({ address, amount }) { const txid = sc.bytesToHex(sc.sha256(fromHex('aa' + (n++).toString(16).padStart(2, '0')))); outs[txid + ':0'] = { value: amount, scriptPubKeyHex: addrToScript(address) }; return { txid, vout: 0, amount, hex: { lock: true, txid } }; },
    async broadcast(h) { if (typeof h !== 'string') return h.txid; const tx = btc.RawTx.decode(fromHex(h)); const inp = tx.inputs[0]; wit[enc(inp.txid) + ':' + inp.index] = tx.witnesses[0].map(enc); return sc.bytesToHex(sc.sha256(fromHex(h))); },
    async waitConfirmed() {},
    async getOutput(txid, vout) { return outs[txid + ':' + vout] || { value: 0, scriptPubKeyHex: '' }; },
    async watchSpend(txid, vout) { const k = txid + ':' + vout; for (let i = 0; i < 600; i++) { if (wit[k]) return wit[k]; await new Promise((r) => setTimeout(r, 50)); } throw new Error('watchSpend timeout ' + k); },
  };
}
function mockXmr() { const locks = {}; return {
  async lock({ address, amount }) { locks[address] = amount; return 'xmrtx'; },
  async waitLocked({ address }) { for (let i = 0; i < 600; i++) { if (locks[address]) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('waitLocked timeout'); },
  async sweep({ dest }) { return ['xmrsweep_' + (dest || '').slice(0, 8)]; },
}; }

// taker transport <-> handler bridge for one session id
function bridge(handler) {
  const SID = 'sid_test_1';
  const takerT = {
    buf: [], w: [],
    send(m) { handler.onMessage(SID, m, (sid, mm) => takerT._deliver(mm)); },
    recv(type, ms = 30000) { const i = this.buf.findIndex((x) => x.type === type); if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]); return new Promise((res, rej) => { const to = setTimeout(() => { const j = this.w.indexOf(w); if (j >= 0) { this.w.splice(j, 1); rej(new Error('recv timeout ' + type)); } }, ms); const w = { type, resolve: (m) => { clearTimeout(to); res(m); } }; this.w.push(w); }); },
    _deliver(m) { const i = this.w.findIndex((w) => w.type === m.type); if (i >= 0) this.w.splice(i, 1)[0].resolve(m); else this.buf.push(m); },
  };
  return { SID, takerT };
}

// deterministic km derivation (mirrors main.js enableXmr), for the C1 test
const _enc = new TextEncoder();
const _cat = (...a) => { let n = 0; for (const u of a) n += u.length; const o = new Uint8Array(n); let p = 0; for (const u of a) { o.set(u, p); p += u.length; } return o; };
const _seed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const makeDeriveKm = (seed) => (sid) => { const share = (t) => { const h = Uint8Array.from(sc.sha256(_cat(seed, _enc.encode('xmr-km|' + sid + '|' + t)))); h[31] &= 0x0f; if (h.every((b) => b === 0)) h[0] = 1; return sc.bytesToHex(h); }; return { mSpend: share('mSpend'), vView: share('vView'), btcKey: share('btcKey'), btcPunishKey: share('btcPunishKey') }; };

test('deterministic km (seed+sid) + durable record persisted then forgotten on completion', async () => {
  const x = await loadXmrCrypto();
  const deriveKm = makeDeriveKm(_seed);
  // deterministic + sid-separated + valid scalars
  assert.deepEqual(deriveKm('sidABC'), deriveKm('sidABC'), 'deriveKm deterministic for a sid');
  assert.notDeepEqual(deriveKm('sidABC'), deriveKm('sidXYZ'), 'different sid -> different km');
  assert.equal(typeof x.ed_pubkey(deriveKm('sidABC').mSpend), 'string', 'derived mSpend is a valid ed scalar');

  const chains = { btc: mockBtc(), xmr: mockXmr() };
  let saved = []; const store = { load: () => saved.slice(), save: (a) => { saved = a; } };
  let makerResult = null;
  const handler = createXmrHandler({
    x, btc, cfg: { xmr: { rate_tbtc_per_xmr: 0.01 } }, log: { info() {}, warn() {}, error() {} },
    makeChains: () => chains, sweepAddrFor: () => 'd', sendCoinNetwork: NET,
    deriveKm, store, onComplete: (sid, r) => { makerResult = r; },
  });
  const { takerT } = bridge(handler);
  takerT.send({ type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5_000_000_000 });
  const quote = await takerT.recv('xmr_quote');
  const aliceKM = as.genKeyMaterial(x);
  const aliceRes = await driver.aliceSwap({ x, btc, transport: takerT, chains, km: aliceKM, params: {
    sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: quote.t1_blocks, t2Blocks: quote.t2_blocks,
    lockAmount: quote.lock_sats, minConf: 0, xmrAmount: quote.xmr_pico, xmrRestoreHeight: 0,
    setupTimeoutMs: 20000, lockTimeoutMs: 20000, redeemTimeoutMs: 20000,
  } });
  assert.equal(aliceRes.state, 'redeemed', 'swap completed with deterministic km');
  for (let i = 0; i < 100 && !makerResult; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(makerResult, 'maker completed bobSwap with deterministic km');
  assert.equal(saved.length, 0, 'durable record forgotten after a provably-settled swap');
});

test('maker xmr-handler drives a full tXMR->tBTC swap with a taker (aliceSwap)', async () => {
  const x = await loadXmrCrypto();
  const chains = { btc: mockBtc(), xmr: mockXmr() };
  let makerResult = null;
  const handler = createXmrHandler({
    x, btc, cfg: { xmr: { rate_tbtc_per_xmr: 0.01, t1_blocks: 72, t2_blocks: 72, min_pico: 1_000_000_000, max_pico: 50_000_000_000 } },
    log: { info() {}, warn() {}, error() {} },
    makeChains: () => chains, sweepAddrFor: () => 'MakerXmrSweepAddr',
    sendCoinNetwork: NET,
    onComplete: (sid, r) => { makerResult = r; },
  });
  const { takerT } = bridge(handler);

  // taker asks for an XMR quote (triggers the maker to start bobSwap), then runs aliceSwap
  takerT.send({ type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5_000_000_000 });
  const quote = await takerT.recv('xmr_quote');
  assert.equal(quote.lock_sats, 5000, 'quote: 0.005 XMR * 0.01 tBTC/XMR = 0.00005 tBTC = 5000 sats');
  const aliceKM = as.genKeyMaterial(x);
  const aliceRes = await driver.aliceSwap({ x, btc, transport: takerT, chains, km: aliceKM, params: {
    sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: quote.t1_blocks, t2Blocks: quote.t2_blocks,
    lockAmount: quote.lock_sats, minConf: 0, xmrAmount: quote.xmr_pico, xmrRestoreHeight: 0,
    setupTimeoutMs: 20000, lockTimeoutMs: 20000, redeemTimeoutMs: 20000,
  } });

  assert.equal(aliceRes.state, 'redeemed', 'taker redeemed BTC via the maker handler');
  // maker (bobSwap inside the handler) recovered + swept
  for (let i = 0; i < 100 && !makerResult; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(makerResult, 'maker handler completed bobSwap');
  assert.equal(x.ed_pubkey(makerResult.combinedSpendPriv), makerResult.moneroSpendPub, 'maker holds the combined Monero key (can sweep)');
});

test('xmr-handler: authenticated resume re-sends the released adaptor to a NEW sid; rejects bad sig / unknown outpoint', async () => {
  const x = await loadXmrCrypto();
  // Controllable btc mock: watchSpend blocks until released, so the maker HOLDS at redeem_released
  // (adaptor released + persisted + outpoint indexed), exactly the state a taker resume recovers.
  const outs = {}, wit = {}; let n = 0, released = false;
  const cbtc = {
    async buildLockFunding({ address, amount }) { const txid = sc.bytesToHex(sc.sha256(fromHex('bb' + (n++).toString(16).padStart(2, '0')))); outs[txid + ':0'] = { value: amount, scriptPubKeyHex: addrToScript(address) }; return { txid, vout: 0, amount, hex: { lock: true, txid } }; },
    async broadcast(h) { if (typeof h !== 'string') return h.txid; const tx = btc.RawTx.decode(fromHex(h)); const inp = tx.inputs[0]; wit[enc(inp.txid) + ':' + inp.index] = tx.witnesses[0].map(enc); return sc.bytesToHex(sc.sha256(fromHex(h))); },
    async waitConfirmed() {}, async getOutput(txid, vout) { return outs[txid + ':' + vout] || { value: 0, scriptPubKeyHex: '' }; },
    watchSpend() { return new Promise((_, rej) => { const t = setInterval(() => { if (released) { clearInterval(t); rej(new Error('watch released')); } }, 10); }); },
  };
  const chains = { btc: cbtc, xmr: mockXmr() };
  let saved = []; const store = { load: () => saved.slice(), save: (a) => { saved = a; } };
  let makerErrored; const erroredP = new Promise((res) => { makerErrored = res; });
  const handler = createXmrHandler({
    x, btc, cfg: { xmr: { rate_tbtc_per_xmr: 0.01 } }, log: { info() {}, warn() {}, error() {} },
    makeChains: () => chains, sweepAddrFor: () => 'd', sendCoinNetwork: NET, store,
    sha256: sc.sha256, bytesToHex: sc.bytesToHex, onError: () => makerErrored('errored'),
  });
  // Bridge that DROPS the maker's redeem_adaptor so aliceSwap never redeems.
  const SID = 'orig_sid';
  const takerT = {
    buf: [], w: [],
    send(m) { handler.onMessage(SID, m, (sid, mm) => { if (mm.type === 'redeem_adaptor') return; takerT._deliver(mm); }); },
    recv(type, ms = 30000) { const i = this.buf.findIndex((z) => z.type === type); if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]); return new Promise((res, rej) => { const to = setTimeout(() => { const j = this.w.indexOf(w); if (j >= 0) { this.w.splice(j, 1); rej(new Error('recv timeout ' + type)); } }, ms); const w = { type, resolve: (mm) => { clearTimeout(to); res(mm); } }; this.w.push(w); }); },
    _deliver(m) { const i = this.w.findIndex((w) => w.type === m.type); if (i >= 0) this.w.splice(i, 1)[0].resolve(m); else this.buf.push(m); },
  };
  takerT.send({ type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5_000_000_000 });
  const quote = await takerT.recv('xmr_quote');
  const aliceKM = as.genKeyMaterial(x);
  const aliceP = driver.aliceSwap({ x, btc, transport: takerT, chains, km: aliceKM, params: {
    sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: quote.t1_blocks, t2Blocks: quote.t2_blocks,
    lockAmount: quote.lock_sats, minConf: 0, xmrAmount: quote.xmr_pico, xmrRestoreHeight: 0,
    setupTimeoutMs: 20000, lockTimeoutMs: 20000, redeemTimeoutMs: 3000,
  } }).catch(() => 'gave-up'); // parks on the dropped adaptor, then times out (expected)

  let rec = null;
  for (let i = 0; i < 300; i++) { rec = saved.find((r) => r.phase === 'redeem_released' && r.unwind && r.unwind.redeemAdaptor); if (rec) break; await new Promise((r) => setTimeout(r, 15)); }
  assert.ok(rec, 'maker reached redeem_released with the adaptor persisted + outpoint indexed');
  const { lockTxid, lockVout } = rec.unwind;
  const challenge = (sid) => sc.bytesToHex(sc.sha256(new TextEncoder().encode('testnetswap/xmr-resume/v1|' + lockTxid + '|' + lockVout + '|' + sid)));

  // (a) valid resume on a NEW sid -> re-sends the EXACT persisted adaptor to that sid
  const o1 = [];
  await handler.onMessage('newsid1', { type: 'xmr_resume', lockTxid, lockVout, sig: x.ecdsa_sign(aliceKM.btcKey, challenge('newsid1')) }, (sid, m) => o1.push({ sid, m }));
  assert.equal(o1.length, 1, 'valid resume replied once');
  assert.equal(o1[0].sid, 'newsid1', 'delivered to the requesting new sid');
  assert.equal(o1[0].m.type, 'redeem_adaptor');
  assert.equal(o1[0].m.adaptor, rec.unwind.redeemAdaptor, 're-sent the exact already-released adaptor');
  // (b) a signature bound to a DIFFERENT sid must not verify for this sid (replay defense)
  const o2 = [];
  await handler.onMessage('newsid2', { type: 'xmr_resume', lockTxid, lockVout, sig: x.ecdsa_sign(aliceKM.btcKey, challenge('OTHER')) }, (sid, m) => o2.push(m));
  assert.equal(o2.length, 0, 'sid-bound signature replay rejected');
  // (c) a signature from the WRONG key is rejected
  const o3 = [];
  await handler.onMessage('newsid3', { type: 'xmr_resume', lockTxid, lockVout, sig: x.ecdsa_sign(as.genKeyMaterial(x).btcKey, challenge('newsid3')) }, (sid, m) => o3.push(m));
  assert.equal(o3.length, 0, 'wrong-key signature rejected');
  // (d) unknown outpoint -> O(1) drop, no reply
  const o4 = [];
  await handler.onMessage('newsid4', { type: 'xmr_resume', lockTxid: 'ee'.repeat(32), lockVout: 0, sig: '00' }, (sid, m) => o4.push(m));
  assert.equal(o4.length, 0, 'unknown outpoint dropped');
  // (e) resume never advanced/aborted the in-flight swap
  assert.equal(saved.find((r) => r.unwind && r.unwind.lockTxid === lockTxid).phase, 'redeem_released', 'resume left the swap untouched');

  released = true; // release watchSpend so bobSwap unwinds + settles cleanly
  await Promise.allSettled([aliceP, erroredP]);
});

test('xmr-handler rejects unsupported pair / out-of-range amount', async () => {
  const x = await loadXmrCrypto();
  const handler = createXmrHandler({ x, btc, cfg: { xmr: {} }, log: { info() {}, warn() {}, error() {} }, makeChains: () => ({}), sweepAddrFor: () => 'd', sendCoinNetwork: NET });
  const out = [];
  await handler.onMessage('s1', { type: 'xmr_request_quote', from: 'tBTC', to: 'tLTC', send_pico: 5e9 }, (sid, m) => out.push(m));
  assert.equal(out[0].type, 'xmr_error');
  const out2 = [];
  await handler.onMessage('s2', { type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 1 }, (sid, m) => out2.push(m));
  assert.equal(out2[0].type, 'xmr_error', 'amount out of range');
  // Within [min_pico, max_pico] but the tBTC settle lock (1500 sats) is below the adaptor unwind
  // floor (546 + 2*1000 = 2546): must be refused up front, not fail mid-swap on a dust unwind.
  const out3 = [];
  await handler.onMessage('s3', { type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 1_500_000_000 }, (sid, m) => out3.push(m));
  assert.equal(out3[0].type, 'xmr_error', 'settle lock below the adaptor dust floor');
});

test('settle routing: a tLTC-configured maker quotes tXMR -> tLTC with the tLTC rate', async () => {
  const x = await loadXmrCrypto();
  const handler = createXmrHandler({
    x, btc, cfg: { xmr: { rate_tbtc_per_xmr: 0.01 } }, log: { info() {}, warn() {}, error() {} },
    makeChains: () => ({}), sweepAddrFor: () => 'd', supportedNetworks: ['testnet'],
    settleCoins: ['tBTC', 'tLTC'],
    sendCoinNetworkFor: (s) => (s === 'tLTC' ? sc.LTC_TESTNET : sc.BTC_TESTNET4),
    rateFor: (s) => (s === 'tLTC' ? 0.7 : 0.01),           // 1 XMR = 0.7 tLTC
  });
  const { takerT } = bridge(handler);
  takerT.send({ type: 'xmr_request_quote', from: 'tXMR', to: 'tLTC', send_pico: 5_000_000_000, quote_only: true });
  const q = await takerT.recv('xmr_quote');
  assert.equal(q.to, 'tLTC', 'quote settles to tLTC');
  assert.equal(q.rate, 0.7, 'uses the tLTC rate, not the tBTC one');
  assert.equal(q.lock_sats, Math.round(0.005 * 0.7 * 1e8), 'lock_sats computed with the tLTC rate');
  // L5: tLTC settle must floor the CSV to the LTC-appropriate 288 blocks (~12h), not inherit tBTC's 72
  assert.equal(q.t1_blocks, 288, 'tLTC settle floors t1 to 288 blocks');
  assert.equal(q.t2_blocks, 288, 'tLTC settle floors t2 to 288 blocks');
  // ...while the tBTC settle path stays at the 72-block default
  const outB = [];
  await handler.onMessage('sB', { type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5_000_000_000, quote_only: true }, (s, m) => outB.push(m));
  const qb = outB.find((m) => m.type === 'xmr_quote');
  assert.ok(qb, 'tBTC quote produced');
  assert.equal(qb.t1_blocks, 72, 'tBTC settle stays at 72 blocks');
  assert.equal(qb.t2_blocks, 72, 'tBTC settle t2 stays at 72 blocks');
  // a settle coin the maker does not serve is rejected
  const out = [];
  await handler.onMessage('sX', { type: 'xmr_request_quote', from: 'tXMR', to: 'tDOGE', send_pico: 5e9 }, (s, m) => out.push(m));
  assert.equal(out[0].type, 'xmr_error', 'unsupported settle coin rejected');
});

test('xmr-handler quote_only previews without starting a swap', async () => {
  const x = await loadXmrCrypto();
  let chainsCalls = 0;
  const handler = createXmrHandler({ x, btc, cfg: { xmr: { rate_tbtc_per_xmr: 0.01 } }, log: { info() {}, warn() {}, error() {} }, makeChains: () => { chainsCalls++; return {}; }, sweepAddrFor: () => 'd', sendCoinNetwork: NET });
  const out = [];
  await handler.onMessage('qs', { type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5_000_000_000, quote_only: true }, (sid, m) => out.push(m));
  assert.equal(out[0].type, 'xmr_quote');
  assert.equal(out[0].network, 'testnet', 'quote echoes the Monero network');
  assert.equal(chainsCalls, 0, 'quote_only never builds chains / starts bobSwap');
  // the session was freed, so a fresh request on the same sid is accepted (not "already in progress")
  const out2 = [];
  await handler.onMessage('qs', { type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5_000_000_000, quote_only: true }, (sid, m) => out2.push(m));
  assert.equal(out2[0].type, 'xmr_quote', 'session was released after the preview');
});

test('xmr-handler serves only its configured networks (tXMR/sXMR ticker -> Monero network)', async () => {
  const x = await loadXmrCrypto();
  const base = { x, btc, cfg: { xmr: { rate_tbtc_per_xmr: 0.01 } }, log: { info() {}, warn() {}, error() {} }, makeChains: () => ({}), sweepAddrFor: () => 'd', sendCoinNetwork: NET };
  // testnet-only maker: rejects sXMR (stagenet), serves tXMR as testnet
  const tOnly = createXmrHandler({ ...base, supportedNetworks: ['testnet'] });
  const a = []; await tOnly.onMessage('n1', { type: 'xmr_request_quote', from: 'sXMR', to: 'tBTC', send_pico: 5e9, quote_only: true }, (sid, m) => a.push(m));
  assert.equal(a[0].type, 'xmr_error', 'testnet-only maker rejects sXMR');
  const b = []; await tOnly.onMessage('n2', { type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5e9, quote_only: true }, (sid, m) => b.push(m));
  assert.equal(b[0].network, 'testnet', 'tXMR -> testnet');
  // both-networks maker: sXMR quotes on stagenet
  const both = createXmrHandler({ ...base, supportedNetworks: ['testnet', 'stagenet'] });
  const c = []; await both.onMessage('n3', { type: 'xmr_request_quote', from: 'sXMR', to: 'tBTC', send_pico: 5e9, quote_only: true }, (sid, m) => c.push(m));
  assert.equal(c[0].type, 'xmr_quote'); assert.equal(c[0].network, 'stagenet', 'sXMR -> stagenet quote');
});

test('a settled XMR swap is recorded into cumulative stats EXACTLY once (completed + by_pair, not twice)', async () => {
  const x = await loadXmrCrypto();
  const chains = { btc: mockBtc(), xmr: mockXmr() };
  // real Stats over an in-memory 1-element-array store (mirrors FileStore('stats.json'))
  let statsCell = [null]; const statsStore = { load: () => statsCell.slice(), save: (a) => { statsCell = a; } };
  const stats = new Stats(statsStore);
  // durable xmr-swap store, capturing every persisted snapshot so we can assert the `counted` guard
  let xmrSaved = []; const savedSnaps = [];
  const xmrStore = { load: () => xmrSaved.map((r) => ({ ...r })), save: (a) => { xmrSaved = a.map((r) => ({ ...r })); savedSnaps.push(a.map((r) => ({ ...r }))); } };
  const recorded = [];
  const handler = createXmrHandler({
    x, btc, cfg: { xmr: { rate_tbtc_per_xmr: 0.01 } }, log: { info() {}, warn() {}, error() {} },
    makeChains: () => chains, sweepAddrFor: () => 'd', sendCoinNetwork: NET, store: xmrStore,
    recordStat: (swap) => { recorded.push(swap); stats.record(swap); },
  });
  const { takerT } = bridge(handler);
  takerT.send({ type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico: 5_000_000_000 });
  const quote = await takerT.recv('xmr_quote');
  const aliceKM = as.genKeyMaterial(x);
  const aliceRes = await driver.aliceSwap({ x, btc, transport: takerT, chains, km: aliceKM, params: {
    sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: quote.t1_blocks, t2Blocks: quote.t2_blocks,
    lockAmount: quote.lock_sats, minConf: 0, xmrAmount: quote.xmr_pico, xmrRestoreHeight: 0,
    setupTimeoutMs: 20000, lockTimeoutMs: 20000, redeemTimeoutMs: 20000,
  } });
  assert.equal(aliceRes.state, 'redeemed', 'taker redeemed BTC via the maker handler');
  // wait for the maker's bobSwap + recordTerminal to run
  for (let i = 0; i < 200 && recorded.length === 0; i++) await new Promise((r) => setTimeout(r, 20));

  // recorded EXACTLY once, with the right shape (XMR volume stays in PICO; settle stays in SATS)
  assert.equal(recorded.length, 1, 'recordStat invoked exactly once for the settled swap');
  const s = recorded[0];
  assert.equal(s.state, 'completed', 'maker swept XMR -> completed');
  assert.equal(s.from, 'tXMR'); assert.equal(s.to, 'tBTC');
  assert.equal(s.sendSats, quote.xmr_pico, 'XMR volume recorded in PICO (not converted to sats)');
  assert.equal(s.recvSats, quote.lock_sats, 'settle volume recorded in SATS');

  // stats reflect the single completed swap
  const snap = stats.snapshot();
  assert.equal(snap.completed, 1, 'completed == 1');
  assert.equal(snap.by_pair['tXMR->tBTC'], 1, "by_pair['tXMR->tBTC'] == 1");
  assert.equal(snap.volume.tXMR, quote.xmr_pico, 'tXMR volume in PICO');
  assert.equal(snap.volume.tBTC, quote.lock_sats, 'tBTC volume in SATS');

  // idempotency guard: a `counted`-flagged record was persisted BEFORE recording, and the durable
  // record is forgotten once settled, so resume()/retries can never re-count it.
  assert.ok(savedSnaps.some((snap2) => snap2.some((r) => r.counted === true)), 'record flagged counted (persisted) at/ before recording');
  assert.equal(xmrSaved.length, 0, 'durable record forgotten after a provably-settled swap');

  // resume() is THE path that re-processes records after a restart; over the now-forgotten record it
  // must NOT record the swap a second time.
  await handler.resume();
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(recorded.length, 1, 'resume() did not re-record the settled swap');
  assert.equal(stats.snapshot().completed, 1, 'completed still 1 after a repeated terminal pass');
});
