// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/test/quote-fields: coverage for the additive quote fields a taker relies on to clamp a
 * send BEFORE committing (the wallet's "Max" button + "Maker range" hint read these). Two invariants
 * per pair:
 *
 *   1. the quote message actually carries the new fields
 *      HTLC quote : min_sats, max_sats, liquidity_free_sats
 *      xmr_quote  : min_pico, max_pico, max_concurrent, free
 *   2. ADVERTISED == ENFORCED: an amount at the advertised max is accepted (a quote comes back) and
 *      one sat/pico past it is rejected with amount_out_of_band. A taker that trusts the advertised
 *      band must never be bounced by a stricter hidden band.
 *
 * Run: `node --test` in swap-maker (workspace deps must be installed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sc from '@testnetswap/swap-core';
import { Maker } from '../src/maker.js';
import { Rates } from '../src/rates.js';
import { Limits } from '../src/limits.js';
import { Pools } from '../src/pools.js';
import { createXmrHandler } from '../src/xmr-handler.js';

// ---- HTLC quote (Maker.onRequestQuote), driven with the REAL Rates/Limits/Pools ----

function makeHtlcMaker({ min = 10000, max = 200000, total = 5_000_000 } = {}) {
  const pools = new Pools(['tBTC', 'tLTC']);
  pools.setTotal('tBTC', total);
  const rates = new Rates({ tbtc_per_tltc: 0.5 });                 // tLTC->tBTC: recvSats = floor(sendSats * 0.5)
  const limits = new Limits({ per_coin: { tLTC: { min_send_sats: min, max_send_sats: max } } });
  const maker = new Maker({
    cfg: { fee_rate: 2 }, chains: {}, wallet: {}, pools, rates, limits,
    log: { info() {}, warn() {}, error() {} }, store: { load: () => [], save() {} }, stats: null,
  });
  const sent = [];
  maker.send = (_sid, msg) => sent.push(msg);                      // capture instead of hitting the relay
  return { maker, sent, pools };
}

test('HTLC quote carries min_sats / max_sats / liquidity_free_sats', () => {
  const { maker, sent, pools } = makeHtlcMaker({ min: 10000, max: 200000, total: 5_000_000 });
  maker.onRequestQuote('sid-a', { from: 'tLTC', to: 'tBTC', send_sats: 100000 });
  assert.equal(sent.length, 1);
  const q = sent[0];
  assert.equal(q.type, 'quote');
  assert.equal(q.min_sats, 10000);
  assert.equal(q.max_sats, 200000);
  assert.equal(q.liquidity_free_sats, pools.free('tBTC'));         // free receive-coin depth the taker clamps to
  assert.equal(q.liquidity_free_sats, 5_000_000);
});

test('HTLC advertised max_sats == enforced band (at max ok, +1 rejected)', () => {
  const { maker, sent } = makeHtlcMaker({ min: 10000, max: 200000 });
  maker.onRequestQuote('sid-at', { from: 'tLTC', to: 'tBTC', send_sats: 200000 });    // exactly the advertised max
  assert.equal(sent.at(-1).type, 'quote');
  maker.onRequestQuote('sid-over', { from: 'tLTC', to: 'tBTC', send_sats: 200001 });  // one sat past it
  assert.equal(sent.at(-1).code, 'amount_out_of_band');
});

test('HTLC advertised min_sats == enforced band (at min ok, -1 rejected)', () => {
  const { maker, sent } = makeHtlcMaker({ min: 10000, max: 200000 });
  maker.onRequestQuote('sid-min', { from: 'tLTC', to: 'tBTC', send_sats: 10000 });
  assert.equal(sent.at(-1).type, 'quote');
  maker.onRequestQuote('sid-under', { from: 'tLTC', to: 'tBTC', send_sats: 9999 });
  assert.equal(sent.at(-1).code, 'amount_out_of_band');
});

test('HTLC quote below the maker payout depth is a coded no_liquidity, never a quote', () => {
  const { maker, sent } = makeHtlcMaker({ min: 10000, max: 200000, total: 1000 });   // pool cannot fund recvSats
  maker.onRequestQuote('sid-liq', { from: 'tLTC', to: 'tBTC', send_sats: 100000 });   // recvSats 50000 > free 1000
  assert.equal(sent.at(-1).type !== 'quote', true);
  assert.equal(sent.at(-1).code, 'no_liquidity');
});

// ---- xmr_quote (createXmrHandler, quote_only path - returns before any Monero crypto / chain I/O) ----

// rate 0.03 tBTC/XMR is deliberate: at the advertised min_pico (1e9) it makes lock_sats = round(1e9/1e12
// * 0.03 * 1e8) = 3000, which clears quoteFor's hidden MIN_SETTLE_LOCK_SATS floor (546 + 2*1000 = 2546).
// A lower rate (e.g. the 0.01 default) would leave lock_sats = 1000 < 2546, so a request AT the advertised
// min is bounced as amount_out_of_band and advertised != enforced at the bottom of the band -- a real
// maker-side quirk (min_pico is a config floor, not the rate-dependent EFFECTIVE min). This suite asserts
// the invariant under a config where the floor does not bind; see the note handed to the operator.
function makeXmrHandler({ min_pico = 1_000_000_000, max_pico = 50_000_000_000, free = 500000, rate = 0.03 } = {}) {
  return createXmrHandler({
    x: {}, btc: {}, cfg: { xmr: { min_pico, max_pico, rate_tbtc_per_xmr: rate } },
    log: { info() {}, warn() {}, error() {} },
    makeChains: () => ({}), settleCoins: ['tBTC'], supportedNetworks: ['testnet'],
    sendCoinNetworkFor: () => 'testnet', rateFor: () => rate,
    getFreeLiq: () => ({ tBTC: free }), maxConcurrent: 4,
    deriveKm: () => ({}), store: null, sha256: sc.sha256, bytesToHex: sc.bytesToHex,
  });
}

async function xmrQuote(h, send_pico) {
  const sent = [];
  await h.onMessage('s-' + send_pico, { type: 'xmr_request_quote', from: 'tXMR', to: 'tBTC', send_pico, quote_only: true }, (_sid, m) => sent.push(m));
  return sent.at(-1);
}

test('xmr_quote carries min_pico / max_pico / max_concurrent / free', async () => {
  const h = makeXmrHandler({ min_pico: 1_000_000_000, max_pico: 50_000_000_000, free: 500000 });
  const q = await xmrQuote(h, 5_000_000_000);
  assert.equal(q.type, 'xmr_quote');
  assert.equal(q.min_pico, 1_000_000_000);
  assert.equal(q.max_pico, 50_000_000_000);
  assert.equal(q.max_concurrent, 4);
  assert.equal(q.free, 500000);
  assert.equal(q.xmr_pico, 5_000_000_000);
  assert.ok(q.lock_sats > 0);
});

test('xmr advertised pico band == enforced (at max ok, +1 out of band; below min out of band)', async () => {
  const h = makeXmrHandler({ min_pico: 1_000_000_000, max_pico: 50_000_000_000 });
  assert.equal((await xmrQuote(h, 50_000_000_000)).type, 'xmr_quote');       // exactly max_pico
  assert.equal((await xmrQuote(h, 50_000_000_001)).code, 'amount_out_of_band'); // one pico past it
  assert.equal((await xmrQuote(h, 1_000_000_000)).type, 'xmr_quote');        // exactly min_pico
  assert.equal((await xmrQuote(h, 999_999_999)).code, 'amount_out_of_band'); // one pico below it
});

test('xmr advertises the EFFECTIVE min when the settle-lock floor binds at a low rate', async () => {
  // At rate 0.001 the raw config min (1e9) locks only round(1e9 * 0.001 / 1e4) = 100 sats, far below
  // MIN_SETTLE_LOCK_SATS (2546), so a request AT the config min is not quotable...
  const h = makeXmrHandler({ rate: 0.001, min_pico: 1_000_000_000, max_pico: 50_000_000_000 });
  assert.equal((await xmrQuote(h, 1_000_000_000)).code, 'amount_out_of_band');
  // ...so the maker must advertise the raised EFFECTIVE min = ceil(2546 * 1e4 / 0.001) = 25_460_000_000,
  // and a request AT that advertised min actually succeeds (advertised == enforced, the whole point).
  const q = await xmrQuote(h, 25_460_000_000);
  assert.equal(q.type, 'xmr_quote');
  assert.equal(q.min_pico, 25_460_000_000);
});
