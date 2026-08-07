// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-taker entry. Re-exports the pure (dependency-injected) taker engine plus the
 * browser relay/esplora adapters. `loadNodeDeps()` is a convenience for Node
 * (tests, the CLI taker) that bare-imports swap-core + swap-xmr and loads the WASM
 * crypto, returning the dep bundle the taker functions expect. Browsers inject their
 * own vendored deps instead of calling this.
 */
export * from './taker.js';
export { connectRelay } from './relay.js';
export { esploraChain } from './esplora.js';

/** Node-only: assemble { sc, x, btc, as, driver } for the injected taker functions. */
export async function loadNodeDeps() {
  await import('./buffer-shim.js');
  const sc = await import('@testnetswap/swap-core');
  const { loadXmrCrypto, adaptorswap, driver } = await import('@testnetswap/swap-xmr');
  const x = await loadXmrCrypto();
  return { sc, x, btc: sc.btc, as: adaptorswap, driver };
}
