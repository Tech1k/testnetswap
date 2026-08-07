// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Cumulative service stats. The maker is the single counterparty to every swap, so it can
 * tally global all-time totals, but terminal swaps get reaped ~a day after they settle, so
 * we accumulate counts + volume into a persisted file BEFORE reaping. Each swap is recorded
 * exactly once (the caller gates on swap.counted). This only OBSERVES terminal states; it
 * never touches swap-critical logic, and is best-effort (a failed save is swallowed).
 */
const FRESH = () => ({ completed: 0, refunded: 0, failed: 0, volume: {}, by_pair: {}, by_day: {}, first_at: null, last_at: null });

export class Stats {
  /** @param {{load():any[], save(a:any[]):void}} store  a FileStore (stores a 1-element array). */
  constructor(store) {
    this.store = store;
    let d = null;
    try { const loaded = store && store.load(); d = Array.isArray(loaded) ? loaded[0] : loaded; } catch { d = null; }
    this.d = (d && typeof d === 'object')
      ? { ...FRESH(), ...d, volume: { ...(d.volume || {}) }, by_pair: { ...(d.by_pair || {}) }, by_day: { ...(d.by_day || {}) } }
      : FRESH();
  }

  /** Record one terminal swap. Caller MUST gate on swap.counted so this runs once per swap. */
  record(swap) {
    const st = swap && swap.state;
    if (st === 'completed') this.d.completed++;
    else if (st === 'refunded') this.d.refunded++;
    else if (st === 'failed') this.d.failed++;
    else return; // 'aborted' etc., not a real outcome
    // Coerce to a finite unix-seconds value: a bad updatedAt must not make new Date().toISOString()
    // throw below (which, uncaught, would leave the swap uncounted-yet-terminal and re-count forever).
    let ts = Number(swap.updatedAt);
    if (!Number.isFinite(ts) || ts <= 0) ts = Math.floor(Date.now() / 1000);
    if (!this.d.first_at) this.d.first_at = ts;
    this.d.last_at = ts;
    if (st === 'completed') {
      this._vol(swap.from, swap.sendSats); // taker sent this much of `from`
      this._vol(swap.to, swap.recvSats);   // and received this much of `to`
      const pair = swap.from + '->' + swap.to;
      this.d.by_pair[pair] = (this.d.by_pair[pair] || 0) + 1;
    }
    // Daily bucket for the trend chart. Kept small by pruning to the most recent 200 days.
    const day = new Date(ts * 1000).toISOString().slice(0, 10);
    const b = (this.d.by_day[day] = this.d.by_day[day] || { completed: 0, refunded: 0, volume: {} });
    if (st === 'completed') { b.completed++; b.volume[swap.from] = (b.volume[swap.from] || 0) + swap.sendSats; b.volume[swap.to] = (b.volume[swap.to] || 0) + swap.recvSats; }
    else if (st === 'refunded') b.refunded++;
    const days = Object.keys(this.d.by_day);
    if (days.length > 200) days.sort().slice(0, days.length - 200).forEach((k) => delete this.d.by_day[k]);
    this._save();
  }

  _vol(coin, sats) { if (coin && sats > 0) this.d.volume[coin] = (this.d.volume[coin] || 0) + sats; }
  _save() { try { if (this.store) this.store.save([this.d]); } catch { /* best-effort */ } }

  /** Public snapshot for /api/stats. */
  snapshot() {
    const settled = this.d.completed + this.d.refunded;
    return {
      completed: this.d.completed,
      refunded: this.d.refunded,
      failed: this.d.failed,
      total: this.d.completed + this.d.refunded + this.d.failed,
      success_rate: settled ? Math.round((this.d.completed / settled) * 1000) / 1000 : null,
      volume: { ...this.d.volume },   // sats moved per coin (both legs of completed swaps)
      by_pair: { ...this.d.by_pair },
      by_day: { ...this.d.by_day },   // { 'YYYY-MM-DD': { completed, refunded, volume:{coin:sats} } }
      first_at: this.d.first_at,
      last_at: this.d.last_at,
    };
  }
}
