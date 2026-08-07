// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/limits: the real control surface (spec §7), not price. Caps that
 * keep one swap from draining a pool and kill griefing via abandoned swaps that
 * lock liquidity until the timelock.
 *
 *   per-coin min/max send amount   (max << pool so we serve many before refill)
 *   max_concurrent_committed       (global cap on in-flight swaps)
 *   max_concurrent_per_peer        (1-2; abandoned-swap griefing)
 *   rate_limit_per_peer / window   (like the faucet)
 *
 * "Peer" is the relay session id (the maker never sees IPs; the relay enforces
 * per-IP connection caps as the outer layer).
 */
export class Limits {
  constructor(cfg = {}) {
    this.perCoin = cfg.per_coin || {};
    this.maxConcurrentCommitted = cfg.max_concurrent_committed ?? 20;
    this.maxConcurrentPerPeer = cfg.max_concurrent_per_peer ?? 2;
    this.rateLimitPerPeer = cfg.rate_limit_per_peer ?? 30;
    this.rateWindowMs = cfg.rate_window_ms ?? 60000;
    this.peerHits = new Map();   // sid -> [timestamps]
    this.peerSwaps = new Map();  // sid -> Set(swapId)
  }

  /** Check a send amount is within the configured band for that coin. */
  checkAmount(coin, sendSats) {
    const c = this.perCoin[coin] || {};
    const min = c.min_send_sats ?? 1000;
    const max = c.max_send_sats ?? 100000000;
    if (sendSats < min) return { ok: false, reason: `below minimum (${min} sats)`, min, max };
    if (sendSats > max) return { ok: false, reason: `above maximum (${max} sats)`, min, max };
    return { ok: true, min, max };
  }

  band(coin) {
    const c = this.perCoin[coin] || {};
    return { min: c.min_send_sats ?? 1000, max: c.max_send_sats ?? 100000000 };
  }

  rateOk(sid, nowMs) {
    const arr = (this.peerHits.get(sid) || []).filter((t) => nowMs - t < this.rateWindowMs);
    this.peerHits.set(sid, arr);
    // Defense-in-depth: don't grow the bucket for OVER-limit calls, so the maker's own memory bound
    // doesn't depend on the relay's upstream per-conn cap. Same boundary as before (the Nth call in a
    // window passes, the N+1th rejects); rejected calls just no longer inflate the array.
    if (arr.length >= this.rateLimitPerPeer) return false;
    arr.push(nowMs);
    return true;
  }

  peerConcurrency(sid) { return (this.peerSwaps.get(sid) || new Set()).size; }

  canStartForPeer(sid) { return this.peerConcurrency(sid) < this.maxConcurrentPerPeer; }

  addPeerSwap(sid, swapId) {
    if (!this.peerSwaps.has(sid)) this.peerSwaps.set(sid, new Set());
    this.peerSwaps.get(sid).add(swapId);
  }

  removeSwap(swapId) {
    for (const [sid, set] of this.peerSwaps) { if (set.delete(swapId) && set.size === 0) this.peerSwaps.delete(sid); }
  }

  // periodic cleanup of idle rate buckets
  prune(nowMs) {
    for (const [sid, arr] of this.peerHits) {
      const live = arr.filter((t) => nowMs - t < this.rateWindowMs);
      if (live.length) this.peerHits.set(sid, live); else this.peerHits.delete(sid);
    }
  }
}
