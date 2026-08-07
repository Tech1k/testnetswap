// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline tests for the BTC/LTC adaptor-swap tx suite. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as btc from '../../swap-core/vendor/btc-signer.mjs';
import * as sc from '../../swap-core/src/index.js';
import * as bs from '../src/btcswap.js';

const require = createRequire(import.meta.url);
const x = require('../crypto/pkg-node/swap_xmr_crypto.js');
const NET = sc.BTC_TESTNET4;
const enc = (u) => Buffer.from(u).toString('hex');
const rand = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return enc(b); };

test('DER <-> compact round-trips', () => {
  const c = rand() + rand(); // 64 bytes
  assert.equal(enc(bs.derToCompact(bs.compactToDer(c))), c);
});

test('lock2of2 yields a P2WSH address on the right network', () => {
  const a = x.secp_pubkey(rand()), b = x.secp_pubkey(rand());
  const lock = bs.lock2of2(btc, a, b, NET);
  assert.ok(lock.address.startsWith('tb1'));
  assert.ok(lock.witnessScript && lock.scriptPubKey);
});

test('redeem: adaptor-signed 2-of-2 spend, then recover the scalar from the witness', () => {
  const keyA = rand(), keyB = rand();
  const pubA = x.secp_pubkey(keyA), pubB = x.secp_pubkey(keyB);
  const sEd = x.gen_secret_share();
  const sSecp = x.ed_to_secp_scalar(sEd);
  const Y = x.secp_pubkey(sSecp);               // adaptor encryption key = s*G

  const lock = bs.lock2of2(btc, pubA, pubB, NET);
  const { tx, sighashHex } = bs.spendTemplate(btc, {
    prevTxid: '01'.repeat(32), vout: 0, prevAmount: 100000,
    prevScriptPubKeyHex: lock.scriptPubKey, witnessScriptHex: lock.witnessScript,
    outAddress: btc.p2wpkh(Buffer.from(pubA, 'hex'), NET).address, outAmount: 99000, network: NET,
  });
  assert.equal(sighashHex.length, 64);

  const sigA = x.ecdsa_sign(keyA, sighashHex);
  const encSig = x.adaptor_encrypt(keyB, Y, sighashHex);
  assert.equal(x.adaptor_verify(pubB, Y, sighashHex, encSig), true);
  const sigB = x.adaptor_decrypt(sSecp, encSig);

  const { hex } = bs.finalize2of2(btc, tx, lock.witnessScript, sigA, sigB);
  const witItems = btc.RawTx.decode(Uint8Array.from(Buffer.from(hex, 'hex'))).witnesses[0];
  assert.equal(witItems[0].length, 0, 'CHECKMULTISIG dummy must be empty');
  assert.equal(x.ecdsa_verify(pubA, sighashHex, enc(bs.derToCompact(witItems[1].slice(0, -1)))), true, 'item1 pairs with A');
  assert.equal(x.ecdsa_verify(pubB, sighashHex, enc(bs.derToCompact(witItems[2].slice(0, -1)))), true, 'item2 pairs with B');
  const recovered = bs.recoverFromRedeem(x, witItems.map(enc), Y, encSig);
  assert.equal(recovered, sSecp, 'recovered scalar == s (the Monero key share)');
});

