// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for swap-core. Run: node --test  (zero deps; Node built-in runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sc from '../src/index.js';

const fromHex = sc.hexToBytes;
const TAKER_PRIV = fromHex('11'.repeat(32));
const MAKER_PRIV = fromHex('22'.repeat(32));
const TAKER_PUB = sc.getPublicKey(TAKER_PRIV);
const MAKER_PUB = sc.getPublicKey(MAKER_PRIV);
const SECRET = fromHex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
const SECRET_HASH = sc.secretHashOf(SECRET);
const LOCKTIME = 1800000000; // unix time -> time-based CLTV

const btc = sc.btc;
const wpkh = (pub, net) => btc.p2wpkh(pub, net).address;

test('secretHashOf is SHA256 of the secret', () => {
  assert.equal(sc.bytesToHex(SECRET_HASH).length, 64);
  assert.deepEqual(sc.secretHashOf(SECRET), sc.sha256(SECRET));
  assert.throws(() => sc.secretHashOf(fromHex('00')), /32 bytes/);
});

test('hash160 is 20 bytes and matches btc-signer p2pkh', () => {
  const h = sc.hash160(TAKER_PUB);
  assert.equal(h.length, 20);
  assert.deepEqual(h, btc.Script.decode(btc.p2pkh(TAKER_PUB, btc.NETWORK).script)[2]);
});

test('buildContract is deterministic and network-specific', () => {
  const base = { secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME };
  const btcC = sc.buildContract({ ...base, network: sc.BTC_TESTNET4 });
  const ltcC = sc.buildContract({ ...base, network: sc.LTC_TESTNET });
  // same script (network-independent), different addresses (different hrp)
  assert.deepEqual(btcC.witnessScript, ltcC.witnessScript);
  assert.ok(btcC.address.startsWith('tb1'));
  assert.ok(ltcC.address.startsWith('tltc1'));
  assert.equal(btcC.locktimeKind, 'time');
  // rebuild gives identical address
  assert.equal(sc.buildContract({ ...base, network: sc.BTC_TESTNET4 }).address, btcC.address);
});

test('buildContract rejects malformed inputs', () => {
  const ok = { secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 };
  assert.throws(() => sc.buildContract({ ...ok, secretHash: fromHex('00') }), /32 bytes/);
  assert.throws(() => sc.buildContract({ ...ok, recipientPubkey: fromHex('00'.repeat(20)) }), /33-byte/);
  assert.throws(() => sc.buildContract({ ...ok, locktime: 0 }), /positive integer/);
});

test('parseContract round-trips the contract params', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const p = sc.parseContract(c.witnessScript);
  assert.ok(p, 'parse should succeed');
  assert.deepEqual(p.secretHash, SECRET_HASH);
  assert.deepEqual(p.recipientPkh, sc.hash160(TAKER_PUB));
  assert.deepEqual(p.refundPkh, sc.hash160(MAKER_PUB));
  assert.equal(p.locktime, LOCKTIME);
  assert.equal(sc.parseContract(fromHex('deadbeef')), null);
});

test('verifyContract accepts a matching contract and rejects tampering', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const good = sc.verifyContract({
    witnessScript: c.witnessScript, expectedAddress: c.address, expectedSecretHash: SECRET_HASH,
    expectedRecipientPubkey: TAKER_PUB, expectedRefundPubkey: MAKER_PUB, expectedLocktime: LOCKTIME, network: sc.BTC_TESTNET4,
  });
  assert.equal(good.ok, true);

  // wrong recipient (contract would not pay us)
  const badRecip = sc.verifyContract({
    witnessScript: c.witnessScript, expectedAddress: c.address, expectedSecretHash: SECRET_HASH,
    expectedRecipientPubkey: MAKER_PUB, expectedRefundPubkey: MAKER_PUB, expectedLocktime: LOCKTIME, network: sc.BTC_TESTNET4,
  });
  assert.equal(badRecip.ok, false);

  // wrong address (attacker funded a different script)
  const badAddr = sc.verifyContract({
    witnessScript: c.witnessScript, expectedAddress: 'tb1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', expectedSecretHash: SECRET_HASH,
    expectedRecipientPubkey: TAKER_PUB, expectedRefundPubkey: MAKER_PUB, expectedLocktime: LOCKTIME, network: sc.BTC_TESTNET4,
  });
  assert.equal(badAddr.ok, false);

  // wrong locktime
  const badLock = sc.verifyContract({
    witnessScript: c.witnessScript, expectedAddress: c.address, expectedSecretHash: SECRET_HASH,
    expectedRecipientPubkey: TAKER_PUB, expectedRefundPubkey: MAKER_PUB, expectedLocktime: LOCKTIME + 1, network: sc.BTC_TESTNET4,
  });
  assert.equal(badLock.ok, false);
});

