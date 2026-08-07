// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the shared XMR taker (runXmrTaker = Alice) drives a full tXMR->tBTC swap
// against the real bobSwap driver over an in-memory relay + mock chains, using the
// REAL WASM crypto + tx suite. Also asserts the U-2 fix: recovery material is built
// and handed to onBeforeLock (complete) BEFORE any XMR is locked. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as btc from '../../swap-core/vendor/btc-signer.mjs';
import * as sc from '../../swap-core/src/index.js';
import * as as from '../../swap-xmr/src/adaptorswap.js';
import * as driver from '../../swap-xmr/src/driver.js';
import { runXmrTaker, runXmrResume, xmrResumeChallenge, requestXmrQuote } from '../src/taker.js';

const require = createRequire(import.meta.url);
const x = require('../../swap-xmr/crypto/pkg-node/swap_xmr_crypto.js');
const NET = sc.BTC_TESTNET4;
const enc = (u) => Buffer.from(u).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const addrToScript = (a) => enc(btc.OutScript.encode(btc.Address(NET).decode(a)));

class T {
  constructor() { this.peer = null; this.buf = []; this.waiters = []; }
  send(msg) { queueMicrotask(() => this.peer._deliver(JSON.parse(JSON.stringify(msg)))); }
  _deliver(msg) { const i = this.waiters.findIndex((w) => w.type === msg.type); if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg); else this.buf.push(msg); }
  recv(type, ms = 30000) {
    const i = this.buf.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { const w = { type, resolve }; this.waiters.push(w); setTimeout(() => { const j = this.waiters.indexOf(w); if (j >= 0) { this.waiters.splice(j, 1); reject(new Error('recv timeout ' + type)); } }, ms); });
  }
}
function pair() { const a = new T(), b = new T(); a.peer = b; b.peer = a; return [a, b]; }

