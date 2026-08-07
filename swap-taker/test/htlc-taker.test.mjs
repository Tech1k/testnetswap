// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the shared HTLC taker (runHtlcTaker) against the REAL Maker daemon over an
// in-memory relay + a UTXO-simulating mock chain: taker funds -> maker funds ->
// taker redeems (reveals secret) -> maker extracts secret + claims. Real swap-core
// crypto + tx building. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sc from '../../swap-core/src/index.js';
import { Maker } from '../../swap-maker/src/maker.js';
import { Wallet } from '../../swap-maker/src/wallet.js';
import { Pools } from '../../swap-maker/src/pools.js';
import { Rates } from '../../swap-maker/src/rates.js';
import { Limits } from '../../swap-maker/src/limits.js';
import { runHtlcTaker, refundHtlc, redeemHtlc, genHtlcKeys, htlcFundingAddress } from '../src/taker.js';

const enc = (u) => Buffer.from(u).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

// A compact UTXO-simulating chain shared by the maker and the taker for one coin.
function mockChain(net) {
  const utxos = {};   // address -> [{txid,vout,value,status}]
  const txs = {};     // txid -> {vin,vout,status}
  const spent = {};   // "txid:vout" -> spenderTxid
  let seedN = 0;
  const height = 100;
  const addrOf = (script) => { try { return sc.btc.Address(net).encode(sc.btc.OutScript.decode(script)); } catch { return null; } };
  const txidOf = (hex) => sc.bytesToHex(sc.sha256(fromHex(hex)));
  const api = {
    seed(address, value) { const txid = sc.bytesToHex(sc.sha256(fromHex('5eed' + (seedN++).toString(16).padStart(4, '0')))); (utxos[address] = utxos[address] || []).push({ txid, vout: 0, value, status: { confirmed: true } }); txs[txid] = { vin: [], vout: [{ scriptpubkey: '', value }], status: { confirmed: true, block_height: height } }; return txid; },
    async getUtxos(address) { return (utxos[address] || []).filter((u) => !spent[u.txid + ':' + u.vout]); },
    async getOutput(txid, vout) { const t = txs[txid]; if (!t || !t.vout[vout]) return null; const o = t.vout[vout]; return { scriptpubkey: o.scriptpubkey, scriptPubKeyHex: o.scriptpubkey, value: o.value, confirmed: true, confirmations: 1 }; },
    async broadcast(hex) {
      const tx = sc.btc.RawTx.decode(fromHex(hex));
      const txid = txidOf(hex);
      const vin = tx.inputs.map((inp, i) => { const itxid = enc(inp.txid); spent[itxid + ':' + inp.index] = txid; return { txid: itxid, vout: inp.index, witness: (tx.witnesses && tx.witnesses[i] ? tx.witnesses[i].map(enc) : []) }; });
      const vout = tx.outputs.map((o, i) => { const address = addrOf(o.script); const rec = { scriptpubkey: enc(o.script), value: Number(o.amount), scriptpubkey_address: address }; if (address) (utxos[address] = utxos[address] || []).push({ txid, vout: i, value: Number(o.amount), status: { confirmed: true } }); return rec; });
      txs[txid] = { vin, vout, status: { confirmed: true, block_height: height } };
      return txid;
    },
    async getTx(txid) { const t = txs[txid]; if (!t) throw new Error('no tx ' + txid); return { vin: t.vin, vout: t.vout, status: t.status }; },
    async getOutspend(txid, vout) { const s = spent[txid + ':' + vout]; return s ? { spent: true, txid: s, vin: 0 } : { spent: false }; },
    async getTipHeight() { return height; },
    async confirmations(txid) { return txs[txid] ? 1 : 0; },
  };
  return api;
}