test('buildRedeemTx reveals the secret; extractSecret recovers it from hex, raw and witness', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const utxo = { txid: '01'.repeat(32), vout: 0, amount: 100000 };
  const r = sc.buildRedeemTx({
    contract: c, utxo, secret: SECRET, privkey: TAKER_PRIV,
    destAddress: wpkh(TAKER_PUB, sc.BTC_TESTNET4), feeRate: 2, network: sc.BTC_TESTNET4,
  });
  assert.ok(r.hex && r.txid && r.fee > 0);
  // extract from raw hex
  assert.deepEqual(sc.extractSecret(r.hex, SECRET_HASH), SECRET);
  // extract from an Esplora-style object
  const parsed = btc.RawTx.decode(fromHex(r.hex));
  const esplora = { vin: [{ witness: parsed.witnesses[0].map(sc.bytesToHex) }] };
  assert.deepEqual(sc.extractSecret(esplora, SECRET_HASH), SECRET);
  // extract from a witness hex array
  assert.deepEqual(sc.extractSecret(parsed.witnesses[0].map(sc.bytesToHex), SECRET_HASH), SECRET);
  // wrong hash -> null
  assert.equal(sc.extractSecret(r.hex, sc.sha256(fromHex('ff'))), null);
});

test('buildRefundTx sets the locktime and an enabling sequence', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const utxo = { txid: '01'.repeat(32), vout: 0, amount: 100000 };
  const f = sc.buildRefundTx({
    contract: c, utxo, privkey: MAKER_PRIV,
    destAddress: wpkh(MAKER_PUB, sc.BTC_TESTNET4), feeRate: 1, network: sc.BTC_TESTNET4,
  });
  const parsed = btc.RawTx.decode(fromHex(f.hex));
  assert.equal(parsed.lockTime, LOCKTIME);
  assert.ok(parsed.inputs[0].sequence < 0xffffffff, 'sequence must enable locktime');
  // refund witness: [sig, pubkey, FALSE, script] = 4 items (no secret)
  assert.equal(parsed.witnesses[0].length, 4);
  // and none of the items is the secret
  assert.equal(sc.findSecretInWitness(parsed.witnesses[0], SECRET_HASH), null);
});

test('fees floor at min-relay and dust is rejected', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const dest = wpkh(TAKER_PUB, sc.BTC_TESTNET4);
  // tiny input can't cover even the min-relay fee without dust
  assert.throws(() => sc.buildRedeemTx({
    contract: c, utxo: { txid: '01'.repeat(32), vout: 0, amount: 600 }, secret: SECRET,
    privkey: TAKER_PRIV, destAddress: dest, feeRate: 1, network: sc.BTC_TESTNET4,
  }), /dust|too small/);
  // a feeRate below the floor is clamped up to min-relay (fee >= vsize)
  const r = sc.buildRedeemTx({
    contract: c, utxo: { txid: '01'.repeat(32), vout: 0, amount: 100000 }, secret: SECRET,
    privkey: TAKER_PRIV, destAddress: dest, feeRate: 0, network: sc.BTC_TESTNET4,
  });
  assert.ok(r.fee >= r.vsize, 'fee floored at min relay');
});