function mockBtc() {
  const outs = {}; const wit = {}; let n = 0;
  return {
    async buildLockFunding({ address, amount }) { const txid = sc.bytesToHex(sc.sha256(fromHex('aa' + (n++).toString(16).padStart(2, '0')))); outs[txid + ':0'] = { value: amount, scriptPubKeyHex: addrToScript(address) }; return { txid, vout: 0, amount, hex: { lock: true, txid } }; },
    async broadcast(h) { if (typeof h !== 'string') return h.txid; const tx = btc.RawTx.decode(fromHex(h)); const inp = tx.inputs[0]; wit[enc(inp.txid) + ':' + inp.index] = tx.witnesses[0].map(enc); return sc.bytesToHex(sc.sha256(fromHex(h))); },
    async waitConfirmed() {},
    async getOutput(txid, vout) { return outs[txid + ':' + vout] || { value: 0, scriptPubKeyHex: '' }; },
    async watchSpend(txid, vout) { const k = txid + ':' + vout; for (let i = 0; i < 600; i++) { if (wit[k]) return wit[k]; await new Promise((r) => setTimeout(r, 20)); } throw new Error('watchSpend timeout'); },
    async getSpend(txid, vout) { const k = txid + ':' + vout; return wit[k] ? { spent: true, txid: 'redeem', witness: wit[k] } : { spent: false }; },
  };
}
function mockXmr() { const locks = {}; return {
  async lock({ address, amount }) { locks[address] = amount; return 'xmrtx'; },
  async waitLocked({ address }) { for (let i = 0; i < 300; i++) { if (locks[address]) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('waitLocked timeout'); },
  async sweep({ dest }) { return ['xmrsweep_' + (dest || '').slice(0, 8)]; },
}; }

test('shared XMR taker drives a full tXMR->tBTC swap vs bobSwap; recovery built before lock', async () => {
  const [aliceT, bobT] = pair();
  const chains = { btc: mockBtc(), xmr: mockXmr() };
  const aliceKM = as.genKeyMaterial(x), bobKM = as.genKeyMaterial(x);
  // A real receive address distinct from Alice's derived swap p2wpkh: the taker threads it to the maker
  // (redeemAddr on the bundle) so the maker builds the redeem adaptor over it; otherwise adaptor_verify
  // fails and the redeem never completes. This is the end-to-end regression guard for that fix.
  const aliceBtcDest = btc.p2wpkh(fromHex(as.publicBundle(x, as.genKeyMaterial(x)).btcPub), NET).address;
  const params = { sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72, lockAmount: 20000, minConf: 0, xmrAmount: 2_000_000_000, xmrRestoreHeight: 0, xmrSweepDest: 'BobSweep', aliceBtcDest, setupTimeoutMs: 20000, lockTimeoutMs: 20000, redeemTimeoutMs: 20000 };

  let recovery = null;
  const [aliceRes, bobRes] = await Promise.all([
    runXmrTaker({ x, btc, as, driver, transport: aliceT, chains, km: aliceKM, params, onBeforeLock: async (r) => { recovery = r; } }),
    driver.bobSwap({ x, btc, transport: bobT, chains, km: bobKM, params }),
  ]);

  assert.equal(aliceRes.state, 'redeemed', 'taker redeemed tBTC');
  assert.equal(bobRes.state, 'completed', 'maker recovered + swept');
  // U-2: recovery was assembled and complete BEFORE the XMR lock
  assert.ok(recovery, 'onBeforeLock fired');
  assert.ok(recovery.lockOutpoint && recovery.bob.P && recovery.refundAdaptor && recovery.ctx.combinedViewPriv && recovery.ctx.moneroLockAddress, 'recovery blob complete');
  assert.equal(x.ed_pubkey(bobRes.combinedSpendPriv), bobRes.moneroSpendPub, 'maker holds the combined Monero key');
});

test('taker resumes the redeem adaptor after a relay drop (authenticated re-request)', async () => {
  const [aliceT, bobT] = pair();
  const chains = { btc: mockBtc(), xmr: mockXmr() };
  const aliceKM = as.genKeyMaterial(x), bobKM = as.genKeyMaterial(x);
  const params = { sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72, lockAmount: 20000, minConf: 0, xmrAmount: 2_000_000_000, xmrRestoreHeight: 0, xmrSweepDest: 'BobSweep', setupTimeoutMs: 20000, lockTimeoutMs: 20000, redeemTimeoutMs: 20000 };

  // Primary transport, but the FIRST recv('redeem_adaptor') simulates a WS drop mid-wait.
  let dropped = false;
  const aliceDrop = {
    get hello() { return { sid: 'orig' }; }, get closed() { return false; }, close() {},
    send: (m) => aliceT.send(m),
    recv: (type, ms) => (type === 'redeem_adaptor' && !dropped) ? (dropped = true, Promise.reject(new Error('relay closed'))) : aliceT.recv(type, ms),
  };
  // The maker's resume-challenge formula (MUST stay identical to xmr-handler.js resumeChallenge and the
  // taker's signResume). The relayFactory emulates the maker's authenticated re-send: it verifies the
  // xmr_resume signature over (outpoint || new-sid) against Alice's btcPub, then re-delivers the adaptor
  // bob already sent (buffered on aliceT after the drop).
  const challenge = (txid, vout, sid) => sc.bytesToHex(sc.sha256(new TextEncoder().encode('testnetswap/xmr-resume/v1|' + txid + '|' + vout + '|' + sid)));
  const alicePub = as.publicBundle(x, aliceKM).btcPub;
  const resumeCalls = []; let sidN = 0;
  const relayFactory = async () => {
    const sid = 'resume-' + (sidN++);
    return {
      hello: { sid }, closed: false, close() {},
      send: (m) => { if (m.type === 'xmr_resume') resumeCalls.push({ ...m, verified: x.ecdsa_verify(alicePub, challenge(m.lockTxid, m.lockVout, sid), m.sig) }); },
      recv: (type, ms) => type === 'redeem_adaptor' ? aliceT.recv('redeem_adaptor', ms) : Promise.reject(new Error('recv timeout ' + type)),
    };
  };

  const [aliceRes, bobRes] = await Promise.all([
    runXmrTaker({ x, btc, as, driver, transport: aliceDrop, chains, km: aliceKM, params, onBeforeLock: async () => {}, sc, relayFactory }),
    driver.bobSwap({ x, btc, transport: bobT, chains, km: bobKM, params }),
  ]);
  assert.equal(aliceRes.state, 'redeemed', 'taker completed the swap via resume after the drop');
  assert.equal(bobRes.state, 'completed', 'maker still recovered + swept (redeem observed on-chain regardless of sid)');
  assert.ok(resumeCalls.length >= 1, 'taker sent xmr_resume on reconnect');
  assert.equal(resumeCalls[0].verified, true, 'resume signature verifies against Alice btcPub over (outpoint || new-sid)');
  assert.ok(resumeCalls[0].lockTxid && typeof resumeCalls[0].lockVout === 'number', 'resume carried the lock outpoint');
});

test('requestXmrQuote(quoteOnly) returns a quote shape', async () => {
  const [aliceT, makerT] = pair();
  // a tiny mock maker that answers the preview
  (async () => { const q = await makerT.recv('xmr_request_quote'); makerT.send({ type: 'xmr_quote', lock_sats: 5000, xmr_pico: q.send_pico, t1_blocks: 72, t2_blocks: 72, rate: 0.01, network: 'testnet', to: 'tBTC' }); })();
  const quote = await requestXmrQuote({ transport: aliceT, fromCoin: 'tXMR', sendPico: 5_000_000_000, quoteOnly: true });
  assert.equal(quote.lock_sats, 5000);
  assert.equal(quote.network, 'testnet');
});

/* ------------------------------------------------------------ forward-resume (runXmrResume) */
// Build a real, persisted-blob-shaped swap paused at the redeem, plus the maker's redeem adaptor.
function resumeFixture() {
  const bobKM = as.genKeyMaterial(x), aliceKM = as.genKeyMaterial(x);
  const bob = as.publicBundle(x, bobKM), alice = as.publicBundle(x, aliceKM);
  const t1Blocks = 72, t2Blocks = 72;
  const ctx = as.sharedContext(x, btc, { alice, bob, sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks, t2Blocks });
  const lockAmount = 100000, lockTxid = sc.bytesToHex(sc.sha256(fromHex('cafe01'))), lockVout = 0;
  const aliceDest = btc.p2wpkh(fromHex(alice.btcPub), NET).address;
  const redeem = as.redeemTemplate(btc, { ctx, lockTxid, lockVout, lockAmount, aliceDest, network: NET });
  const adaptor = as.makeRedeemAdaptor(x, { bobBtcKey: bobKM.btcKey, alicePa: alice.P, redeemSighash: redeem.sighashHex });
  const bCancelSig = as.makeCancelPreSig(x, { btcKey: bobKM.btcKey, cancelSighash: as.cancelTemplate(btc, { ctx, lockTxid, lockVout, lockAmount, network: NET }).sighashHex });
  const persisted = { bob, lockOutpoint: { txid: lockTxid, vout: lockVout, amount: lockAmount }, bCancelSig, t1Blocks, t2Blocks, moneroNetwork: 'testnet', ctx: { combinedViewPriv: ctx.combinedViewPriv, moneroLockAddress: ctx.moneroLockAddress }, km: aliceKM };
  return { aliceKM, alice, aliceDest, adaptor, persisted };
}
// A relay transport with the same waiter/inbox/timeout semantics as the browser relay.js (a timed-out
// recv removes its waiter; a matching message resolves the first waiter or buffers). `onResume(m,deliver,sid)`
// emulates the maker's authenticated re-send.
function fakeRelay(sid, onResume) {
  const inbox = [], waiters = [];
  const deliver = (m) => { const i = waiters.findIndex((w) => w.type === m.type); if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.to); w.resolve(m); } else inbox.push(m); };
  const t = {
    hello: { sid }, closed: false,
    close() { t.closed = true; while (waiters.length) { const w = waiters.shift(); clearTimeout(w.to); w.reject(new Error('relay closed')); } },
    send(m) { if (m && m.type === 'xmr_resume') onResume(m, deliver, sid); },
    recv(type, ms = 5000) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      if (t.closed) return Promise.reject(new Error('relay closed'));
      return new Promise((res, rej) => { const w = { type, resolve: res, reject: rej, to: setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) waiters.splice(j, 1); rej(new Error('timeout ' + type)); }, ms) }; waiters.push(w); });
    },
  };
  return t;
}
const goodBtc = (onBroadcast) => ({ async getSpend() { return { spent: false }; }, async txConfs() { return 1; }, async broadcast(h) { if (onBroadcast) onBroadcast(h); return 'redeemtxid'; } });

