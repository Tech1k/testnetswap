// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/status: the read-only JSON discovery API (spec §9.1), consumed by
 * the wallet (to quote) and the status site. Same posture as the faucet/pool
 * APIs: all reads, no state mutation, no keys, open CORS, no-store.
 *
 *   GET /api/pairs
 *   GET /api/quote?from=tLTC&to=tBTC&amount=100   (amount in coin units)
 *   GET /api/status
 */
import { createServer } from 'node:http';
import * as sc from '@testnetswap/swap-core';

const SATS = 1e8;
const toCoin = (sats) => Number((sats / SATS).toFixed(8));

export function startStatusServer({ maker, cfg, version, startedAt, log }) {
  const server = createServer((req, res) => {
    const send = (code, obj) => {
      // Every response carries api_version (bumped on breaking schema changes) and
      // generated_at (unix seconds the response was produced) for client cache/version logic.
      const body = JSON.stringify({ ...obj, api_version: 1, generated_at: Math.floor(Date.now() / 1000), source: 'https://github.com/Tech1k/testnetswap' });
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    };
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(400, { ok: false, error: 'bad_request' }); }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }); return res.end(); }
    if (req.method !== 'GET') return send(405, { ok: false, error: 'method_not_allowed' });

    if (url.pathname === '/api/pairs') return send(200, { ok: true, pairs: pairs(maker) });
    if (url.pathname === '/api/quote') return send(200, quote(maker, url.searchParams));
    if (url.pathname === '/api/status') return send(200, status(maker, cfg, version, startedAt));
    if (url.pathname === '/api/stats') return send(200, stats(maker, startedAt));
    return send(404, { ok: false, error: 'not_found' });
  });
  server.listen(cfg.status_port || 8911, cfg.status_host || '127.0.0.1', () =>
    (log || console).info(`status: http://${cfg.status_host || '127.0.0.1'}:${cfg.status_port || 8911}`));
  return { server, stop() { server.close(); } };
}

function pairs(maker) {
  return sc.SUPPORTED_PAIRS.map(({ from, to }) => {
    const band = maker.limits.band(from);
    return {
      from, to,
      rate: maker.rates.rateFor(from, to),
      min: toCoin(band.min), max: toCoin(band.max),
      min_sats: band.min, max_sats: band.max,
      liquidity_free: toCoin(maker.pools.free(to)),
      liquidity_free_sats: maker.pools.free(to),
      liquidity_unit: to,
    };
  });
}

function quote(maker, params) {
  const from = params.get('from'), to = params.get('to');
  const amount = Number(params.get('amount'));
  if (!sc.isSupportedPair(from, to)) return { ok: false, from, to, reason: 'unsupported_pair' };
  if (!(amount > 0)) return { ok: false, from, to, reason: 'bad_amount' };
  const sendSats = Math.round(amount * SATS);
  const q = maker.computeQuote(from, to, sendSats);
  const band = maker.limits.band(from);
  if (!q.ok) return { ok: false, from, to, send: amount, reason: q.reason, min: toCoin(band.min), max: toCoin(band.max) };
  return {
    ok: true, from, to, send: amount, receive: toCoin(q.recvSats),
    send_sats: sendSats, receive_sats: q.recvSats, rate: q.rate, fee: toCoin(q.feeSats || 0),
    min: toCoin(band.min), max: toCoin(band.max),
  };
}

function status(maker, cfg, version, startedAt) {
  const online = !!(maker.ws && maker.ws.readyState === 1);
  const pairsUp = online ? sc.SUPPORTED_PAIRS.filter(({ to }) => maker.pools.free(to) > 0).map((p) => `${p.from}-${p.to}`) : [];
  const liquidity = maker.pools.snapshot();
  // Native tXMR/sXMR -> tBTC capability (adaptor swaps over the relay), so the site can
  // offer exactly the Monero networks this maker serves. { enabled:false } when XMR is off.
  const xmr = (maker.xmr && typeof maker.xmr.caps === 'function') ? maker.xmr.caps() : { enabled: false };
  // Mirror the XMR SETTLE funding addresses' confirmed free balance into the liquidity map, keyed
  // '<coin>:xmr-funding', so /api/stats' liquidity view (stats-page renderLiq parses the base:suffix
  // key) sees XMR-settle depth. This funding address is tracked OUTSIDE the HTLC pool, so committed is
  // always 0 (free == total here); a coin is absent when unfunded / not yet polled.
  if (xmr.enabled && xmr.free) for (const c in xmr.free) liquidity[c + ':xmr-funding'] = { total: xmr.free[c], committed: 0, free: xmr.free[c] };
  return {
    ok: true,
    maker_online: online,
    pairs_up: pairsUp,
    liquidity,
    active_swaps: maker.activeCount(),
    xmr,
    uptime_secs: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null,
    version,
  };
}

function stats(maker, startedAt) {
  const snap = maker.stats ? maker.stats.snapshot() : { completed: 0, refunded: 0, failed: 0, total: 0, success_rate: null, volume: {}, by_pair: {}, first_at: null, last_at: null };
  // Display units, alongside raw volume_sats. XMR volume accumulates in PICO (1e12/XMR), every other
  // coin in sats (1e8); dividing XMR tickers by 1e12 (not toCoin's 1e8) makes the display value actual
  // XMR instead of a 10,000x-inflated number. volume_sats stays RAW (pico for XMR, sats for the rest).
  const volume = {}; for (const c in (snap.volume || {})) volume[c] = /XMR$/i.test(c) ? Number((snap.volume[c] / 1e12).toFixed(12)) : toCoin(snap.volume[c]);
  return {
    ok: true,
    ...snap,
    volume,
    volume_sats: snap.volume,
    active_swaps: maker.activeCount ? maker.activeCount() : 0,
    uptime_secs: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null,
    source: 'https://github.com/Tech1k/testnetswap',
  };
}
