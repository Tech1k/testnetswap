// SPDX-License-Identifier: AGPL-3.0-or-later
// Standalone validation of the Monero address encoder + WASM key-share math
// against monero-ts (offline, no daemon). Plain script (monero-ts keeps a worker
// pool alive, which fights `node --test` process-isolation), exits explicitly.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import moneroTs from 'monero-ts';
import * as mon from '../src/monero.js';

const require = createRequire(import.meta.url);
const x = require('../crypto/pkg-node/swap_xmr_crypto.js');
const TT = moneroTs.MoneroNetworkType.TESTNET;

let ok = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log('  ✓', name); ok++; };

console.log('1) encoder vs monero-ts (spend-only derived wallet):');
const spend = x.gen_secret_share();
const w = await moneroTs.createWalletKeys({ networkType: TT, privateSpendKey: spend });
const addr = await w.getPrimaryAddress();
const pubSpend = await w.getPublicSpendKey();
const pubView = await w.getPublicViewKey();
const privView = await w.getPrivateViewKey();
check('WASM ed_pubkey(spend) == Monero public spend', x.ed_pubkey(spend) === pubSpend);
check('WASM ed_pubkey(privView) == Monero public view', x.ed_pubkey(privView) === pubView);
check('encodeAddress == monero-ts address', mon.encodeAddress({ pubSpendHex: pubSpend, pubViewHex: pubView, network: 'testnet' }) === addr);
check('testnet address prefix (9/A/B)', /^[9AB]/.test(addr));
console.log('   addr:', addr);

console.log('2) combined swap keys -> lock address accepted by monero-ts (testnet + stagenet):');
for (const network of ['testnet', 'stagenet']) {
  const NT = mon.MONERO_NETWORK_TYPE[network];
  const sA = x.gen_secret_share(), sB = x.gen_secret_share(), vA = x.gen_secret_share(), vB = x.gen_secret_share();
  const combined = mon.combinedPrivateKeys(x, { spendSecretAHex: sA, spendSecretBHex: sB, viewSecretAHex: vA, viewSecretBHex: vB });
  const lock = mon.lockAddress(x, {
    spendShareAHex: x.ed_pubkey(sA), spendShareBHex: x.ed_pubkey(sB),
    viewShareAHex: x.ed_pubkey(vA), viewShareBHex: x.ed_pubkey(vB), network,
  });
  check(`${network}: (s_a+s_b)*G == S_a+S_b`, x.ed_pubkey(combined.privateSpendKey) === lock.pubSpendHex);
  check(`${network}: (v_a+v_b)*G == V_a+V_b`, x.ed_pubkey(combined.privateViewKey) === lock.pubViewHex);
  const cw = await moneroTs.createWalletKeys({
    networkType: NT, privateSpendKey: combined.privateSpendKey,
    privateViewKey: combined.privateViewKey, primaryAddress: lock.address,
  });
  check(`${network}: lock address round-trips through monero-ts`, (await cw.getPrimaryAddress()) === lock.address);
  console.log(`   ${network} lock addr:`, lock.address);
}

console.log(`\nALL ${ok} CHECKS PASSED`);
process.exit(0);
