// SPDX-License-Identifier: AGPL-3.0-or-later
// LIVE Monero round-trip (testnet) proving the swap's Monero side end to end:
//   gen shares -> derive combined LOCK address (S_a+S_b / V_a+V_b)
//   faucet -> funding wallet -> LOCK xmr to the combined address
//   detect the locked output with a view-only (combined view key) wallet
//   restore a wallet from the COMBINED private keys (s_a+s_b / v_a+v_b) and SWEEP
// This is the Monero analogue of tools/btc-adaptor-livetest.mjs. Slow: Monero
// outputs need 10 confirmations (~20 min) to unlock, twice. Runs unattended.
import { createRequire } from 'node:module';
import moneroTs from 'monero-ts';
import * as mon from '../src/monero.js';

const require = createRequire(import.meta.url);
const x = require('../crypto/pkg-node/swap_xmr_crypto.js');

const NODE = 'https://xmr-testnet-node.librenode.com';
const NET = 'testnet';
const NT = mon.MONERO_NETWORK_TYPE[NET];
const LOCK_AMT = 5_000_000_000n; // 0.005 XMR (piconero); faucet gives 0.01
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the public restricted node drops connections under load; retry with re-sync
async function retry(label, fn, { wallet, tries = 8, waitMs = 20000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      log(`  retry ${label} (${i + 1}/${tries}): ${e.message}`);
      await sleep(waitMs);
      if (wallet) { try { await wallet.sync(); } catch {} }
    }
  }
  throw new Error(`${label} failed after ${tries} retries`);
}

// Get the daemon height via monero-ts (Node's global fetch chokes on the
// librenode TLS, but monero-ts's own HTTP client works).
async function daemonHeight() {
  const probe = await moneroTs.createWalletFull({ networkType: NT, server: { uri: NODE }, password: '' });
  const h = Number(await probe.getDaemonHeight());
  await probe.close();
  return h;
}
// sync a wallet in a loop until `pred(wallet)` is true or we time out
async function syncUntil(wallet, pred, label, maxMin = 60) {
  const deadline = Date.now() + maxMin * 60_000;
  for (;;) {
    await wallet.sync();
    if (await pred(wallet)) return true;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    const [bal, unl] = [await wallet.getBalance(), await wallet.getUnlockedBalance()];
    log(`  …${label}: bal=${bal} unlocked=${unl} scan=${await wallet.getHeight()}/${await wallet.getDaemonHeight()}`);
    await sleep(30_000);
  }
}

const main = async () => {
  // 1) shares + combined keys + lock address
  const sA = x.gen_secret_share(), sB = x.gen_secret_share(), vA = x.gen_secret_share(), vB = x.gen_secret_share();
  const combined = mon.combinedPrivateKeys(x, { spendSecretAHex: sA, spendSecretBHex: sB, viewSecretAHex: vA, viewSecretBHex: vB });
  const lock = mon.lockAddress(x, {
    spendShareAHex: x.ed_pubkey(sA), spendShareBHex: x.ed_pubkey(sB),
    viewShareAHex: x.ed_pubkey(vA), viewShareBHex: x.ed_pubkey(vB), network: NET,
  });
  log('combined LOCK address:', lock.address);

  const startH = await daemonHeight();
  log('daemon height', startH);

  // 2) funding wallet (deterministic from a fresh share, scan from now), faucet it
  const fundWallet = await moneroTs.createWalletFull({ networkType: NT, server: { uri: NODE }, privateSpendKey: x.gen_secret_share(), restoreHeight: startH, password: '' });
  const fundAddr = await fundWallet.getPrimaryAddress();
  log('funding wallet', fundAddr);
  const cr = await fetch('https://cypherfaucet.com/api/v1/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network: 'xmr-testnet', address: fundAddr }) });
  log('faucet:', cr.status, (await cr.text()).slice(0, 160));
  if (!cr.ok) throw new Error('faucet claim failed');

  // 3) wait for the faucet output to be UNLOCKED, then LOCK to the combined address
  await syncUntil(fundWallet, async (w) => (await w.getUnlockedBalance()) >= LOCK_AMT + 100_000_000n, 'faucet unlock');
  const lockH = Number(await fundWallet.getDaemonHeight());
  log('locking', LOCK_AMT, 'piconero to the combined address…');
  const lockTxs = await retry('lock createTxs', () => fundWallet.createTxs({ accountIndex: 0, address: lock.address, amount: LOCK_AMT, relay: true }), { wallet: fundWallet });
  const lockTxid = lockTxs[0].getHash();
  log('LOCK tx relayed:', lockTxid, '(at ~height', lockH + ')');

  // 4) detect the locked output with a view-only (combined view key) wallet
  const viewer = await moneroTs.createWalletFull({ networkType: NT, server: { uri: NODE }, primaryAddress: lock.address, privateViewKey: combined.privateViewKey, restoreHeight: lockH, password: '' });
  await syncUntil(viewer, async (w) => (await w.getBalance()) >= LOCK_AMT, 'view-only detect lock');
  log('✓ view-only wallet DETECTED the locked output at the combined address');

  // 5) restore from the COMBINED private keys and SWEEP once unlocked
  log('restoring spend wallet from combined keys; waiting for the lock output to unlock…');
  const ids = await (async () => {
    const w = await moneroTs.createWalletFull({ networkType: NT, server: { uri: NODE }, privateSpendKey: combined.privateSpendKey, privateViewKey: combined.privateViewKey, primaryAddress: lock.address, restoreHeight: lockH, password: '' });
    if ((await w.getPrimaryAddress()) !== lock.address) throw new Error('restored address mismatch!');
    await syncUntil(w, async (ww) => (await ww.getUnlockedBalance()) > 0n, 'lock output unlock');
    const txs = await retry('sweepUnlocked', () => w.sweepUnlocked({ address: fundAddr, relay: true }), { wallet: w }); // sweep back to a known addr
    return txs.map((t) => t.getHash());
  })();
  log('✓ SWEEP relayed:', ids.join(', '));
  log('DONE. Monero side proven live: lock -> detect -> restore-from-combined-keys -> sweep.');
  process.exit(0);
};
main().catch((e) => { log('ERR', e.message); process.exit(1); });
