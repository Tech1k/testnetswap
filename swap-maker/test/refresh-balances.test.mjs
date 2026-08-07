// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the maker's refreshBalances() anti-flap rule (B1): a transient empty/degraded
// read (getUtxos -> [] or all-unconfirmed) must NOT clobber a currently-positive pool,
// so tBTC->tLTC quotes aren't refused for phantom insufficient liquidity when the flaky
// testnetscan API flaps. Real Maker + real Pools against a fake chain client. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Maker } from '../src/maker.js';
import { Pools } from '../src/pools.js';

// A fake chain client whose getUtxos returns whatever the test queues next.
function fakeChain() {
  const chain = { next: [], async getUtxos() { return chain.next; } };
  return chain;
}

// Minimal Maker wired for refreshBalances() only (cfg/chains/wallet/pools/log).
function makeMaker(coin) {
  const pools = new Pools([coin]);
  const chain = fakeChain();
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const maker = new Maker({
    cfg: {}, chains: { [coin]: chain }, wallet: { address: (c) => 'addr_' + c },
    pools, log, rates: null, limits: null, store: null, stats: null,
  });
  return { maker, pools, chain };
}

// a confirmed utxo of the given value
const confirmed = (value) => ({ txid: 'tx', vout: 0, value, status: { confirmed: true } });

test('refreshBalances: positive-then-empty keeps the last-known-good positive total', async () => {
  const { maker, pools, chain } = makeMaker('tLTC');
  chain.next = [confirmed(500000)];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 500000, 'positive read is applied');
  // the flaky API now returns [] (or drops all utxos) with NO exception
  chain.next = [];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 500000, 'transient empty read does NOT zero a positive pool');
});

test('refreshBalances: positive-then-empty also ignores an all-unconfirmed (degraded) read', async () => {
  const { maker, pools, chain } = makeMaker('tLTC');
  chain.next = [confirmed(500000)];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 500000);
  // utxos present but none confirmed -> computed total is 0 under confirmedOnly (default)
  chain.next = [{ txid: 'tx2', vout: 0, value: 700000, status: { confirmed: false } }];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 500000, 'all-unconfirmed read is treated as degraded, kept last-known-good');
});

test('refreshBalances: positive-then-positive updates to the new total', async () => {
  const { maker, pools, chain } = makeMaker('tLTC');
  chain.next = [confirmed(500000)];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 500000);
  chain.next = [confirmed(300000), confirmed(200000)];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 500000, 'sum of new confirmed utxos');
  chain.next = [confirmed(123456)];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 123456, 'a new positive read replaces the old total (down or up)');
});

test('refreshBalances: initial empty read stays 0 (startup path unaffected)', async () => {
  const { maker, pools, chain } = makeMaker('tLTC');
  assert.equal(pools.total.tLTC, 0, 'pool starts at 0');
  chain.next = [];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 0, 'an empty read while the pool is 0 keeps it 0 (guard only protects a positive pool)');
});

test('refreshBalances: a SUSTAINED empty read is believed after the blip window (L2)', async () => {
  const { maker, pools, chain } = makeMaker('tLTC');
  chain.next = [confirmed(500000)];
  await maker.refreshBalances();
  assert.equal(pools.total.tLTC, 500000);
  chain.next = [];
  await maker.refreshBalances(); assert.equal(pools.total.tLTC, 500000, 'blip 1 kept');
  await maker.refreshBalances(); assert.equal(pools.total.tLTC, 500000, 'blip 2 kept');
  await maker.refreshBalances(); assert.equal(pools.total.tLTC, 0, 'sustained empty (3rd) is believed -> pool drained, quotes now refused');
  chain.next = [confirmed(400000)];
  await maker.refreshBalances(); assert.equal(pools.total.tLTC, 400000, 'a positive read restores and re-arms the blip counter');
});

test('affordableFeeRate clamps so a near-floor output stays spendable (M1)', () => {
  const { maker } = makeMaker('tBTC');
  assert.equal(maker.affordableFeeRate(1000), 2, '1000-sat output affords ~2 sat/vB (floor((1000-546)/175))');
  assert.equal(maker.affordableFeeRate(546), 1, 'at DUST -> min-relay floor of 1, never 0');
  assert.equal(maker.affordableFeeRate(100), 1, 'sub-dust value -> still 1, never 0 or negative');
  assert.ok(maker.affordableFeeRate(1_000_000) > 100, 'a large output affords a high fee rate');
});
