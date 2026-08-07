// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../src/swap.js';

test('roles: taker sending XMR is Alice; maker (Bob) is liveness-critical', () => {
  const r = s.assignRoles({ takerSends: 'tXMR', takerReceives: 'tBTC' });
  assert.equal(r.takerRole, s.Role.ALICE_XMR);
  assert.equal(r.makerRole, s.Role.BOB_BTC);
  assert.equal(r.scriptChain, 'tBTC');
  assert.equal(r.livenessCriticalParty, 'maker');
  assert.equal(r.takerIsLivenessCritical, false);
});

test('roles: taker sending BTC is Bob (liveness-critical); maker is Alice', () => {
  const r = s.assignRoles({ takerSends: 'tBTC', takerReceives: 'tXMR' });
  assert.equal(r.takerRole, s.Role.BOB_BTC);
  assert.equal(r.makerRole, s.Role.ALICE_XMR);
  assert.equal(r.scriptChain, 'tBTC');
  assert.equal(r.takerIsLivenessCritical, true);
  // sanity: LTC works too
  assert.equal(s.assignRoles({ takerSends: 'sXMR', takerReceives: 'tLTC' }).scriptChain, 'tLTC');
  assert.throws(() => s.assignRoles({ takerSends: 'tBTC', takerReceives: 'tLTC' }), /one side must be XMR/);
});

test('timelocks validate and reject unsafe windows', () => {
  assert.equal(s.validateXmrTimelocks(s.defaultXmrTimelocks('tBTC')).ok, true);
  assert.equal(s.validateXmrTimelocks({ t1: 3, t2: 72 }).ok, false);    // too tight
  assert.equal(s.validateXmrTimelocks({ t1: 20, t2: 72 }).ok, false);   // T1 < MIN_T1_BLOCKS (22)
  assert.equal(s.validateXmrTimelocks({ t1: 72, t2: 6 }).ok, false);    // T2 < MIN_T_BLOCKS (12)
  assert.equal(s.validateXmrTimelocks({ t1: 70000, t2: 72 }).ok, false); // > BIP68 max
  // audit M2: an absurd-but-BIP68-valid lock (~455 days) is rejected by the operational cap
  assert.equal(s.validateXmrTimelocks({ t1: 65535, t2: 65535 }).ok, false);
  assert.equal(s.validateXmrTimelocks({ t1: s.MAX_T_BLOCKS + 1, t2: 72 }).ok, false);
  assert.equal(s.validateXmrTimelocks({ t1: s.MAX_T_BLOCKS, t2: 72 }).ok, true); // at the cap is allowed
});

test('state machine: happy path and refund/punish branches', () => {
  const S = s.XmrSwapState;
  assert.ok(s.canTransition(S.CREATED, S.BTC_LOCKED));
  assert.ok(s.canTransition(S.BTC_LOCKED, S.XMR_LOCKED));
  assert.ok(s.canTransition(S.XMR_LOCKED, S.BTC_REDEEMED));
  assert.ok(s.canTransition(S.BTC_REDEEMED, S.COMPLETED));
  assert.ok(s.canTransition(S.CANCELLED, S.REFUNDED));
  assert.ok(s.canTransition(S.CANCELLED, S.PUNISHED));
  assert.ok(!s.canTransition(S.CREATED, S.COMPLETED));
  assert.ok(s.isTerminal(S.COMPLETED) && s.isTerminal(S.PUNISHED) && !s.isTerminal(S.BTC_LOCKED));
});
