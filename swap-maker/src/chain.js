// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/chain: a tiny Esplora client (mempool.space / litecoinspace shape).
 * Primary endpoint per coin comes from config (your own Esplora HTTP (electrs) once you
 * point it there); falls back to the next URL on error. Read-only + broadcast.
 */
const TIMEOUT_MS = 15000;
const READ_TRIES = 3;          // attempts per endpoint for a READ before failing over / giving up:
const RETRY_BACKOFF_MS = 300;  // rides out transient explorer blips (e.g. an ElectrumX/Fulcrum reconnect
                               // answering /address/../utxo with "invalid_argument"), which matter most
                               // for a single-explorer coin like tLTC that has no fail-over target.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Chain {
  /** @param {string[]} apis ordered list of Esplora base URLs (primary first) */
  constructor(apis) {
    this.apis = Array.isArray(apis) ? apis.slice() : [apis];
  }

  async _fetch(path, opts = {}, validate, tries = READ_TRIES) {
    let lastErr;
    const n = Math.max(1, tries | 0);
    for (const base of this.apis) {
      for (let attempt = 0; attempt < n; attempt++) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort('timeout'), TIMEOUT_MS);
        try {
          const r = await fetch(base + path, { ...opts, signal: ac.signal });
          const text = await r.text();
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
          if (validate) validate(text); // reject a non-conformant body so we fall over to the next URL
          return text;
        } catch (e) {
          lastErr = e;
        } finally { clearTimeout(t); }
        if (attempt < n - 1) await sleep(RETRY_BACKOFF_MS * (attempt + 1)); // brief backoff before the next attempt
      }
    }
    throw new Error(`chain request failed (${path}): ${lastErr && lastErr.message}`);
  }

  async _json(path, opts, validate) {
    const t = await this._fetch(path, opts, validate);
    try { return JSON.parse(t); } catch { throw new Error(`bad JSON from ${path}`); }
  }

  getUtxos(address) {
    return this._json(`/address/${encodeURIComponent(address)}/utxo`);
  }

  getTx(txid) {
    return this._json(`/tx/${encodeURIComponent(txid)}`);
  }

  /** Esplora outspend: who (if anyone) spent output `vout` of `txid`. */
  getOutspend(txid, vout) {
    // CRITICAL: the maker extracts the HTLC secret from the SPENDING tx, keyed by the
    // outspend's `txid` (see watchMakerLocked / maker.js). An Esplora variant that answers a
    // spent output with a truncated {"spent":true} that OMITS `txid` would silently break
    // secret extraction and lose the maker's funds. (testnetscan.com had this bug; it now
    // returns the full {spent,txid,vin,status} shape, verified live, but we keep this guard
    // as defense-in-depth.) Reject the truncated shape so _fetch falls over to the next
    // (conformant) URL rather than returning it. NOTE: tLTC currently ships a SINGLE explorer
    // (litecoinspace testnet is stalled), so there is no fail-over target for that coin; an
    // accepted testnet-only risk; run your own Esplora HTTP (electrs) for any real-value deployment.
    return this._json(`/tx/${encodeURIComponent(txid)}/outspend/${vout}`, undefined, (text) => {
      let j; try { j = JSON.parse(text); } catch { throw new Error('bad outspend JSON'); }
      if (j && j.spent === true && (typeof j.txid !== 'string' || !j.txid))
        throw new Error('outspend missing txid (non-conformant explorer)');
    });
  }

  async getTipHeight() {
    const t = await this._fetch('/blocks/tip/height');
    const h = parseInt(String(t).trim(), 10);
    if (!Number.isInteger(h) || h < 0) throw new Error('bad tip height: ' + String(t).slice(0, 40));
    return h;
  }

  async broadcast(hex) {
    // tries=1: never auto-retry a broadcast. A re-POST of an already-accepted tx returns an error
    // ("txn-already-in-mempool" / "already known") that would mask a success as a failure.
    const t = await this._fetch('/tx', { method: 'POST', body: hex }, undefined, 1);
    return t.trim(); // txid
  }

  /** Confirmations for a txid (0 if unconfirmed/unknown). */
  async confirmations(txid) {
    try {
      const tx = await this.getTx(txid);
      if (!tx.status || !tx.status.confirmed) return 0;
      const tip = await this.getTipHeight();             // throws on a bad/NaN tip -> caught -> 0
      const bh = Number(tx.status.block_height);
      if (!Number.isInteger(tip) || !Number.isInteger(bh)) return 0;  // never return NaN
      return Math.max(0, tip - bh + 1);
    } catch { return 0; }
  }

  /**
   * Fetch a specific output: returns { scriptpubkey, value, confirmed, confirmations }
   * or null if the tx/output isn't found yet.
   */
  async getOutput(txid, vout) {
    let tx;
    try { tx = await this.getTx(txid); } catch { return null; }
    const o = tx.vout && tx.vout[vout];
    if (!o) return null;
    let confirmations = 0;
    if (tx.status && tx.status.confirmed) {
      try {
        const tip = await this.getTipHeight();           // throws on a bad/NaN tip -> caught -> stays 0
        const bh = Number(tx.status.block_height);
        if (Number.isInteger(tip) && Number.isInteger(bh)) confirmations = Math.max(0, tip - bh + 1);
      } catch {}
    }
    return { scriptpubkey: o.scriptpubkey, value: o.value, confirmed: !!(tx.status && tx.status.confirmed), confirmations };
  }
}
