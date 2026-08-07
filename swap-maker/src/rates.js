// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/rates: a FIXED nominal rate per pair. This is plumbing over the
 * faucet, not a market: no price discovery, no spread. Both coins use 1e8 sats,
 * so the conversion is a direct multiply in sats.
 *
 *   price = tBTC per tLTC (e.g. 0.00082)
 *   tLTC -> tBTC : recvSats = floor(sendSats * price)
 *   tBTC -> tLTC : recvSats = floor(sendSats / price)
 *
 * An optional feePct (default 0) is exposed in quotes but kept at 0 to stay
 * "infrastructure, not an economy."
 */
export class Rates {
  constructor({ tbtc_per_tltc, feePct = 0 } = {}) {
    if (!(tbtc_per_tltc > 0)) throw new Error('rates: tbtc_per_tltc must be > 0');
    this.price = tbtc_per_tltc;
    this.feePct = Math.max(0, Math.min(0.5, feePct));
  }

  rateFor(from, to) {
    if (from === 'tLTC' && to === 'tBTC') return this.price;
    if (from === 'tBTC' && to === 'tLTC') return 1 / this.price;
    throw new Error(`unsupported pair ${from}->${to}`);
  }

  /** sats in -> { recvSats, rate, feeSats } */
  quote(from, to, sendSats) {
    const rate = this.rateFor(from, to);
    const gross = sendSats * rate;
    const feeSats = Math.floor(gross * this.feePct);
    const recvSats = Math.max(0, Math.floor(gross) - feeSats);
    return { recvSats, rate, feeSats };
  }
}