test('cancel / refund / punish txs construct and sign on the right branches', () => {
  const keyA = rand(), keyB = rand(), keyAP = rand();
  const pubA = x.secp_pubkey(keyA), pubB = x.secp_pubkey(keyB), pubAP = x.secp_pubkey(keyAP);
  const bobShare = x.gen_secret_share();
  const Yb = x.secp_pubkey(x.ed_to_secp_scalar(bobShare)); // refund leaks Bob's share
  const t1 = 6, t2 = 6;

  const lock = bs.lock2of2(btc, pubA, pubB, NET);
  const cScriptHex = bs.cancelScript(btc, pubA, pubB, pubAP, t2);
  const cancelWsh = btc.p2wsh({ script: Uint8Array.from(Buffer.from(cScriptHex, 'hex')) }, NET);

  // tx_cancel: spend lock -> cancel output, relative timelock T1
  const cancel = bs.spendTemplate(btc, {
    prevTxid: '02'.repeat(32), vout: 0, prevAmount: 100000,
    prevScriptPubKeyHex: lock.scriptPubKey, witnessScriptHex: lock.witnessScript,
    outAddress: cancelWsh.address, outAmount: 99000, network: NET, sequence: bs.relSequenceBlocks(t1),
  });
  assert.equal(cancel.sighashHex.length, 64);

  // tx_refund: spend cancel(refund branch); Alice's sig is an adaptor under Yb
  const refund = bs.spendTemplate(btc, {
    prevTxid: '03'.repeat(32), vout: 0, prevAmount: 99000,
    prevScriptPubKeyHex: enc(cancelWsh.script), witnessScriptHex: cScriptHex,
    outAddress: btc.p2wpkh(Buffer.from(pubB, 'hex'), NET).address, outAmount: 98000, network: NET,
  });
  const encA = x.adaptor_encrypt(keyA, Yb, refund.sighashHex); // Alice's adaptor leg
  assert.equal(x.adaptor_verify(pubA, Yb, refund.sighashHex, encA), true);
  const sigBplain = x.ecdsa_sign(keyB, refund.sighashHex);
  const sigArefund = x.adaptor_decrypt(x.ed_to_secp_scalar(bobShare), encA); // Bob completes
  const refHex = bs.finalizeRefund(btc, refund.tx, cScriptHex, sigArefund, sigBplain).hex;

  // pin the IF-branch witness layout: [sigB||01, sigA||01, OP_1, cancelScript]
  const refWit = btc.RawTx.decode(Uint8Array.from(Buffer.from(refHex, 'hex'))).witnesses[0];
  assert.equal(refWit.length, 4);
  assert.deepEqual(refWit[2], Uint8Array.from([1]), 'IF selector must be TRUE(0x01)');
  assert.equal(enc(refWit[3]), cScriptHex, 'last item is the cancel script');
  // sig->pubkey pairing: item0 verifies under B, item1(adaptor-completed) under A
  assert.equal(x.ecdsa_verify(pubB, refund.sighashHex, enc(bs.derToCompact(refWit[0].slice(0, -1)))), true);
  assert.equal(x.ecdsa_verify(pubA, refund.sighashHex, enc(bs.derToCompact(refWit[1].slice(0, -1)))), true);
  // refund leaks Bob's share to Alice
  assert.equal(bs.recoverFromRefund(x, refWit.map(enc), Yb, encA), x.ed_to_secp_scalar(bobShare));

  // tx_punish: spend cancel(punish branch) alone after relative T2
  const punish = bs.spendTemplate(btc, {
    prevTxid: '03'.repeat(32), vout: 0, prevAmount: 99000,
    prevScriptPubKeyHex: enc(cancelWsh.script), witnessScriptHex: cScriptHex,
    outAddress: btc.p2wpkh(Buffer.from(pubA, 'hex'), NET).address, outAmount: 98000, network: NET,
    sequence: bs.relSequenceBlocks(t2),
  });
  const sigAP = x.ecdsa_sign(keyAP, punish.sighashHex);
  const punWit = btc.RawTx.decode(Uint8Array.from(Buffer.from(bs.finalizePunish(btc, punish.tx, cScriptHex, sigAP).hex, 'hex'))).witnesses[0];
  // pin the ELSE-branch witness layout: [sigAP||01, empty(FALSE), cancelScript]
  assert.equal(punWit.length, 3);
  assert.equal(punWit[1].length, 0, 'ELSE selector must be empty(FALSE)');
  assert.equal(x.ecdsa_verify(pubAP, punish.sighashHex, enc(bs.derToCompact(punWit[0].slice(0, -1)))), true);
  assert.equal(x.ecdsa_verify(pubA, punish.sighashHex, enc(bs.derToCompact(punWit[0].slice(0, -1)))), false, 'punish key != cooperative key');
});

test('derToCompact + guards reject malformed input', () => {
  assert.throws(() => bs.derToCompact('3008020105020107'), /malformed DER|length mismatch|der/); // declared len 8 != actual
  assert.throws(() => bs.relSequenceBlocks(70000), /1\.\.65535/);
  assert.throws(() => bs.cancelScript(btc, '00'.repeat(33), '00'.repeat(33), '00'.repeat(33), 70000), /65535/);
});