test('timelocks enforce the load-bearing safety ordering (T1 > T2)', () => {
  const now = 1800000000;
  const { t1, t2 } = sc.computeTimelocks(now, { t1Hours: 12, t2Hours: 6 });
  assert.ok(t2 < t1);
  assert.ok(t1 - t2 >= sc.MIN_T_GAP_SECS);
  // inverted ordering is rejected
  assert.equal(sc.validateTimelocks({ t1: now + 3600, t2: now + 7200, nowSec: now }).ok, false);
  // gap too small is rejected
  assert.equal(sc.validateTimelocks({ t1: now + 7200 + 60, t2: now + 7200, nowSec: now }).ok, false);
  // equal is rejected
  assert.equal(sc.validateTimelocks({ t1: now + 7200, t2: now + 7200, nowSec: now }).ok, false);
});

test('contract role mapping + verification (taker/maker)', () => {
  const t1 = LOCKTIME + 3600, t2 = LOCKTIME;
  // maker builds the receive-chain contract paying the taker
  const makerC = sc.makerContractParams({
    secretHash: SECRET_HASH, takerRecvPubkey: TAKER_PUB, makerRefundPubkey: MAKER_PUB, t2, recvCoin: 'tBTC',
  });
  const v = sc.verifyMakerContract({
    witnessScript: makerC.witnessScript, fundedAddress: makerC.address, secretHash: SECRET_HASH,
    takerRecvPubkey: TAKER_PUB, makerRefundPubkey: MAKER_PUB, t2, recvCoin: 'tBTC',
  });
  assert.equal(v.ok, true);
  // taker builds the send-chain contract paying the maker
  const takerC = sc.takerContractParams({
    secretHash: SECRET_HASH, makerRecvPubkey: MAKER_PUB, takerRefundPubkey: TAKER_PUB, t1, sendCoin: 'tLTC',
  });
  const v2 = sc.verifyTakerContract({
    witnessScript: takerC.witnessScript, fundedAddress: takerC.address, secretHash: SECRET_HASH,
    makerRecvPubkey: MAKER_PUB, takerRefundPubkey: TAKER_PUB, t1, sendCoin: 'tLTC',
  });
  assert.equal(v2.ok, true);
});

test('protocol messages build, serialize, parse and validate', () => {
  const rq = sc.buildMessage.requestQuote({ from: 'tLTC', to: 'tBTC', sendSats: 100_00000000 });
  assert.equal(sc.validateMessage(rq).ok, true);
  const wire = sc.serializeMessage(rq);
  const back = sc.parseMessage(wire);
  assert.equal(back.ok, true);
  assert.deepEqual(back.msg, rq);

  const init = sc.buildMessage.initiate({
    quoteId: 'q1', from: 'tLTC', to: 'tBTC', sendSats: 1000000,
    secretHash: sc.bytesToHex(SECRET_HASH), takerRecvPubkey: sc.bytesToHex(TAKER_PUB), takerRefundPubkey: sc.bytesToHex(TAKER_PUB),
  });
  assert.equal(sc.validateMessage(init).ok, true);

  // malformed: bad pubkey, bad pair, bad amount
  assert.equal(sc.validateMessage({ ...init, taker_recv_pubkey: 'zz' }).ok, false);
  assert.equal(sc.validateMessage({ type: 'request_quote', from: 'tBTC', to: 'tBTC', send_sats: 1 }).ok, false);
  assert.equal(sc.validateMessage({ type: 'accept', quote_id: 'q', recv_sats: 1, t1: 100, t2: 200, maker_recv_pubkey: sc.bytesToHex(MAKER_PUB), maker_refund_pubkey: sc.bytesToHex(MAKER_PUB) }).ok, false); // t2 > t1
  assert.equal(sc.parseMessage('not json').ok, false);
});

// ---- regression tests for the security review fixes ----

