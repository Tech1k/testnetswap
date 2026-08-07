// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the REAL async role drivers (bobSwap + aliceSwap) concurrently over a mock
// relay + mock chains, proving the full live sequence: setup -> unwind handshake
// -> fund-last -> XMR lock -> redeem-adaptor-after-lock -> redeem -> recover m_a.
// Real crypto + real BTC tx construction + real witness recovery. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as btc from '../../swap-core/vendor/btc-signer.mjs';
import * as sc from '../../swap-core/src/index.js';
import * as as from '../src/adaptorswap.js';
import * as btcswap from '../src/btcswap.js';
import * as driver from '../src/driver.js';

const require = createRequire(import.meta.url);
const x = require('../crypto/pkg-node/swap_xmr_crypto.js');
const NET = sc.BTC_TESTNET4;
const enc = (u) => Buffer.from(u).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const rev = (h) => Buffer.from(h, 'hex').reverse().toString('hex');
const addrToScript = (a) => enc(btc.OutScript.encode(btc.Address(NET).decode(a)));

// ---- in-memory transport pair ----
class T {
  constructor() { this.peer = null; this.buf = []; this.waiters = []; }
  send(msg) { queueMicrotask(() => this.peer._deliver(JSON.parse(JSON.stringify(msg)))); }
  _deliver(msg) { const i = this.waiters.findIndex((w) => w.type === msg.type); if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg); else this.buf.push(msg); }
  recv(type, timeoutMs = 30000) {
    const i = this.buf.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { const w = { type, resolve }; this.waiters.push(w); setTimeout(() => { const j = this.waiters.indexOf(w); if (j >= 0) { this.waiters.splice(j, 1); reject(new Error('recv timeout ' + type)); } }, timeoutMs); });
  }
}
function pair() { const a = new T(), b = new T(); a.peer = b; b.peer = a; return [a, b]; }

// ---- mock BTC chain (shared) ----
function mockBtc() {
  const outs = {}; const wit = {}; let n = 0;
  return {
    async buildLockFunding({ address, amount }) { const txid = sc.bytesToHex(sc.sha256(fromHex('aa' + (n++).toString(16).padStart(2, '0')))); outs[txid + ':0'] = { value: amount, scriptPubKeyHex: addrToScript(address) }; return { txid, vout: 0, amount, hex: { lock: true, txid } }; },
    async broadcast(hexOrLock) {
      if (typeof hexOrLock !== 'string') return hexOrLock.txid; // the (unbroadcast) lock marker
      const tx = btc.RawTx.decode(fromHex(hexOrLock)); const inp = tx.inputs[0];
      wit[enc(inp.txid) + ':' + inp.index] = tx.witnesses[0].map(enc); // @scure decodes txid in display order

      return sc.bytesToHex(sc.sha256(fromHex(hexOrLock))); // synthetic txid
    },
    async waitConfirmed() { /* instant in the mock */ },
    async getOutput(txid, vout) { return outs[txid + ':' + vout] || { value: 0, scriptPubKeyHex: '' }; },
    async getSpend(txid, vout) { const w = wit[txid + ':' + vout]; return w ? { spent: true, txid: 'spender', witness: w } : { spent: false }; },
    async txConfs() { return 1; }, // shallow lock -> the live-redeem margin guard (t1-1) has ample headroom
    async watchSpend(txid, vout) { const key = txid + ':' + vout; for (let i = 0; i < 600; i++) { if (wit[key]) return wit[key]; await new Promise((r) => setTimeout(r, 50)); } throw new Error('watchSpend timeout ' + key); },
  };
}

