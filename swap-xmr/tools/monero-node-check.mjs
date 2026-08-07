// SPDX-License-Identifier: AGPL-3.0-or-later
// Liveness check: can monero-ts reach the remote testnet/stagenet daemons and
// create/sync a wallet against them? (Prerequisite for the live lock/sweep.)
import moneroTs from 'monero-ts';
const NODES = {
  testnet: 'https://xmr-testnet-node.librenode.com', // the actual restricted-RPC daemon
};
async function daemonHeight(uri) {
  const r = await fetch(uri.replace(/\/+$/, '') + '/get_height');
  if (!r.ok) throw new Error('get_height ' + r.status);
  return Number((await r.json()).height);
}
for (const [net, uri] of Object.entries(NODES)) {
  try {
    const height = await daemonHeight(uri); // plain endpoint (matches the wallet)
    const w = await moneroTs.createWalletFull({ // random wallet: no restoreHeight
      networkType: moneroTs.MoneroNetworkType[net.toUpperCase()],
      server: { uri }, password: '',
    });
    const addr = await w.getPrimaryAddress();
    const daemonH = await w.getDaemonHeight().catch(() => '?');
    console.log(`${net}: get_height=${height} | wallet sees daemonHeight=${daemonH} | addr=${addr.slice(0, 14)}… | OK`);
    await w.close();
  } catch (e) {
    console.log(`${net}: FAILED (${e.message})`);
  }
}
process.exit(0);