test('verifyContract fails CLOSED when an expectation is omitted', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  // omitting expectedAddress must NOT skip the binding; it must fail
  assert.equal(sc.verifyContract({ witnessScript: c.witnessScript, expectedSecretHash: SECRET_HASH, expectedRecipientPubkey: TAKER_PUB, expectedRefundPubkey: MAKER_PUB, expectedLocktime: LOCKTIME, network: sc.BTC_TESTNET4 }).ok, false);
  assert.equal(sc.verifyContract({ witnessScript: c.witnessScript, expectedAddress: c.address, expectedRecipientPubkey: TAKER_PUB, expectedRefundPubkey: MAKER_PUB, expectedLocktime: LOCKTIME, network: sc.BTC_TESTNET4 }).ok, false);
});

test('verifyFundedOutput binds a verified script to real coins', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const spk = sc.bytesToHex(c.scriptPubKey);
  assert.equal(sc.verifyFundedOutput({ witnessScript: c.witnessScript, fundedScriptPubKey: spk, fundedValueSats: 100000, expectedSats: 100000, network: sc.BTC_TESTNET4 }).ok, true);
  assert.equal(sc.verifyFundedOutput({ witnessScript: c.witnessScript, fundedScriptPubKey: '00'.repeat(34), fundedValueSats: 100000, expectedSats: 100000, network: sc.BTC_TESTNET4 }).ok, false); // wrong script
  assert.equal(sc.verifyFundedOutput({ witnessScript: c.witnessScript, fundedScriptPubKey: spk, fundedValueSats: 99999, expectedSats: 100000, network: sc.BTC_TESTNET4 }).ok, false); // underfunded
});

test('buildRedeemTx rejects a secret that does not match the contract hash', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  assert.throws(() => sc.buildRedeemTx({
    contract: c, utxo: { txid: '01'.repeat(32), vout: 0, amount: 100000 }, secret: fromHex('aa'.repeat(32)),
    privkey: TAKER_PRIV, destAddress: wpkh(TAKER_PUB, sc.BTC_TESTNET4), feeRate: 2, network: sc.BTC_TESTNET4,
  }), /does not hash/);
});

test('fee always clears the FINAL tx vsize across many keys/amounts (no stuck refunds)', () => {
  // The original bug underpaid ~25% of refunds (probe vsize vs final vsize). Sweep
  // signature-length variation by using many keys and re-checking fee/vsize.
  for (const s of ['05', '06', '07', '08', '13', '2a', '7f', 'c3']) {
    const rp = sc.getPublicKey(fromHex(s.repeat(32)));
    const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: rp, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
    for (const amount of [9000, 12000, 50000, 120000]) {
      const f = sc.buildRefundTx({ contract: c, utxo: { txid: '01'.repeat(32), vout: 0, amount }, privkey: fromHex(s.repeat(32)), destAddress: wpkh(rp, sc.BTC_TESTNET4), feeRate: 1, network: sc.BTC_TESTNET4 });
      assert.ok(f.fee >= Math.ceil(f.vsize * 1), `fee ${f.fee} must clear min-relay for vsize ${f.vsize} (seed ${s}, amt ${amount})`);
      const f2 = sc.buildRefundTx({ contract: c, utxo: { txid: '01'.repeat(32), vout: 0, amount }, privkey: fromHex(s.repeat(32)), destAddress: wpkh(rp, sc.BTC_TESTNET4), feeRate: 3, network: sc.BTC_TESTNET4 });
      assert.ok(f2.fee >= Math.ceil(f2.vsize * 3), `fee ${f2.fee} must clear 3 sat/vB for vsize ${f2.vsize}`);
    }
  }
});

