// SPDX-License-Identifier: AGPL-3.0-or-later
// Forward-resume (driver.aliceResumeRedeem): FINISH a persisted swap from its reclaim blob instead of
// reclaiming the XMR. Uses the REAL WASM crypto + tx suite to build a genuine ctx/redeem/cancel, then
// drives every branch: happy redeem, the timelock-margin guard, already-redeemed idempotency, a
// maker-cancelled lock, a silent maker, and the lock-address safety cross-check. Run: node --test
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
const addrToScript = (a) => enc(btc.OutScript.encode(btc.Address(NET).decode(a)));

// Build a real, persisted-blob-shaped swap paused right before the redeem, plus the maker's redeem
// adaptor and the deterministic cancel txid (what a cancelled lock's spender would be).
function resumeSetup() {
  const bobKM = as.genKeyMaterial(x), aliceKM = as.genKeyMaterial(x);
  const bob = as.publicBundle(x, bobKM), alice = as.publicBundle(x, aliceKM);
  const t1Blocks = 72, t2Blocks = 72, moneroNetwork = 'testnet';
  const ctx = as.sharedContext(x, btc, { alice, bob, sendCoinNetwork: NET, moneroNetwork, t1Blocks, t2Blocks });
  const lockAmount = 100000, lockTxid = sc.bytesToHex(sc.sha256(fromHex('feed01'))), lockVout = 0;
  const aliceDest = btc.p2wpkh(fromHex(alice.btcPub), NET).address;
  const redeem = as.redeemTemplate(btc, { ctx, lockTxid, lockVout, lockAmount, aliceDest, network: NET });
  const redeemAdaptor = as.makeRedeemAdaptor(x, { bobBtcKey: bobKM.btcKey, alicePa: alice.P, redeemSighash: redeem.sighashHex });
  const cancel = as.cancelTemplate(btc, { ctx, lockTxid, lockVout, lockAmount, network: NET });
  const bCancelSig = as.makeCancelPreSig(x, { btcKey: bobKM.btcKey, cancelSighash: cancel.sighashHex });
  const aCancelSig = as.makeCancelPreSig(x, { btcKey: aliceKM.btcKey, cancelSighash: cancel.sighashHex });
  const cancelTxid = btcswap.finalize2of2(btc, cancel.tx, ctx.btcLock.witnessScript, aCancelSig, bCancelSig).txid;
  const persisted = {
    bob, lockOutpoint: { txid: lockTxid, vout: lockVout, amount: lockAmount },
    bCancelSig, t1Blocks, t2Blocks, moneroNetwork,
    ctx: { combinedViewPriv: ctx.combinedViewPriv, moneroLockAddress: ctx.moneroLockAddress }, km: aliceKM,
  };
  return { bobKM, aliceKM, bob, alice, ctx, lockTxid, lockVout, lockAmount, aliceDest, redeemAdaptor, cancelTxid, persisted };
}
function resumeBtc({ spend = { spent: false }, confs = 1, onBroadcast } = {}) {
  const spendFn = typeof spend === 'function' ? spend : () => spend;   // allow per-call variation (pre vs post re-check)
  const confsFn = typeof confs === 'function' ? confs : () => confs;
  return {
    async getSpend() { return spendFn(); },
    async txConfs() { return confsFn(); },
    async broadcast(hex) { if (onBroadcast) onBroadcast(hex); return sc.bytesToHex(sc.sha256(fromHex(typeof hex === 'string' ? hex : '00'))); },
  };
}

