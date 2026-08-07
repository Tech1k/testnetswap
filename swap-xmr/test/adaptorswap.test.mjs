// SPDX-License-Identifier: AGPL-3.0-or-later
// In-process two-party simulation of a full BTC<->XMR adaptor swap. Real crypto,
// real BTC tx suite (incl. the byte-consistent lock->cancel->refund chain), real
// scalar recovery + adaptor-verify gates; only funding/confirms/XMR-tx mocked
// (proven live elsewhere). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as btc from '../../swap-core/vendor/btc-signer.mjs';
import * as sc from '../../swap-core/src/index.js';
import * as as from '../src/adaptorswap.js';
import * as btcswap from '../src/btcswap.js';

const require = createRequire(import.meta.url);
const x = require('../crypto/pkg-node/swap_xmr_crypto.js');
const NET = sc.BTC_TESTNET4;
const enc = (u) => Buffer.from(u).toString('hex');
const witnessOf = (hex) => btc.RawTx.decode(Uint8Array.from(Buffer.from(hex, 'hex'))).witnesses[0].map(enc);
const wpkh = (pubHex) => btc.p2wpkh(Buffer.from(pubHex, 'hex'), NET).address;
const LOCK = { txid: '11'.repeat(32), vout: 0, amount: 100000 }; // Bob's funded (unbroadcast) tx_lock outpoint

function setup() {
  const aKM = as.genKeyMaterial(x), bKM = as.genKeyMaterial(x);
  const alice = as.publicBundle(x, aKM), bob = as.publicBundle(x, bKM);
  assert.equal(as.verifyBundle(x, bob).ok, true, 'Alice verifies Bob');
  assert.equal(as.verifyBundle(x, alice).ok, true, 'Bob verifies Alice');
  const ctx = as.sharedContext(x, btc, { alice, bob, sendCoinNetwork: NET, moneroNetwork: 'testnet', t1Blocks: 72, t2Blocks: 72 });
  return { aKM, bKM, alice, bob, ctx };
}

test('setup derives the same lock; verifyBundle is total; unsafe timelocks rejected', () => {
  const { ctx, aKM, bKM, bob } = setup();
  assert.ok(/^9|^A|^B/.test(ctx.moneroLockAddress));
  assert.ok(ctx.btcLock.address.startsWith('tb1'));
  assert.equal(x.ed_pubkey(x.ed_scalar_add(aKM.mSpend, bKM.mSpend)), ctx.moneroSpendPub);
  // verifyBundle never throws on hostile input
  assert.equal(as.verifyBundle(x, { ...bob, M: x.ed_pubkey(x.gen_secret_share()) }).ok, false);
  assert.equal(as.verifyBundle(x, { ...bob, vView: 'zz' }).ok, false);
  assert.equal(as.verifyBundle(x, {}).ok, false);
  // A degenerate spend share (M = identity, m_spend = 0) is rejected even when the DLEQ points
  // are forced to agree; else the combined key m_a + 0 = m_a would hand one party sole control.
  const ED_IDENTITY = '01' + '00'.repeat(31);
  const idM = as.verifyBundle(x, { ...bob, M: ED_IDENTITY, dleq: { ...bob.dleq, ed: ED_IDENTITY } });
  assert.equal(idM.ok, false);
  assert.equal(idM.reason, 'spend point is identity');
  assert.throws(() => as.sharedContext(x, btc, { alice: as.publicBundle(x, as.genKeyMaterial(x)), bob, sendCoinNetwork: NET, t1Blocks: 5, t2Blocks: 72 }), /unsafe timelocks/);
});

test('pre-sign-before-fund: cancel pre-sigs verify, tampered ones rejected', () => {
  const { aKM, alice, bob, ctx } = setup();
  const cancel = as.cancelTemplate(btc, { ctx, lockTxid: LOCK.txid, lockVout: LOCK.vout, lockAmount: LOCK.amount, network: NET });
  const aCancelSig = as.makeCancelPreSig(x, { btcKey: aKM.btcKey, cancelSighash: cancel.sighashHex });
  assert.equal(as.verifyCancelPreSig(x, { counterpartyBtcPub: alice.btcPub, cancelSighash: cancel.sighashHex, sig: aCancelSig }), true);
  assert.equal(as.verifyCancelPreSig(x, { counterpartyBtcPub: bob.btcPub, cancelSighash: cancel.sighashHex, sig: aCancelSig }), false);
});