test('extractSecret handles an array of already-decoded byte items', () => {
  const c = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: TAKER_PUB, refundPubkey: MAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const r = sc.buildRedeemTx({ contract: c, utxo: { txid: '01'.repeat(32), vout: 0, amount: 100000 }, secret: SECRET, privkey: TAKER_PRIV, destAddress: wpkh(TAKER_PUB, sc.BTC_TESTNET4), feeRate: 2, network: sc.BTC_TESTNET4 });
  const witnessBytes = btc.RawTx.decode(fromHex(r.hex)).witnesses[0]; // array of Uint8Array
  assert.deepEqual(sc.extractSecret(witnessBytes, SECRET_HASH), SECRET);
});

test('protocol rejects unsafe accepts, unsafe amounts, same-pair quotes and proto keys', () => {
  const now = 1800000000;
  const { t1, t2 } = sc.computeTimelocks(now);
  const goodAccept = sc.buildMessage.accept({ quoteId: 'q', from: 'tLTC', to: 'tBTC', sendSats: 1000000, recvSats: 1000, t1, t2, makerRecvPubkey: sc.bytesToHex(MAKER_PUB), makerRefundPubkey: sc.bytesToHex(MAKER_PUB) });
  assert.equal(sc.validateMessage(goodAccept).ok, true);
  // accept must now carry the pair + send_sats (I-4)
  assert.equal(sc.validateMessage({ ...goodAccept, from: undefined }).ok, false);
  // sub-gap timelocks rejected
  assert.equal(sc.validateMessage({ ...goodAccept, t1: t2 + 60 }).ok, false);
  // height-based (small) timelocks rejected
  assert.equal(sc.validateMessage({ ...goodAccept, t1: 800, t2: 700 }).ok, false);
  // absurd amount rejected
  assert.equal(sc.validateMessage({ type: 'request_quote', from: 'tLTC', to: 'tBTC', send_sats: 1e21 }).ok, false);
  // same-pair quote rejected
  assert.equal(sc.validateMessage({ type: 'quote', from: 'tBTC', to: 'tBTC', send_sats: 1, recv_sats: 1, quote_id: 'q' }).ok, false);
  // prototype-pollution key rejected at parse
  assert.equal(sc.parseMessage('{"type":"abort","__proto__":{"x":1}}').ok, false);
});

test('checkAcceptAgainstQuote binds quote_id + recv_sats + timelock safety', () => {
  const now = 1800000000;
  const { t1, t2 } = sc.computeTimelocks(now);
  const quote = sc.buildMessage.quote({ from: 'tLTC', to: 'tBTC', sendSats: 1000000, recvSats: 820, rate: 0.00082, minSats: 1, maxSats: 5000000000, t1Hours: 12, t2Hours: 6, quoteId: 'q1', expiry: now + 60 });
  const accept = sc.buildMessage.accept({ quoteId: 'q1', from: 'tLTC', to: 'tBTC', sendSats: 1000000, recvSats: 820, t1, t2, makerRecvPubkey: sc.bytesToHex(MAKER_PUB), makerRefundPubkey: sc.bytesToHex(MAKER_PUB) });
  assert.equal(sc.checkAcceptAgainstQuote(quote, accept, now).ok, true);
  assert.equal(sc.checkAcceptAgainstQuote(quote, { ...accept, recv_sats: 1 }, now).ok, false); // maker shorted us
  assert.equal(sc.checkAcceptAgainstQuote(quote, { ...accept, quote_id: 'other' }, now).ok, false);
  assert.equal(sc.checkAcceptAgainstQuote(quote, { ...accept, send_sats: 999 }, now).ok, false); // send_sats binding (I-4)
  assert.equal(sc.checkAcceptAgainstQuote(quote, { ...accept, to: 'tLTC' }, now).ok, false);     // pair binding (I-4)
});

// ---- audit hardening: timelock/amount bounds that prevent stranded funds ----