test('redeemMarginReason: gates the m_a-revealing redeem (shared by live + resume paths)', async () => {
  const chain = (getSpend, txConfs) => ({ btc: { getSpend, txConfs } });
  // safe: unspent + plenty of margin (t1=72, confs=1)
  assert.equal(await driver.redeemMarginReason(chain(async () => ({ spent: false }), async () => 1), 'lk', 0, 72, 12), null);
  // lock already spent (maker cancelled) -> abort
  assert.match(await driver.redeemMarginReason(chain(async () => ({ spent: true, txid: 'c' }), async () => 1), 'lk', 0, 72, 12), /already spent/);
  // too close to the cancel window (confs=65, margin=7 < 12) -> abort
  assert.match(await driver.redeemMarginReason(chain(async () => ({ spent: false }), async () => 65), 'lk', 0, 72, 12), /blocks before the maker cancel window/);
  // confirmations unreadable (0) -> fail closed
  assert.match(await driver.redeemMarginReason(chain(async () => ({ spent: false }), async () => 0), 'lk', 0, 72, 12), /could not read the lock confirmations/);
  // no txConfs source (mock chain) -> cannot gate, returns null (production adapters always have it)
  assert.equal(await driver.redeemMarginReason({ btc: { getSpend: async () => ({ spent: false }) } }, 'lk', 0, 72, 12), null);
});

test('aliceResumeRedeem: unspent + margin + adaptor -> redeemed (broadcasts a valid redeem)', async () => {
  const s = resumeSetup();
  let broadcastHex = null, called = 0;
  const chains = { btc: resumeBtc({ confs: 1, onBroadcast: (h) => (broadcastHex = h) }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, safetyBlocks: 12, recvRedeemAdaptor: async () => (called++, s.redeemAdaptor) });
  assert.equal(res.state, 'redeemed');
  assert.equal(called, 1, 'the adaptor was requested exactly once');
  assert.ok(typeof broadcastHex === 'string', 'a redeem tx was broadcast');
  const tx = btc.RawTx.decode(fromHex(broadcastHex));
  assert.equal(enc(tx.inputs[0].txid), s.lockTxid, 'redeem spends the lock outpoint');
  assert.equal(tx.inputs[0].index, s.lockVout);
  assert.equal(enc(tx.outputs[0].script), addrToScript(s.aliceDest), 'redeem pays Alice her settle coin');
});

test('aliceResumeRedeem: too close to the cancel timelock -> must_reclaim, never reveals the redeem', async () => {
  const s = resumeSetup();
  let called = 0, broadcast = 0;
  const chains = { btc: resumeBtc({ confs: s.persisted.t1Blocks - 1, onBroadcast: () => broadcast++ }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, safetyBlocks: 12, recvRedeemAdaptor: async () => (called++, s.redeemAdaptor) });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'timelock_margin');
  assert.equal(called, 0, 'no adaptor requested when the margin is unsafe');
  assert.equal(broadcast, 0, 'no redeem broadcast (secret never leaked into a losing race)');
});

test('aliceResumeRedeem: lock already redeemed -> redeemed (idempotent, no adaptor request)', async () => {
  const s = resumeSetup();
  let called = 0;
  const chains = { btc: resumeBtc({ spend: { spent: true, txid: 'someRedeemTxid' } }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, recvRedeemAdaptor: async () => (called++, s.redeemAdaptor) });
  assert.equal(res.state, 'redeemed');
  assert.equal(res.alreadyOnChain, true);
  assert.equal(res.redeemTxid, 'someRedeemTxid');
  assert.equal(called, 0);
});

test('aliceResumeRedeem: lock spent by the maker cancel -> must_reclaim/cancelled', async () => {
  const s = resumeSetup();
  const chains = { btc: resumeBtc({ spend: { spent: true, txid: s.cancelTxid } }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, recvRedeemAdaptor: async () => s.redeemAdaptor });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'cancelled');
});

test('aliceResumeRedeem: silent maker (no adaptor) -> must_reclaim/no_adaptor, no broadcast', async () => {
  const s = resumeSetup();
  let broadcast = 0;
  const chains = { btc: resumeBtc({ confs: 1, onBroadcast: () => broadcast++ }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, recvRedeemAdaptor: async () => null });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'no_adaptor');
  assert.equal(broadcast, 0);
});

