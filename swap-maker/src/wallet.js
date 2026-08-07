// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/wallet: the maker's keys and pool addresses. The maker only needs
 * keys IT controls (not BIP32 interop), so we derive one deterministic pool key
 * per coin from a 32-byte config seed: priv(coin) = SHA256(seed || coin || i),
 * retrying i until it's a valid secp256k1 scalar. Deterministic => the maker can
 * always reconstruct its keys (and thus refund in-flight contracts) after a crash.
 *
 * v1 reuses the single pool key per coin for both the funding pool and the
 * contract recipient/refund pubkeys. Per-swap key derivation is a future privacy
 * hardening; testnet has no privacy stakes.
 */
import * as sc from '@testnetswap/swap-core';

const enc = new TextEncoder();

function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function deriveKey(seedBytes, coin) {
  for (let i = 0; i < 256; i++) {
    const cand = sc.sha256(concat(seedBytes, enc.encode(coin), new Uint8Array([i])));
    try { sc.getPublicKey(cand); return cand; } catch { /* invalid scalar, bump i */ }
  }
  throw new Error('could not derive a valid key (impossible)');
}

export class Wallet {
  constructor(seedHex) {
    if (typeof seedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(seedHex))
      throw new Error('wallet seed must be 32-byte hex (64 chars)');
    this.seed = sc.hexToBytes(seedHex);
    this._keys = new Map();
  }

  key(coin) {
    if (!this._keys.has(coin)) this._keys.set(coin, deriveKey(this.seed, coin));
    return this._keys.get(coin);
  }

  pubkey(coin) {
    return sc.getPublicKey(this.key(coin));
  }

  /** The maker's pool / payout address for a coin (native segwit p2wpkh). */
  address(coin) {
    const net = sc.getCoin(coin).network;
    return sc.btc.p2wpkh(this.pubkey(coin), net).address;
  }

  /** scriptPubKey for the pool address (used to build spendable inputs). */
  script(coin) {
    const net = sc.getCoin(coin).network;
    return sc.btc.p2wpkh(this.pubkey(coin), net).script;
  }

  /** Turn raw Esplora UTXOs into { inp, key } funding inputs for buildFundingTx. */
  inputsFromUtxos(coin, utxos, { confirmedOnly = true } = {}) {
    const script = this.script(coin);
    const key = this.key(coin);
    return utxos
      .filter((u) => (confirmedOnly ? !!(u.status && u.status.confirmed) : true))
      .map((u) => ({
        inp: { txid: u.txid, index: u.vout, sequence: 0xfffffffd, witnessUtxo: { script, amount: BigInt(u.value) } },
        key,
        value: u.value,
      }));
  }
}

/** Generate a fresh random 32-byte seed (hex), for first-run setup. */
export function randomSeedHex() {
  return sc.bytesToHex(sc.randomSecret());
}