test('runXmrResume: authenticated re-request returns the adaptor and finishes the redeem forward', async () => {
  const s = resumeFixture();
  const alicePub = as.publicBundle(x, s.aliceKM).btcPub;
  const verified = []; let n = 0, broadcastHex = null;
  const relayFactory = async () => fakeRelay('r' + (n++), (m, deliver, sid) => {
    verified.push(x.ecdsa_verify(alicePub, xmrResumeChallenge(sc, m.lockTxid, m.lockVout, sid), m.sig));
    deliver({ type: 'redeem_adaptor', adaptor: s.adaptor });
  });
  const res = await runXmrResume({ x, btc, as, driver, chains: { btc: goodBtc((h) => (broadcastHex = h)) }, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, sc, relayFactory, safetyBlocks: 12 });
  assert.equal(res.state, 'redeemed');
  assert.equal(res.redeemTxid, 'redeemtxid');
  assert.ok(verified.length >= 1 && verified.every(Boolean), 'every xmr_resume signature verifies against Alice btcPub');
  assert.ok(typeof broadcastHex === 'string' && broadcastHex.length > 0, 'a redeem was broadcast');
});

test('runXmrResume: a buffered xmr_resume_wait does not block the adaptor recv', async () => {
  const s = resumeFixture();
  const alicePub = as.publicBundle(x, s.aliceKM).btcPub;
  let n = 0;
  const relayFactory = async () => fakeRelay('r' + (n++), (m, deliver, sid) => {
    assert.ok(x.ecdsa_verify(alicePub, xmrResumeChallenge(sc, m.lockTxid, m.lockVout, sid), m.sig));
    deliver({ type: 'xmr_resume_wait' });               // still maturing (buffered)
    setTimeout(() => deliver({ type: 'redeem_adaptor', adaptor: s.adaptor }), 40); // then it matures
  });
  const res = await runXmrResume({ x, btc, as, driver, chains: { btc: goodBtc() }, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, sc, relayFactory, safetyBlocks: 12 });
  assert.equal(res.state, 'redeemed');
});

test('runXmrResume: a silent/gone maker yields must_reclaim/no_adaptor (no redeem broadcast)', async () => {
  const s = resumeFixture();
  let n = 0, broadcast = 0;
  const relayFactory = async () => fakeRelay('r' + (n++), () => { /* never replies */ });
  const res = await runXmrResume({ x, btc, as, driver, chains: { btc: goodBtc(() => broadcast++) }, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, sc, relayFactory, safetyBlocks: 12, resumeTimeoutMs: 1200 });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'no_adaptor');
  assert.equal(broadcast, 0);
});

test('runXmrResume: a live maker still maturing at the deadline yields must_reclaim/still_maturing (retryable, not "offline")', async () => {
  const s = resumeFixture();
  let n = 0, broadcast = 0;
  const relayFactory = async () => fakeRelay('r' + (n++), (m, deliver) => { deliver({ type: 'xmr_resume_wait' }); }); // alive, never matures in-window
  const res = await runXmrResume({ x, btc, as, driver, chains: { btc: goodBtc(() => broadcast++) }, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, sc, relayFactory, safetyBlocks: 12, resumeTimeoutMs: 1500 });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'still_maturing');
  assert.equal(broadcast, 0);
});