test('aliceResumeRedeem: margin eroded DURING the adaptor wait -> re-check catches it, never broadcasts', async () => {
  const s = resumeSetup();
  let confCall = 0, broadcast = 0;
  // pre-flight sees safe margin (confs=1); the post-flight re-check (after the adaptor) sees the lock aged
  // into the unsafe window (confs=t1-2), so the redeem must NOT go out even though the adaptor arrived.
  const chains = { btc: resumeBtc({ confs: () => (++confCall === 1 ? 1 : s.persisted.t1Blocks - 2), onBroadcast: () => broadcast++ }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, safetyBlocks: 12, recvRedeemAdaptor: async () => s.redeemAdaptor });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'timelock_margin');
  assert.equal(broadcast, 0, 'never revealed the redeem once the re-check saw the margin gone');
});

test('aliceResumeRedeem: lock spent by the maker cancel DURING the wait -> re-check reclaims, no broadcast', async () => {
  const s = resumeSetup();
  let spendCall = 0, broadcast = 0;
  // unspent at entry, spent by the cancel by the time the adaptor arrives.
  const chains = { btc: resumeBtc({ spend: () => (++spendCall === 1 ? { spent: false } : { spent: true, txid: s.cancelTxid }), confs: 1, onBroadcast: () => broadcast++ }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, safetyBlocks: 12, recvRedeemAdaptor: async () => s.redeemAdaptor });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'cancelled');
  assert.equal(broadcast, 0);
});

test('aliceResumeRedeem: blob missing bCancelSig -> incomplete_recovery (never enters forward)', async () => {
  const s = resumeSetup();
  const bad = { ...s.persisted }; delete bad.bCancelSig;
  let called = 0;
  const chains = { btc: resumeBtc({ confs: 1 }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: bad, sendCoinNetwork: NET, aliceDest: s.aliceDest, recvRedeemAdaptor: async () => (called++, s.redeemAdaptor) });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'incomplete_recovery');
  assert.equal(called, 0);
});

test('aliceResumeRedeem: spent lock that cannot be classified (bad bCancelSig) -> must_reclaim/spent_unclassified (never false "redeemed")', async () => {
  const s = resumeSetup();
  const bad = { ...s.persisted, bCancelSig: 'deadbeef' }; // truthy but invalid -> finalize2of2 throws -> cancelTxid null
  const chains = { btc: resumeBtc({ spend: { spent: true, txid: s.cancelTxid } }) };
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: bad, sendCoinNetwork: NET, aliceDest: s.aliceDest, recvRedeemAdaptor: async () => s.redeemAdaptor });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'spent_unclassified');
});

test('aliceResumeRedeem: unreadable lock confirmations -> must_reclaim/confs_unknown (fail closed)', async () => {
  const s = resumeSetup();
  let called = 0, broadcast = 0;
  const chains = { btc: resumeBtc({ confs: 0, onBroadcast: () => broadcast++ }) }; // txConfs can't read -> 0
  const res = await driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: s.persisted, sendCoinNetwork: NET, aliceDest: s.aliceDest, recvRedeemAdaptor: async () => (called++, s.redeemAdaptor) });
  assert.equal(res.state, 'must_reclaim');
  assert.equal(res.reason, 'confs_unknown');
  assert.equal(called, 0, 'never requests the adaptor when the on-chain state is unknown');
  assert.equal(broadcast, 0);
});

test('aliceResumeRedeem: reconstructed lock address mismatch -> throws (refuses to act)', async () => {
  const s = resumeSetup();
  const bad = { ...s.persisted, ctx: { ...s.persisted.ctx, moneroLockAddress: 'WRONG_LOCK_ADDR' } };
  const chains = { btc: resumeBtc({ confs: 1 }) };
  await assert.rejects(
    driver.aliceResumeRedeem({ x, btc, chains, km: s.aliceKM, persisted: bad, sendCoinNetwork: NET, aliceDest: s.aliceDest, recvRedeemAdaptor: async () => s.redeemAdaptor }),
    /does not match/,
  );
});