test('full HTLC swap: shared taker + real maker (tLTC -> tBTC), redeem + maker claim', async () => {
  const FROM = 'tLTC', TO = 'tBTC';
  const chains = { tBTC: mockChain(sc.getCoin('tBTC').network), tLTC: mockChain(sc.getCoin('tLTC').network) };

  const cfg = {
    rate: { tbtc_per_tltc: 0.01, feePct: 0 },
    limits: { per_coin: { tLTC: { min_send_sats: 1000, max_send_sats: 100000000 }, tBTC: { min_send_sats: 1000, max_send_sats: 100000000 } }, max_concurrent_committed: 20, max_concurrent_per_peer: 5, rate_limit_per_peer: 100, rate_window_ms: 60000 },
    min_confirmations: 0, fee_rate: 2, t1_hours: 12, t2_hours: 6, quote_ttl_secs: 300,
  };
  const wallet = new Wallet('22'.repeat(32));
  const pools = new Pools(['tBTC', 'tLTC']);
  const rates = new Rates(cfg.rate);
  const limits = new Limits(cfg.limits);
  const store = { load: () => [], save: () => {} };
  const log = { info() {}, warn() {}, error() {} };
  // seed the maker's receive-side (tBTC) pool with confirmed coins
  chains[TO].seed(wallet.address(TO), 10_000_000);

  const maker = new Maker({ cfg, chains, wallet, pools, rates, limits, log, store });
  await maker.init();

  // in-memory transport bridging the taker to maker.onTaker, and maker.send back to the taker
  const SID = 'sid_htlc_1';
  const taker = {
    buf: [], waiters: [],
    send(msg) { maker.onTaker(SID, msg).catch((e) => { const err = { type: 'error', reason: e.message }; this._deliver(err); }); },
    _deliver(m) { const i = this.waiters.findIndex((w) => w.type === m.type); if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m); else this.buf.push(m); },
    recv(type, ms = 20000) { const i = this.buf.findIndex((m) => m.type === type); if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]); return new Promise((res, rej) => { const to = setTimeout(() => { const j = this.waiters.indexOf(w); if (j >= 0) this.waiters.splice(j, 1); rej(new Error('recv timeout ' + type)); }, ms); const w = { type, resolve: (m) => { clearTimeout(to); res(m); }, reject: rej }; this.waiters.push(w); }); },
  };
  maker.send = (sid, m) => { if (sid === SID) taker._deliver(m); };

  const km = genHtlcKeys(sc);
  // seed the taker's send-side (tLTC) deposit address
  chains[FROM].seed(htlcFundingAddress(sc, km, FROM), 5_000_000);

  const recvAddr = sc.btc.p2wpkh(km.recvPub, sc.getCoin(TO).network).address;
  let redeemBlob = null;
  const res = await runHtlcTaker({ sc, transport: taker, chains, km, params: { from: FROM, to: TO, sendSats: 1_000_000, minConf: 0, feeRate: 2, recvAddr, onBeforeReveal: (rr) => { redeemBlob = rr; }, onStatus: () => {}, setupTimeoutMs: 20000, lockTimeoutMs: 20000 } });

  assert.equal(res.state, 'redeemed', 'taker redeemed the maker tBTC contract');
  assert.ok(res.redeemTxid, 'has a redeem txid');
  assert.ok(res.recvSats > 0, 'received a positive amount');

  // let the maker observe the redeem, extract the secret, and claim the taker's tLTC contract
  for (const s of [...maker.swaps.values()]) await maker.watchMakerLocked(s);
  const makerSwap = [...maker.swaps.values()][0];
  // P1a: the maker's claim is now NON-terminal until it confirms; a second tick (claimTaker) settles it 'completed'.
  assert.ok(['claiming', 'completed'].includes(makerSwap.state), 'maker broadcast the claim (non-terminal)');
  if (makerSwap.state === 'claiming') await maker.claimTaker(makerSwap);
  assert.equal(makerSwap.state, 'completed', 'maker claim confirmed -> completed');
  assert.ok(makerSwap.secret, 'maker learned the secret');

  // P1c: onBeforeReveal persisted a REDEEM-CAPABLE blob before the reveal, and redeemHtlc can re-drive it.
  assert.ok(redeemBlob && redeemBlob.revealed === true, 'onBeforeReveal captured a revealed blob');
  assert.ok(redeemBlob.makerLockTxid && redeemBlob.secretHex && redeemBlob.makerRefundPubkey && redeemBlob.t2 != null,
    'blob carries the maker outpoint + secret + contract fields needed to rebuild the redeem');
  const rr = await redeemHtlc({ sc, chains, recovery: redeemBlob, feeRate: 2, onStatus: () => {} });
  assert.equal(rr.state, 'redeemed', 'redeemHtlc re-drove the redeem from the blob');
  assert.ok(rr.confirmed, 'redeemHtlc drove it to confirmation');
  // guard: a plain (non-redeem-capable) refund blob is rejected, not silently mis-driven
  await assert.rejects(() => redeemHtlc({ sc, chains, recovery: { kind: 'htlc', to: TO } }), /not redeem-capable/);
});