test('timelock upper bounds reject out-of-range and over-long refund horizons', () => {
  const now = 1800000000;
  const OVER = sc.MAX_CLTV_TIME + 1;   // past the policy time ceiling (rejected by validateTimelocks)
  const SIX_BYTE = 0x8000000000;       // 549755813888: needs a 6-byte CScriptNum -> BIP65-invalid CLTV
  // rejected by validateTimelocks (with or without nowSec)
  assert.equal(sc.validateTimelocks({ t1: OVER, t2: now + 6 * 3600, nowSec: now }).ok, false);
  assert.equal(sc.validateTimelocks({ t1: OVER, t2: now + 6 * 3600 }).ok, false);
  // buildContract must never MINT an unspendable contract (the funding party builds its own)
  assert.throws(() => sc.buildContract({
    secretHash: SECRET_HASH, recipientPubkey: MAKER_PUB, refundPubkey: TAKER_PUB, locktime: SIX_BYTE, network: sc.BTC_TESTNET4,
  }), /5-byte CLTV maximum|unspendable/);
  // an in-range but absurdly-far-future t1 is rejected by the duration cap
  assert.equal(sc.validateTimelocks({ t1: now + sc.MAX_SWAP_SECS + 3600, t2: now + 6 * 3600, nowSec: now }).ok, false);
  // a normal 12h/6h pair still passes
  assert.equal(sc.validateTimelocks({ t1: now + 12 * 3600, t2: now + 6 * 3600, nowSec: now }).ok, true);
});

test('checkAcceptAgainstQuote rejects a maker that inflates t1 beyond the quote', () => {
  const now = 1800000000;
  const quote = sc.buildMessage.quote({ from: 'tLTC', to: 'tBTC', sendSats: 10000000, recvSats: 8200, rate: 0.00082, minSats: 1, maxSats: 6000000000, t1Hours: 12, t2Hours: 6, quoteId: 'q1', expiry: now + 120 });
  const base = { quoteId: 'q1', from: 'tLTC', to: 'tBTC', sendSats: 10000000, recvSats: 8200, makerRecvPubkey: sc.bytesToHex(MAKER_PUB), makerRefundPubkey: sc.bytesToHex(MAKER_PUB) };
  const acc = (t1, t2) => sc.buildMessage.accept({ ...base, t1, t2 });
  assert.equal(sc.checkAcceptAgainstQuote(quote, acc(now + 12 * 3600, now + 6 * 3600), now).ok, true);   // honest
  assert.equal(sc.checkAcceptAgainstQuote(quote, acc(now + 100 * 3600, now + 6 * 3600), now).ok, false); // inflated t1 (>2x quote)
  assert.equal(sc.checkAcceptAgainstQuote(quote, acc(sc.MAX_CLTV_TIME + 1, now + 6 * 3600), now).ok, false); // out of range
});

test('buildFundingTx refuses a near-dust HTLC that could not pay its own spend', () => {
  const contract = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: MAKER_PUB, refundPubkey: TAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const changeAddr = wpkh(TAKER_PUB, sc.BTC_TESTNET4);
  const utxos = [{ inp: { txid: '11'.repeat(32), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: btc.p2wpkh(TAKER_PUB, sc.BTC_TESTNET4).script, amount: 100000n } }, key: TAKER_PRIV }];
  // 600 sats is above dust (546) but can't cover a redeem/refund fee -> rejected now (was silently accepted)
  assert.throws(() => sc.buildFundingTx({ utxos, contractAddress: contract.address, amount: 600, changeAddress: changeAddr, feeRate: 2, network: sc.BTC_TESTNET4 }), /minimum HTLC/);
});

test('verifyFundedOutput rejects a non-positive expectedSats (amount binding must not no-op)', () => {
  const contract = sc.buildContract({ secretHash: SECRET_HASH, recipientPubkey: MAKER_PUB, refundPubkey: TAKER_PUB, locktime: LOCKTIME, network: sc.BTC_TESTNET4 });
  const r = sc.verifyFundedOutput({ witnessScript: contract.witnessScript, fundedScriptPubKey: contract.scriptPubKey, fundedValueSats: 100000, expectedSats: -5, network: sc.BTC_TESTNET4 });
  assert.equal(r.ok, false);
});