// ---- mock XMR engine (lock/detect/sweep; key validity asserted at the driver result) ----
function mockXmr() {
  const locks = {};
  return {
    async lock({ address, amount }) { locks[address] = amount; return 'xmrtx_' + address.slice(0, 8); },
    async waitLocked({ address }) { for (let i = 0; i < 50; i++) { if (locks[address]) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('waitLocked timeout'); },
    async sweep({ dest }) { return ['xmrsweep_' + (dest || 'dest').slice(0, 8)]; },
  };
}

test('full live driver flow (tXMR->tBTC): both roles complete concurrently over a mock relay', async () => {
  const [ta, tb] = pair();
  const chains = { btc: mockBtc(), xmr: mockXmr() };
  const bobKM = as.genKeyMaterial(x), aliceKM = as.genKeyMaterial(x);
  // Alice's REAL receive address, distinct from her derived swap p2wpkh. The maker must build the redeem
  // adaptor over THIS address (threaded via the bundle), or adaptor_verify fails on Alice's side. Before
  // that fix the maker signed the derived address while Alice redeemed to aliceBtcDest -> "bob redeem
  // adaptor invalid". Setting it here (as production does) is the regression guard.
  const aliceBtcDest = btc.p2wpkh(fromHex(as.publicBundle(x, as.genKeyMaterial(x)).btcPub), NET).address;
  const common = { sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72, lockAmount: 100000, minConf: 1, xmrAmount: 5_000_000_000, xmrRestoreHeight: 0, setupTimeoutMs: 10000, lockTimeoutMs: 10000, redeemTimeoutMs: 10000 };
  const broadcasts = [];
  const origB = chains.btc.broadcast.bind(chains.btc);
  chains.btc.broadcast = async (h) => { if (typeof h === 'string') broadcasts.push(h); return origB(h); };

  const [bobRes, aliceRes] = await Promise.all([
    driver.bobSwap({ x, btc, transport: tb, chains, km: bobKM, params: { ...common, xmrSweepDest: 'BobXmrDest' } }),
    driver.aliceSwap({ x, btc, transport: ta, chains, km: aliceKM, params: { ...common, aliceBtcDest } }),
  ]);

  assert.equal(aliceRes.state, 'redeemed', 'Alice redeemed her BTC');
  assert.ok(aliceRes.redeemTxid);
  const redeemHex = broadcasts.find((h) => { try { return enc(btc.RawTx.decode(fromHex(h)).outputs[0].script) === addrToScript(aliceBtcDest); } catch { return false; } });
  assert.ok(redeemHex, 'the redeem pays Alice\'s real receive address (maker built the adaptor over it)');
  assert.equal(bobRes.state, 'completed', 'Bob recovered m_a and swept the XMR');
  assert.equal(x.ed_pubkey(bobRes.combinedSpendPriv), bobRes.moneroSpendPub, 'Bob holds the combined key for the lock address');
  assert.ok(bobRes.sweepTxids.length > 0);
});

test('bobSwap aborts (no BTC locked) if Alice sends an invalid redeem address', async () => {
  const [ta, tb] = pair();
  const chains = { btc: mockBtc(), xmr: mockXmr() };
  const bobKM = as.genKeyMaterial(x), aliceKM = as.genKeyMaterial(x);
  const common = { sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72, lockAmount: 100000, minConf: 1, xmrAmount: 5_000_000_000, xmrRestoreHeight: 0, setupTimeoutMs: 5000 };
  let locked = false;
  chains.btc.broadcast = async (h) => { if (typeof h !== 'string') locked = true; return typeof h === 'string' ? 'tx' : h.txid; };
  // Alice sends a valid bundle but a garbage redeem address.
  ta.send({ type: 'bundle', bundle: as.publicBundle(x, aliceKM), redeemAddr: 'not-a-real-address' });
  await assert.rejects(driver.bobSwap({ x, btc, transport: tb, chains, km: bobKM, params: { ...common, xmrSweepDest: 'd' } }), /redeem address invalid/);
  assert.equal(locked, false, 'Bob never locked BTC for an unredeemable swap');
});

test('driver aborts the swap if the counterparty bundle is invalid (no funding)', async () => {
  const [ta, tb] = pair();
  const chains = { btc: mockBtc(), xmr: mockXmr() };
  const bobKM = as.genKeyMaterial(x);
  const common = { sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72, lockAmount: 100000, minConf: 1, xmrAmount: 5_000_000_000, xmrRestoreHeight: 0, setupTimeoutMs: 5000 };
  let funded = false;
  chains.btc.buildLockFunding = async (a) => { funded = true; return { txid: 'x', vout: 0, amount: a.amount, hex: { lock: true, txid: 'x' } }; };
  // Alice sends a bundle with a tampered M (DLEQ won't verify)
  const aliceKM = as.genKeyMaterial(x); const badBundle = { ...as.publicBundle(x, aliceKM), M: x.ed_pubkey(x.gen_secret_share()) };
  ta.send({ type: 'bundle', bundle: badBundle });
  await assert.rejects(driver.bobSwap({ x, btc, transport: tb, chains, km: bobKM, params: { ...common, xmrSweepDest: 'd' } }), /bad alice bundle/);
  assert.equal(funded, false, 'Bob never funded after a bad bundle');
});

// ---- reclaim-or-punish: build the real cancel/refund material, then drive both outcomes ----
function reclaimSetup() {
  const bobKM = as.genKeyMaterial(x), aliceKM = as.genKeyMaterial(x);
  const bob = as.publicBundle(x, bobKM), alice = as.publicBundle(x, aliceKM);
  const common = { sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72 };
  const ctx = as.sharedContext(x, btc, { alice, bob, ...common });
  const lockAmount = 100000, lockTxid = sc.bytesToHex(sc.sha256(fromHex('deadbeef01'))), lockVout = 0;
  const cancel = as.cancelTemplate(btc, { ctx, lockTxid, lockVout, lockAmount, network: NET });
  const bSig = as.makeCancelPreSig(x, { btcKey: bobKM.btcKey, cancelSighash: cancel.sighashHex });
  const aSig = as.makeCancelPreSig(x, { btcKey: aliceKM.btcKey, cancelSighash: cancel.sighashHex });
  const cancelFinal = btcswap.finalize2of2(btc, cancel.tx, ctx.btcLock.witnessScript, aSig, bSig);
  const cancelAmount = lockAmount - 1000;
  const bobDest = btc.p2wpkh(fromHex(bob.btcPub), NET).address, aliceDest = btc.p2wpkh(fromHex(alice.btcPub), NET).address;
  const refund = as.refundTemplate(btc, { ctx, cancelTxid: cancelFinal.txid, cancelVout: 0, cancelAmount, cancelScriptPubKeyHex: cancel.cancelScriptPubKeyHex, bobDest, network: NET });
  const refundAdaptor = as.makeRefundAdaptor(x, { aliceBtcKey: aliceKM.btcKey, bobPb: bob.P, refundSighash: refund.sighashHex });
  const refundFinal = as.bobFinalizeRefund(x, btc, { tx: refund.tx, ctx, bobBtcKey: bobKM.btcKey, bobMSpend: bobKM.mSpend, refundSighash: refund.sighashHex, aliceRefundAdaptor: refundAdaptor, aliceBtcPub: alice.btcPub, bobPb: bob.P });
  const refundWit = btc.RawTx.decode(fromHex(refundFinal.hex)).witnesses[0].map(enc);
  return { bobKM, aliceKM, bob, alice, ctx, lockTxid, lockVout, lockAmount, aSig, bSig, cancelFinal, cancelAmount, aliceDest, refundAdaptor, refundSighash: refund.sighashHex, refundWit };
}

test('aliceReclaimOrPunish: maker withholds tx_cancel -> Alice self-broadcasts it (independent exit) and reclaims', async () => {
  const s = reclaimSetup();
  const broadcasts = [];
  let cancelSelfBroadcast = false;
  const chains = {
    xmr: { async sweep() { return ['xmrsweep']; } },
    btc: {
      async broadcast(hex) { broadcasts.push(hex); if (hex === s.cancelFinal.hex) cancelSelfBroadcast = true; return 'tx' + broadcasts.length; },
      async findSpend(txid) {
        // the maker never cancels; the lock's cancel appears ONLY after Alice self-broadcasts it
        if (txid === s.lockTxid) { for (let i = 0; i < 200 && !cancelSelfBroadcast; i++) await new Promise((r) => setTimeout(r, 5)); return { txid: s.cancelFinal.txid, witness: [] }; }
        return { txid: 'refundtx', witness: s.refundWit }; // then the maker refunds (cooperative) -> reclaim
      },
      async waitConfirmed() { return new Promise(() => {}); }, // never fires -> the refund branch must win
    },
  };
  const res = await driver.aliceReclaimOrPunish({ x, btc, chains, km: s.aliceKM, ctx: s.ctx, lockTxid: s.lockTxid, lockVout: s.lockVout, lockAmount: s.lockAmount, bobPb: s.bob.P, refundAdaptor: s.refundAdaptor, bCancelSig: s.bSig, xmrRestoreHeight: 0, xmrDest: 'AliceXmr', aliceDest: s.aliceDest, network: NET });
  assert.ok(cancelSelfBroadcast, 'Alice broadcast tx_cancel herself when the maker withheld it (byte-identical to the pre-signed cancel)');
  assert.equal(res.state, 'xmr_reclaimed', 'and then reclaimed her XMR from the refund');
});

test('bobReconstructUnwind rebuilds the exact cancel+refund from the persisted minimal material', () => {
  const s = reclaimSetup();
  // The minimal set bobSwap's onUnwindReady hands the host (all JSON-serializable hex/ints).
  const persisted = { alice: s.alice, lockTxid: s.lockTxid, lockVout: s.lockVout, lockAmount: s.lockAmount, aCancelSig: s.aSig, refundAdaptor: s.refundAdaptor };
  const u = driver.bobReconstructUnwind({ x, btc, km: s.bobKM, persisted, sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72 });
  assert.equal(u.cancelFinalHex, s.cancelFinal.hex, 'reconstructed cancelFinal is byte-identical to the original');
  assert.equal(u.cancelTxid, s.cancelFinal.txid, 'reconstructed cancel txid matches');
  assert.equal(u.cancelAmount, s.cancelAmount);
  assert.equal(u.refundSighash, s.refundSighash, 'reconstructed refund sighash matches (so the refund pre-sig/adaptor still applies)');
  assert.equal(u.alicePa, s.alice.P);
  assert.equal(u.refundAdaptor, s.refundAdaptor);
});

test('aliceReclaimOrPunish: no refund by T2 -> punishes the cancel to claim the maker BTC', async () => {
  const s = reclaimSetup();
  const broadcasted = [];
  const chains = {
    xmr: mockXmr(),
    btc: {
      async findSpend(txid) {
        if (txid === s.lockTxid) return { txid: s.cancelFinal.txid, witness: [] };
        return new Promise(() => {}); // the refund never appears
      },
      async waitConfirmed() { /* T2 reached instantly in the mock */ },
      async broadcast(hexStr) { broadcasted.push(hexStr); return sc.bytesToHex(sc.sha256(fromHex(hexStr))); },
    },
  };
  const res = await driver.aliceReclaimOrPunish({ x, btc, chains, km: s.aliceKM, ctx: s.ctx, lockTxid: s.lockTxid, lockVout: s.lockVout, lockAmount: s.lockAmount, bobPb: s.bob.P, refundAdaptor: s.refundAdaptor, xmrRestoreHeight: 0, xmrDest: 'AliceXmr', aliceDest: s.aliceDest, network: NET });
  assert.equal(res.state, 'punished');
  assert.equal(broadcasted.length, 1, 'exactly the punish tx is broadcast');
  const wit = btc.RawTx.decode(fromHex(broadcasted[0])).witnesses[0];
  assert.equal(wit.length, 3, 'punish ELSE-branch witness = [sigA, empty, cancelScript]');
  assert.equal(wit[1].length, 0, 'the empty witness item selects the punish (ELSE) branch');
});

test('aliceReclaimOrPunish: refund appears -> recovers m_b and sweeps the XMR home', async () => {
  const s = reclaimSetup();
  let swept = null;
  const chains = {
    xmr: { async sweep({ dest, privateSpendKey }) { swept = { dest, privateSpendKey }; return ['xmrsweep']; } },
    btc: {
      async findSpend(txid) {
        if (txid === s.lockTxid) return { txid: s.cancelFinal.txid, witness: [] };
        return { txid: 'refundtx', witness: s.refundWit }; // the maker refunded
      },
      async waitConfirmed() { return new Promise(() => {}); }, // T2 never fires: the refund branch must win
      async broadcast() { return 'x'; },
    },
  };
  const res = await driver.aliceReclaimOrPunish({ x, btc, chains, km: s.aliceKM, ctx: s.ctx, lockTxid: s.lockTxid, lockVout: s.lockVout, lockAmount: s.lockAmount, bobPb: s.bob.P, refundAdaptor: s.refundAdaptor, xmrRestoreHeight: 0, xmrDest: 'AliceXmr', aliceDest: s.aliceDest, network: NET });
  assert.equal(res.state, 'xmr_reclaimed');
  assert.ok(res.sweepTxids.length > 0);
  assert.ok(swept && swept.dest === 'AliceXmr', 'swept to the Alice XMR dest');
  assert.equal(x.ed_pubkey(swept.privateSpendKey), s.ctx.moneroSpendPub, 'reclaim reconstructs the combined lock spend key');
});

test('aliceReclaimOrPunish: an online maker RBF-evicts the punish with tx_refund -> falls back to reclaim (no fund loss)', async () => {
  const s = reclaimSetup();
  let swept = null;
  const chains = {
    xmr: { async sweep({ dest, privateSpendKey }) { swept = { dest, privateSpendKey }; return ['xmrsweep']; } },
    btc: {
      async findSpend(txid) {
        if (txid === s.lockTxid) return { txid: s.cancelFinal.txid, witness: [] };
        return new Promise(() => {}); // no refund via the watcher during the race -> forces the punish attempt
      },
      async waitConfirmed(txid) {
        if (txid === s.cancelFinal.txid) return;         // the cancel matures past T2
        throw new Error('punish evicted from mempool');  // ...but the punish NEVER confirms (maker RBF)
      },
      async broadcast() { return 'punishtxid'; },
      async getSpend(txid) {
        // after the punish is evicted, the cancel output is spent by the maker's higher-fee refund
        if (txid === s.cancelFinal.txid) return { spent: true, txid: 'refundtxid', witness: s.refundWit };
        return { spent: false };
      },
    },
  };
  const res = await driver.aliceReclaimOrPunish({ x, btc, chains, km: s.aliceKM, ctx: s.ctx, lockTxid: s.lockTxid, lockVout: s.lockVout, lockAmount: s.lockAmount, bobPb: s.bob.P, refundAdaptor: s.refundAdaptor, xmrRestoreHeight: 0, xmrDest: 'AliceXmr', aliceDest: s.aliceDest, network: NET });
  assert.equal(res.state, 'xmr_reclaimed', 'an evicted punish must reclaim the XMR, never report a false "punished"');
  assert.ok(swept && swept.dest === 'AliceXmr');
  assert.equal(x.ed_pubkey(swept.privateSpendKey), s.ctx.moneroSpendPub, 'm_b recovered from the RBF-refund');
});

test('aliceReclaimOrPunish: a prior self-punish already spent the cancel -> terminal, not a stuck reclaim', async () => {
  const s = reclaimSetup();
  // On a retry, the cancel output is already spent by Alice's OWN punish (ELSE branch: 3 witness
  // items, empty at index 1). This must report 'punished', never be fed to the refund recovery
  // (whose empty adaptor slot would throw and loop the reclaim "failing" forever).
  const punishWit = ['aa', '', 'bb']; // shape only: length 3, empty at index 1 = punish
  const chains = {
    xmr: { async sweep() { throw new Error('must not sweep; the BTC is already hers'); } },
    btc: {
      async findSpend(txid) {
        if (txid === s.lockTxid) return { txid: s.cancelFinal.txid, witness: [] };
        return { txid: 'mypunishtxid', witness: punishWit }; // the cancel is already spent by our punish
      },
      async waitConfirmed() { return new Promise(() => {}); }, // T2 never fires -> the spend branch wins
      async getSpend() { return { spent: true, txid: 'mypunishtxid', witness: punishWit }; },
      async broadcast() { return 'x'; },
    },
  };
  const res = await driver.aliceReclaimOrPunish({ x, btc, chains, km: s.aliceKM, ctx: s.ctx, lockTxid: s.lockTxid, lockVout: s.lockVout, lockAmount: s.lockAmount, bobPb: s.bob.P, refundAdaptor: s.refundAdaptor, xmrRestoreHeight: 0, xmrDest: 'AliceXmr', aliceDest: s.aliceDest, network: NET });
  assert.equal(res.state, 'punished', 'a self-punish spend is terminal, not a failed reclaim');
  assert.equal(res.punishTxid, 'mypunishtxid');
});