test('HAPPY PATH: Alice verifies Bob adaptor, redeems; Bob recovers m_a -> combined Monero key', () => {
  const { aKM, bKM, alice, bob, ctx } = setup();
  const { tx, sighashHex } = as.redeemTemplate(btc, { ctx, lockTxid: LOCK.txid, lockVout: LOCK.vout, lockAmount: LOCK.amount, aliceDest: wpkh(alice.btcPub), network: NET });
  const bobAdaptor = as.makeRedeemAdaptor(x, { bobBtcKey: bKM.btcKey, alicePa: alice.P, redeemSighash: sighashHex });
  assert.equal(as.verifyRedeemAdaptor(x, { bobBtcPub: bob.btcPub, alicePa: alice.P, redeemSighash: sighashHex, adaptor: bobAdaptor }), true);
  const { hex } = as.aliceFinalizeRedeem(x, btc, { tx, ctx, aliceBtcKey: aKM.btcKey, aliceMSpend: aKM.mSpend, redeemSighash: sighashHex, bobRedeemAdaptor: bobAdaptor, bobBtcPub: bob.btcPub, alicePa: alice.P });
  const rec = as.bobRecoverFromRedeem(x, { redeemWitnessHex: witnessOf(hex), alicePa: alice.P, bobRedeemAdaptor: bobAdaptor, bobMSpend: bKM.mSpend });
  assert.equal(rec.maEd, aKM.mSpend);
  assert.equal(x.ed_pubkey(rec.combinedSpendPriv), ctx.moneroSpendPub, 'Bob can sweep');
});

test('HAPPY PATH rejects a malicious redeem adaptor (Alice refuses before locking)', () => {
  const { aKM, bKM, alice, bob, ctx } = setup();
  const { tx, sighashHex } = as.redeemTemplate(btc, { ctx, lockTxid: LOCK.txid, lockVout: LOCK.vout, lockAmount: LOCK.amount, aliceDest: wpkh(alice.btcPub), network: NET });
  const badAdaptor = as.makeRedeemAdaptor(x, { bobBtcKey: bKM.btcKey, alicePa: alice.P, redeemSighash: 'cd'.repeat(32) }); // wrong sighash
  assert.equal(as.verifyRedeemAdaptor(x, { bobBtcPub: bob.btcPub, alicePa: alice.P, redeemSighash: sighashHex, adaptor: badAdaptor }), false);
  assert.throws(() => as.aliceFinalizeRedeem(x, btc, { tx, ctx, aliceBtcKey: aKM.btcKey, aliceMSpend: aKM.mSpend, redeemSighash: sighashHex, bobRedeemAdaptor: badAdaptor, bobBtcPub: bob.btcPub, alicePa: alice.P }), /adaptor invalid/);
});

test('REFUND PATH: real lock->cancel->refund chain; Bob verifies+refunds; Alice recovers m_b', () => {
  const { aKM, bKM, alice, bob, ctx } = setup();
  // build + finalize a REAL tx_cancel (both pre-sign), then build refund on its actual output
  const cancel = as.cancelTemplate(btc, { ctx, lockTxid: LOCK.txid, lockVout: LOCK.vout, lockAmount: LOCK.amount, network: NET });
  const aCancelSig = as.makeCancelPreSig(x, { btcKey: aKM.btcKey, cancelSighash: cancel.sighashHex });
  const bCancelSig = as.makeCancelPreSig(x, { btcKey: bKM.btcKey, cancelSighash: cancel.sighashHex });
  const cancelFinal = btcswap.finalize2of2(btc, cancel.tx, ctx.btcLock.witnessScript, aCancelSig, bCancelSig);
  const cancelAmount = LOCK.amount - 1000;

  const refund = as.refundTemplate(btc, { ctx, cancelTxid: cancelFinal.txid, cancelVout: 0, cancelAmount, cancelScriptPubKeyHex: cancel.cancelScriptPubKeyHex, bobDest: wpkh(bob.btcPub), network: NET });
  const aliceAdaptor = as.makeRefundAdaptor(x, { aliceBtcKey: aKM.btcKey, bobPb: bob.P, refundSighash: refund.sighashHex });
  assert.equal(as.verifyRefundAdaptor(x, { aliceBtcPub: alice.btcPub, bobPb: bob.P, refundSighash: refund.sighashHex, adaptor: aliceAdaptor }), true);
  const { hex } = as.bobFinalizeRefund(x, btc, { tx: refund.tx, ctx, bobBtcKey: bKM.btcKey, bobMSpend: bKM.mSpend, refundSighash: refund.sighashHex, aliceRefundAdaptor: aliceAdaptor, aliceBtcPub: alice.btcPub, bobPb: bob.P });
  const rec = as.aliceRecoverFromRefund(x, { refundWitnessHex: witnessOf(hex), bobPb: bob.P, aliceRefundAdaptor: aliceAdaptor, aliceMSpend: aKM.mSpend });
  assert.equal(rec.mbEd, bKM.mSpend);
  assert.equal(x.ed_pubkey(rec.combinedSpendPriv), ctx.moneroSpendPub, 'Alice can reclaim XMR');

  // punish template builds with the T2 relative sequence (cancel ELSE branch)
  const punish = as.punishTemplate(btc, { ctx, cancelTxid: cancelFinal.txid, cancelVout: 0, cancelAmount, cancelScriptPubKeyHex: cancel.cancelScriptPubKeyHex, aliceDest: wpkh(alice.btcPub), network: NET });
  assert.equal(punish.sighashHex.length, 64);
});
