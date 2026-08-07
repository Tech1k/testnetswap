// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/pools: reservation accounting. The CRITICAL rule (spec §7): quote
 * and commit against FREE liquidity = total (on-chain pool balance) MINUS what's
 * already committed to in-flight swaps. Quoting against raw total over-commits and
 * a swap fails mid-protocol for lack of funds.
 *
 * `total` is refreshed from chain (sum of confirmed pool UTXOs). Reservations are
 * keyed by swapId; on restart the maker re-reserves for each persisted active swap
 * before serving new quotes.
 */
export class Pools {
  constructor(coins) {
    this.total = {};               // coin -> sats (on-chain confirmed pool balance)
    this.reservations = new Map(); // swapId -> { coin, amount }
    for (const c of coins) this.total[c] = 0;
  }

  setTotal(coin, sats) { this.total[coin] = Math.max(0, Math.floor(sats)); }

  committed(coin) {
    let s = 0;
    for (const r of this.reservations.values()) if (r.coin === coin) s += r.amount;
    return s;
  }

  free(coin) { return Math.max(0, (this.total[coin] || 0) - this.committed(coin)); }

  /** Reserve `amount` of `coin` for `swapId`. Returns false if not enough free. */
  reserve(swapId, coin, amount) {
    if (this.reservations.has(swapId)) return true; // idempotent (restart re-reserve)
    if (this.free(coin) < amount) return false;
    this.reservations.set(swapId, { coin, amount: Math.floor(amount) });
    return true;
  }

  release(swapId) { this.reservations.delete(swapId); }
  isReserved(swapId) { return this.reservations.has(swapId); }

  snapshot() {
    const out = {};
    for (const c of Object.keys(this.total)) out[c] = { total: this.total[c], committed: this.committed(c), free: this.free(c) };
    return out;
  }
}