test('HTLC taker surfaces recovery material when the maker never locks', async () => {
  const FROM = 'tLTC', TO = 'tBTC';
  const chains = { tBTC: mockChain(sc.getCoin('tBTC').network), tLTC: mockChain(sc.getCoin('tLTC').network) };
  const km = genHtlcKeys(sc);
  chains[FROM].seed(htlcFundingAddress(sc, km, FROM), 5_000_000);
  // a stub maker that quotes + accepts but never sends maker_locked
  const now = Math.floor(Date.now() / 1000);
  const wallet = new Wallet('33'.repeat(32));
  const taker = {
    buf: [], waiters: [],
    send(msg) {
      if (msg.type === 'request_quote') this._deliver(sc.buildMessage.quote({ from: FROM, to: TO, sendSats: msg.send_sats, recvSats: 10000, rate: 0.01, minSats: 1000, maxSats: 1e8, t1Hours: 12, t2Hours: 6, quoteId: 'q', expiry: now + 300 }));
      else if (msg.type === 'initiate') this._deliver(sc.buildMessage.accept({ quoteId: 'q', from: FROM, to: TO, sendSats: msg.send_sats, recvSats: 10000, t1: now + 12 * 3600, t2: now + 6 * 3600, makerRecvPubkey: sc.bytesToHex(wallet.pubkey(FROM)), makerRefundPubkey: sc.bytesToHex(wallet.pubkey(TO)) }));
      // taker_locked -> (maker vanishes; never sends maker_locked)
    },
    _deliver(m) { const i = this.waiters.findIndex((w) => w.type === m.type); if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m); else this.buf.push(m); },
    recv(type, ms = 2000) { const i = this.buf.findIndex((m) => m.type === type); if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]); return new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('recv timeout ' + type)), ms); this.waiters.push({ type, resolve: (m) => { clearTimeout(to); res(m); }, reject: rej }); }); },
  };
  const recvAddr = sc.btc.p2wpkh(km.recvPub, sc.getCoin(TO).network).address;
  await assert.rejects(
    runHtlcTaker({ sc, transport: taker, chains, km, params: { from: FROM, to: TO, sendSats: 1_000_000, minConf: 0, recvAddr, lockTimeoutMs: 800 } }),
    (e) => { assert.ok(e.recovery && e.recovery.kind === 'htlc' && e.recovery.fundTxid && e.recovery.refundPrivHex && e.recovery.secretHash && e.recovery.makerRecvPubkey, 'error carries a complete HTLC recovery blob'); return true; },
  );
});

// I4 (audit): the theft boundary. A malicious maker posts a maker_locked pointing at an
// UNDERFUNDED output (correct contract address, value < recvSats). The taker MUST reject at
// the funded-output check and NEVER reveal the secret (never spend that output). If it did,
// the maker could keep the taker's send-leg for free.
test('taker refuses an underfunded maker output and never reveals the secret', async () => {
  const FROM = 'tLTC', TO = 'tBTC';
  const chains = { tBTC: mockChain(sc.getCoin('tBTC').network), tLTC: mockChain(sc.getCoin('tLTC').network) };
  const km = genHtlcKeys(sc);
  chains[FROM].seed(htlcFundingAddress(sc, km, FROM), 5_000_000);
  const now = Math.floor(Date.now() / 1000);
  const wallet = new Wallet('44'.repeat(32));
  const t2 = now + 6 * 3600, RECV = 10000;
  let makerFundTxid = null, makerVout = 0;
  const taker = {
    buf: [], waiters: [],
    async send(msg) {
      if (msg.type === 'request_quote') this._deliver(sc.buildMessage.quote({ from: FROM, to: TO, sendSats: msg.send_sats, recvSats: RECV, rate: 0.01, minSats: 1000, maxSats: 1e8, t1Hours: 12, t2Hours: 6, quoteId: 'q', expiry: now + 300 }));
      else if (msg.type === 'initiate') this._deliver(sc.buildMessage.accept({ quoteId: 'q', from: FROM, to: TO, sendSats: msg.send_sats, recvSats: RECV, t1: now + 12 * 3600, t2, makerRecvPubkey: sc.bytesToHex(wallet.pubkey(FROM)), makerRefundPubkey: sc.bytesToHex(wallet.pubkey(TO)) }));
      else if (msg.type === 'taker_locked') {
        // fund the (correctly-addressed) maker contract with LESS than the agreed recvSats
        const makerC = sc.makerContractParams({ secretHash: km.secretHash, takerRecvPubkey: km.recvPub, makerRefundPubkey: wallet.pubkey(TO), t2, recvCoin: TO });
        chains[TO].seed(wallet.address(TO), 1_000_000);
        const utxos = await chains[TO].getUtxos(wallet.address(TO));
        const funding = sc.buildFundingTx({ utxos: wallet.inputsFromUtxos(TO, utxos, { confirmedOnly: true }), contractAddress: makerC.address, amount: RECV - 1, changeAddress: wallet.address(TO), feeRate: 2, network: sc.getCoin(TO).network });
        makerFundTxid = await chains[TO].broadcast(funding.hex); makerVout = funding.vout;
        this._deliver(sc.buildMessage.makerLocked({ quoteId: 'q', contractAddr: makerC.address, fundTxid: makerFundTxid, vout: funding.vout, t2 }));
      }
    },
    _deliver(m) { const i = this.waiters.findIndex((w) => w.type === m.type); if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m); else this.buf.push(m); },
    recv(type, ms = 5000) { const i = this.buf.findIndex((m) => m.type === type); if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]); return new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('recv timeout ' + type)), ms); this.waiters.push({ type, resolve: (m) => { clearTimeout(to); res(m); }, reject: rej }); }); },
  };
  const recvAddr = sc.btc.p2wpkh(km.recvPub, sc.getCoin(TO).network).address;
  await assert.rejects(
    runHtlcTaker({ sc, transport: taker, chains, km, params: { from: FROM, to: TO, sendSats: 1_000_000, minConf: 0, feeRate: 2, recvAddr, onStatus: () => {}, setupTimeoutMs: 20000, lockTimeoutMs: 5000 } }),
    () => true, // any throw is fine; the load-bearing assertion is that S was never revealed
  );
  const outspend = await chains[TO].getOutspend(makerFundTxid, makerVout);
  assert.equal(outspend.spent, false, 'taker did NOT spend (reveal the secret on) the underfunded maker output');
});

// C-1 regression: refundHtlc must build a valid refund tx from a recovery blob that
// has been through a localStorage JSON round-trip (the exact thing that was broken - 
// the blob used to drop scriptPubKey/locktime and store witnessScript as a Uint8Array).
test('refundHtlc rebuilds the contract from a JSON-round-tripped recovery and builds a refund tx', async () => {
  const FROM = 'tLTC';
  const km = genHtlcKeys(sc);
  const makerRecvPub = sc.getPublicKey(sc.randomSecret());
  const t1 = Math.floor(Date.now() / 1000) - 60; // already past so the refund time-gate passes
  const recovery = {
    kind: 'htlc', from: FROM, to: 'tBTC', sendSats: 1_000_000, recvSats: 10000, t1,
    secretHash: sc.bytesToHex(km.secretHash), makerRecvPubkey: sc.bytesToHex(makerRecvPub),
    fundTxid: 'ab'.repeat(32), fundVout: 0, refundPrivHex: sc.bytesToHex(km.refundPriv),
    fundAddr: htlcFundingAddress(sc, km, FROM),
  };
  const round = JSON.parse(JSON.stringify(recovery)); // <-- the localStorage round-trip
  let broadcastedHex = null;
  const chains = { tLTC: { async getOutput() { return { value: 1_000_000 }; }, async broadcast(hex) { broadcastedHex = hex; return 'refund_txid'; } } };
  const r = await refundHtlc({ sc, chains, recovery: round, destAddress: recovery.fundAddr });
  assert.equal(r.state, 'refunded');
  assert.equal(r.refundTxid, 'refund_txid');
  assert.ok(broadcastedHex && broadcastedHex.length > 0, 'a refund tx was actually built + broadcast (no "contract required" throw)');
});
