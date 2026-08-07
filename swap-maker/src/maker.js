// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/maker: the always-on maker. Connects to the relay, answers quotes,
 * reserves liquidity on initiate, verifies the taker's on-chain contract, funds
 * its own contract, then watches the chain to extract the revealed secret and
 * claim, or refunds after the timelock if the taker vanishes.
 *
 * Safety stance (mirrors swap-core/README "what consumers MUST enforce"):
 *   - Reserve against FREE liquidity, never raw total.
 *   - The maker generates the timelocks (computeTimelocks => safe by construction).
 *   - Before locking its own coins, the maker verifies the taker's contract pays
 *     the maker, uses the agreed secret hash + T1, and is FUNDED with >= sendSats
 *     and >= min_confirmations (verifyFundedOutput against an independently
 *     fetched UTXO). A 0-conf accept would let a taker double-spend its funding
 *     after the maker locks, so min_confirmations must be >= 1 in production.
 *   - Swaps are persisted; on restart the maker re-reserves and resumes watching
 *     so it can always refund in-flight contracts.
 */
import { WebSocket } from 'ws';
import * as sc from '@testnetswap/swap-core';
import { makerIdentity } from './identity.js';

const now = () => Math.floor(Date.now() / 1000);
const hx = (b) => sc.bytesToHex(b);

// Promise-chain mutex: serialize a critical section across concurrent async callers. Used to stop two
// concurrent HTLC fundings from selecting the SAME pool UTXOs (deterministic coin selection over one
// getUtxos snapshot) and broadcasting conflicting funding txs. Mirrors xmr-handler's fundLock.
function makeMutex() {
  let chain = Promise.resolve();
  return {
    acquire() {
      let release;
      const next = new Promise((r) => { release = r; });
      const prev = chain;
      chain = chain.then(() => next);
      return prev.then(() => release);
    },
  };
}

export class Maker {
  constructor({ cfg, chains, wallet, pools, rates, limits, log, store, stats }) {
    this.cfg = cfg;
    this.chains = chains;       // { tBTC: Chain, tLTC: Chain }
    this.wallet = wallet;
    this.pools = pools;
    this.rates = rates;
    this.limits = limits;
    this.log = log || console;
    this.store = store;        // { load(): swaps[], save(swaps) }
    this.stats = stats || null; // optional cumulative-stats accumulator (best-effort)
    this.quotes = new Map();   // quoteId -> ephemeral quote
    this.swaps = new Map();    // quoteId -> persisted swap record
    this.xmr = null;           // optional native BTC<->XMR handler (set by main.js)
    this.ws = null;
    this._stop = false;
    this._reconnectMs = 1000;
    this._zeroReads = {};          // per-coin consecutive suspicious empty-balance reads (L2 anti-flap bound)
    this._htlcFundLock = makeMutex(); // L4: serialize HTLC funding so concurrent swaps don't double-select the same pool UTXOs
    // Stable ed25519 relay identity derived from the seed (see identity.js). maker_id = pubkey.
    this.identity = (wallet && wallet.seed) ? makerIdentity(wallet.seed) : null;
  }

  // ---- lifecycle ----

  async init() {
    const loaded = (this.store && this.store.load()) || [];
    for (const s of loaded) {
      this.swaps.set(s.quoteId, s);
      // M1: a 'refunding' swap already released its reservation at the terminal transition
      // (releaseSwap does pools.release + limits.removeSwap before setting 'refunding'), so
      // re-reserving it here would leak liquidity that is never released again; free() would
      // stay understated for the process lifetime. Only re-reserve swaps still holding coins.
      if (!isTerminal(s.state) && s.state !== 'refunding') this.pools.reserve(s.quoteId, s.to, s.recvSats);
    }
    await this.refreshBalances();
    this.log.info(`maker: loaded ${this.swaps.size} swap(s); balances`, this.pools.snapshot());
  }

  start() {
    this.connect();
    this._watch = setInterval(() => this.tick().catch((e) => this.log.error('tick', e.message)), this.cfg.watch_interval_ms || 15000);
    this._bal = setInterval(() => this.refreshBalances().catch(() => {}), this.cfg.balance_interval_ms || 60000);
    this._watch.unref && this._watch.unref();
    this._bal.unref && this._bal.unref();
  }

  stop() {
    this._stop = true;
    clearInterval(this._watch); clearInterval(this._bal); clearInterval(this._announce); clearTimeout(this._reconnectTimer);
    if (this.ws) try { this.ws.close(); } catch {}
  }

  connect() {
    if (this._stop) return;
    // relay_token (M-7: header, not URL) is now an OPTIONAL extra gate for the operator's
    // defaultMaker id; identity is proven via the ed25519 challenge handshake below.
    const url = `${this.cfg.relay_url}?role=maker`;
    const headers = this.cfg.relay_token ? { Authorization: `Bearer ${this.cfg.relay_token}` } : {};
    const ws = new WebSocket(url, { headers });
    this.ws = ws;
    ws.on('open', () => { this.log.info('maker: connected to relay'); this._reconnectMs = 1000; });
    ws.on('message', (data) => {
      let env; try { env = JSON.parse(data.toString()); } catch { return; }
      if (env.type === '_pong') return;
      if (env.type === '_relay_challenge') {
        if (!this.identity) { this.log.error('maker: no relay identity (seed missing); cannot register'); return; }
        const signed = `testnetswap-relay-maker|v1|${env.relay_id}|${env.nonce}|${env.expiry}`;
        try { ws.send(JSON.stringify({ type: 'maker_register', maker_id: this.identity.id, sig: this.identity.sign(signed), info: this.buildInfo() })); } catch (e) { this.log.warn('maker: register send', e.message); }
        return;
      }
      if (env.type === '_relay_hello') { this.log.info(`maker: registered on relay as ${(env.maker_id || '').slice(0, 12)}`); this._startAnnounce(); return; }
      if (env.type === 'error') {
        this.log.error('maker: relay rejected registration:', env.reason);
        // A non-retriable rejection (identity/permission) won't fix itself by reconnecting; stop the
        // loop and tell the operator what to do. Retriable ones (busy/full/timeout) fall through.
        if (['registration not permitted', 'bad maker signature', 'bad maker token'].includes(env.reason)) {
          this._fatal = true;
          this.log.error('maker: not retrying; allow-list this maker_id on the relay (or fix relay_token), then restart');
        }
        return;
      }
      if (!env.sid || !env.msg) return;
      this.onTaker(env.sid, env.msg).catch((e) => this.log.error('onTaker', e.message));
    });
    ws.on('close', () => { clearInterval(this._announce); if (this._stop || this._fatal) return; this.log.warn(`maker: relay closed; reconnecting in ${this._reconnectMs}ms`); this._reconnectTimer = setTimeout(() => this.connect(), this._reconnectMs); this._reconnectTimer.unref && this._reconnectTimer.unref(); this._reconnectMs = Math.min(30000, this._reconnectMs * 2); });
    ws.on('error', (e) => this.log.warn('maker: relay error', e.message));
  }

  // Periodic roster heartbeat so the relay keeps this maker fresh + updates advertised liquidity.
  _startAnnounce() {
    clearInterval(this._announce);
    this._announce = setInterval(() => { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ type: 'maker_announce', info: this.buildInfo() })); } catch {} } }, this.cfg.announce_interval_ms || 20000);
    this._announce.unref && this._announce.unref();
  }

  // Self-reported roster info (mirrors the discovery API). The relay strictly validates it, and
  // the site renders it with textContent only; it's advertising, not trusted data.
  buildInfo() {
    const pairs = sc.SUPPORTED_PAIRS.map(({ from, to }) => {
      const band = this.limits.band(from);
      return { from, to, rate: this.rates.rateFor(from, to), min_sats: band.min, max_sats: band.max, liquidity_free_sats: this.pools.free(to), liquidity_unit: to };
    });
    const info = { pairs };
    if (this.cfg.maker_name) info.name = String(this.cfg.maker_name);
    if (this.cfg.version) info.version = String(this.cfg.version);
    if (this.xmr && typeof this.xmr.caps === 'function') info.xmr = this.xmr.caps();
    if (this.stats) { const s = this.stats.snapshot(); info.stats = { completed: s.completed, refunded: s.refunded, failed: s.failed, success_rate: s.success_rate }; }
    return info;
  }

  send(sid, msg) {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try { this.ws.send(JSON.stringify({ sid, msg })); } catch (e) { this.log.warn('send', e.message); }
    }
  }

  persist() { if (this.store) this.store.save([...this.swaps.values()]); }

  async refreshBalances() {
    const confirmedOnly = this.cfg.pool_confirmed_only !== false;
    for (const coin of Object.keys(this.chains)) {
      try {
        const utxos = await this.chains[coin].getUtxos(this.wallet.address(coin));
        const total = utxos.filter((u) => (confirmedOnly ? !!(u.status && u.status.confirmed) : true)).reduce((s, u) => s + u.value, 0);
        // Anti-flap: a transient empty/degraded read (e.g. the flaky testnetscan API serving tLTC
        // returns [] or all-unconfirmed utxos) computes total=0 with NO exception, unlike a throw
        // which the catch below already turns into last-known-good. Don't let that zero clobber a
        // currently-POSITIVE pool; a phantom 0 makes tBTC->tLTC quotes get refused for insufficient
        // liquidity even though the pool holds funds. Keep last-known-good instead; any positive read
        // is applied immediately as before. Tradeoff: a genuine full drain to 0 keeps showing the
        // last positive until a positive read replaces it (acceptable on testnet, far better than
        // flapping to 0). Startup is unaffected: pools.total starts at 0, so the initial 0 read
        // fails this guard (0 > 0 is false) and setTotal(coin, 0) still applies.
        if (total === 0 && (this.pools.total[coin] || 0) > 0) {
          // L2: ride out a BRIEF flaky-explorer blip by keeping last-known-good, but do NOT keep a
          // phantom-positive pool indefinitely; a sustained empty read (>=3 consecutive polls, ~3 min
          // at balance_interval_ms) is far more likely a real drain, and advertising liquidity the pool
          // no longer holds makes a taker lock then wait until T1 to refund. After the blip window,
          // believe the 0 so the free-liquidity gate refuses new quotes.
          const z = (this._zeroReads[coin] = (this._zeroReads[coin] || 0) + 1);
          if (z <= 2) { this.log.warn(`balance ${coin}`, `empty/degraded read (total 0); keeping last-known-good (${z}/2)`); continue; }
          this.log.warn(`balance ${coin}`, 'sustained empty read; treating pool as drained');
        }
        this.pools.setTotal(coin, total);
        this._zeroReads[coin] = 0;
      } catch (e) { this.log.warn(`balance ${coin}`, e.message); }
    }
  }

  // ---- protocol handling (taker -> maker) ----

  // Every error/abort/xmr_error this maker sends carries a stable machine-readable `code` alongside the
  // human `reason`, so integrators map errors exactly instead of string-sniffing. Canonical set:
  //   bad_message, unexpected_message, rate_limited, unsupported_pair, unsupported_network,
  //   amount_out_of_band, amount_too_small, no_liquidity, liquidity_check_failed, quote_expired,
  //   unknown_quote, quote_mismatch, duplicate_initiate, swap_in_progress, unknown_swap,
  //   peer_at_capacity, maker_at_capacity, contract_mismatch, funded_output_invalid,
  //   window_too_close, maker_fund_failed.  Unknown/absent code = treat as a generic failure.
  async onTaker(sid, msg) {
    if (msg.type === '_taker_gone') { this.onTakerGone(sid); return; }
    // Defense-in-depth: reject prototype-pollution keys before ANY handler (incl. the XMR
    // driver) touches the raw message. sc.parseMessage guards this at the string layer, but the
    // ws ingress already JSON.parsed, so we check the parsed object here (the guard the maker
    // path was missing; no reachable sink today, but keep the raw object clean).
    for (const k of ['__proto__', 'constructor', 'prototype']) if (Object.prototype.hasOwnProperty.call(msg, k)) { this.log.warn('rejected message with forbidden key:', k); return; }
    // Native BTC<->XMR swaps use a distinct message protocol; delegate (additive).
    if (this.xmr && this.xmr.owns(msg)) { return this.xmr.onMessage(sid, msg, (s, m) => this.send(s, m)).catch((e) => this.log.error('xmr onMessage', e.message)); }
    const v = sc.validateMessage(msg);
    if (!v.ok) { this.send(sid, { ...sc.buildMessage.error({ reason: v.reason }), code: 'bad_message' }); return; }
    const nowMs = Date.now();
    if (!this.limits.rateOk(sid, nowMs)) { this.send(sid, { ...sc.buildMessage.error({ reason: 'rate limited' }), code: 'rate_limited' }); return; }

    switch (msg.type) {
      case sc.MsgType.REQUEST_QUOTE: return this.onRequestQuote(sid, msg);
      case sc.MsgType.INITIATE: return this.onInitiate(sid, msg);
      case sc.MsgType.TAKER_LOCKED: return this.onTakerLocked(sid, msg);
      case sc.MsgType.ABORT: return this.onAbort(sid, msg);
      default: this.send(sid, { ...sc.buildMessage.error({ reason: `unexpected message ${msg.type}` }), code: 'unexpected_message' });
    }
  }

  computeQuote(from, to, sendSats) {
    if (!sc.isSupportedPair(from, to)) return { ok: false, code: 'unsupported_pair', reason: 'unsupported pair' };
    const amt = this.limits.checkAmount(from, sendSats);
    if (!amt.ok) return { ok: false, code: 'amount_out_of_band', reason: amt.reason, min: amt.min, max: amt.max };
    const { recvSats, rate, feeSats } = this.rates.quote(from, to, sendSats);
    // The maker funds an HTLC output of recvSats, and buildFundingTx (swap-core/src/tx.js) rejects any
    // output below DUST + the redeem/refund fee. Refuse an undersized quote HERE so the taker never
    // locks against a swap the maker can't fund; otherwise its coins sit stranded until the T1 refund.
    const minHtlc = sc.DUST + Math.ceil(175 * (this.cfg.fee_rate ?? 2));
    if (recvSats < minHtlc) return { ok: false, code: 'amount_too_small', reason: 'amount too small (below the fundable minimum)', min: amt.min, max: amt.max };
    if (this.pools.free(to) < recvSats) return { ok: false, code: 'no_liquidity', reason: 'insufficient maker liquidity', free: this.pools.free(to) };
    return { ok: true, recvSats, rate, feeSats, min: amt.min, max: amt.max };
  }

  onRequestQuote(sid, msg) {
    const q = this.computeQuote(msg.from, msg.to, msg.send_sats);
    if (!q.ok) { this.send(sid, { ...sc.buildMessage.error({ reason: q.reason }), code: q.code }); return; }
    const quoteId = hx(sc.randomSecret()).slice(0, 24);
    const t1Hours = this.cfg.t1_hours ?? sc.DEFAULT_T1_HOURS;
    const t2Hours = this.cfg.t2_hours ?? sc.DEFAULT_T2_HOURS;
    const expiry = now() + (this.cfg.quote_ttl_secs ?? 120);
    this.quotes.set(quoteId, { sid, from: msg.from, to: msg.to, sendSats: msg.send_sats, recvSats: q.recvSats, rate: q.rate, t1Hours, t2Hours, expiry });
    this.send(sid, { ...sc.buildMessage.quote({
      from: msg.from, to: msg.to, sendSats: msg.send_sats, recvSats: q.recvSats, rate: q.rate,
      minSats: q.min, maxSats: q.max, t1Hours, t2Hours, quoteId, expiry,
    }), liquidity_free_sats: this.pools.free(msg.to) });   // free receive-coin depth: a taker can skip a swap that is <= max_sats but > what the maker can pay out (avoids the 'insufficient maker liquidity' bounce)
  }

  onInitiate(sid, msg) {
    // H-2: INITIATE is single-shot; a duplicate must never overwrite a live swap
    // (which would orphan already-locked coins). Reject if this quote already started.
    if (this.swaps.has(msg.quote_id)) { this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'swap already initiated for this quote' }), code: 'duplicate_initiate' }); return; }
    const q = this.quotes.get(msg.quote_id);
    if (!q || q.sid !== sid) { this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'unknown or expired quote' }), code: 'unknown_quote' }); return; }
    if (now() > q.expiry) { this.quotes.delete(msg.quote_id); this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'quote expired' }), code: 'quote_expired' }); return; }
    if (msg.from !== q.from || msg.to !== q.to || msg.send_sats !== q.sendSats) {
      this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'initiate does not match quote' }), code: 'quote_mismatch' }); return;
    }
    if (!this.limits.canStartForPeer(sid)) { this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'too many concurrent swaps for this peer' }), code: 'peer_at_capacity' }); return; }
    if (this.activeCount() >= this.limits.maxConcurrentCommitted) { this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'maker at capacity, try later' }), code: 'maker_at_capacity' }); return; }

    // reserve receive-side liquidity against FREE
    if (!this.pools.reserve(msg.quote_id, q.to, q.recvSats)) {
      this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'insufficient free liquidity' }), code: 'no_liquidity' }); return;
    }

    const { t1, t2 } = sc.computeTimelocks(now(), { t1Hours: q.t1Hours, t2Hours: q.t2Hours });
    const makerRecvPubkey = this.wallet.pubkey(q.from); // recipient of the taker's contract (send chain)
    const makerRefundPubkey = this.wallet.pubkey(q.to); // refund of the maker's contract (receive chain)

    const swap = {
      quoteId: msg.quote_id, sid, from: q.from, to: q.to, sendSats: q.sendSats, recvSats: q.recvSats, rate: q.rate,
      secretHash: msg.secret_hash, takerRecvPubkey: msg.taker_recv_pubkey, takerRefundPubkey: msg.taker_refund_pubkey,
      t1, t2, makerRecvPubkey: hx(makerRecvPubkey), makerRefundPubkey: hx(makerRefundPubkey),
      taker: null, maker: null, secret: null, state: 'accepted', createdAt: now(), updatedAt: now(),
    };
    this.swaps.set(swap.quoteId, swap);
    this.quotes.delete(msg.quote_id); // H-2: consume the quote so it can't drive a second INITIATE
    this.limits.addPeerSwap(sid, swap.quoteId);
    this.persist();
    this.send(sid, sc.buildMessage.accept({ quoteId: swap.quoteId, from: swap.from, to: swap.to, sendSats: swap.sendSats, recvSats: swap.recvSats, t1, t2, makerRecvPubkey: hx(makerRecvPubkey), makerRefundPubkey: hx(makerRefundPubkey) }));
    this.log.info(`swap ${short(swap.quoteId)}: accepted ${swap.sendSats} ${swap.from} -> ${swap.recvSats} ${swap.to}`);
  }

  async onTakerLocked(sid, msg) {
    const swap = this.swaps.get(msg.quote_id);
    if (!swap || swap.sid !== sid) { this.send(sid, { ...sc.buildMessage.error({ quoteId: msg.quote_id, reason: 'unknown swap' }), code: 'unknown_swap' }); return; }
    if (swap.state !== 'accepted') return; // idempotent: already processing/locked
    swap.taker = { contractAddr: msg.contract_addr, fundTxid: msg.fund_txid, vout: msg.vout };
    swap.state = 'taker_locked';
    swap.updatedAt = now();
    this.persist();
    this.log.info(`swap ${short(swap.quoteId)}: taker locked ${msg.fund_txid}:${msg.vout} (verifying on-chain...)`);
    // verification + maker funding happens in the watcher (needs confirmations)
    this.tryFundMaker(swap).catch((e) => this.log.error('fund', e.message));
  }

  onAbort(sid, msg) {
    const swap = msg.quote_id && this.swaps.get(msg.quote_id);
    if (swap && swap.sid === sid && swap.state === 'accepted') {
      // taker aborted before funding: release the reservation, nothing on chain yet
      this.releaseSwap(swap, 'aborted');
      this.log.info(`swap ${short(swap.quoteId)}: aborted by taker (${msg.reason})`);
    }
  }

  onTakerGone(sid) {
    // Drop ephemeral quotes for this peer; in-flight swaps continue (we still hold
    // contracts on chain and must complete or refund regardless of the connection).
    for (const [qid, q] of this.quotes) if (q.sid === sid) this.quotes.delete(qid);
    if (this.xmr) this.xmr.onGone(sid);
  }

  // ---- on-chain orchestration ----

  /** Verify the taker's funded contract, then fund the maker's own contract. */
  async tryFundMaker(swap) {
    // L1: serialize funding per swap. onTakerLocked calls this OUTSIDE the tick mutex, so two
    // concurrent entries could both pass the state check and double-fund. The flag lives off the
    // persisted swap (a crash can't leave it stuck) and is cleared in finally.
    if (swap.state !== 'taker_locked') return;
    const inflight = (this._fundingInFlight ||= new Set());
    if (inflight.has(swap.quoteId)) return;
    inflight.add(swap.quoteId);
    try { await this._doFundMaker(swap); } finally { inflight.delete(swap.quoteId); }
  }

  async _doFundMaker(swap) {
    if (swap.state !== 'taker_locked') return;
    const sendCoin = swap.from, recvCoin = swap.to;
    const secretHash = sc.hexToBytes(swap.secretHash);

    // reconstruct what the taker's contract SHOULD be (pays the maker, locktime T1)
    const expected = sc.takerContractParams({
      secretHash, makerRecvPubkey: this.wallet.pubkey(sendCoin),
      takerRefundPubkey: sc.hexToBytes(swap.takerRefundPubkey), t1: swap.t1, sendCoin,
    });
    if (expected.address !== swap.taker.contractAddr) {
      this.log.warn(`swap ${short(swap.quoteId)}: taker contract address mismatch; refusing`);
      this.releaseSwap(swap, 'failed'); this.send(swap.sid, { ...sc.buildMessage.abort({ quoteId: swap.quoteId, reason: 'contract address mismatch' }), code: 'contract_mismatch' }); return;
    }

    // fetch the funded output independently and bind it
    const out = await this.chains[sendCoin].getOutput(swap.taker.fundTxid, swap.taker.vout);
    if (!out) return; // not visible yet; watcher retries (the SHORT accept_timeout still applies until it is; see the reaper)
    // Mark that the taker's funding is genuinely on-chain. Until this, a taker_locked swap keeps the
    // short accept_timeout, so a never-broadcast / bogus fund_txid can't pin a reservation for 4h.
    if (!swap.taker.fundingSeen) { swap.taker.fundingSeen = true; this.persist(); }
    const fv = sc.verifyFundedOutput({ witnessScript: expected.witnessScript, fundedScriptPubKey: out.scriptpubkey, fundedValueSats: out.value, expectedSats: swap.sendSats, network: sc.getCoin(sendCoin).network });
    if (!fv.ok) { this.log.warn(`swap ${short(swap.quoteId)}: funded output check failed: ${fv.reason}`); this.releaseSwap(swap, 'failed'); this.send(swap.sid, { ...sc.buildMessage.abort({ quoteId: swap.quoteId, reason: fv.reason }), code: 'funded_output_invalid' }); return; }
    const minConf = this.cfg.min_confirmations ?? 3;
    if (!(Number.isFinite(out.confirmations) && out.confirmations >= minConf)) return; // wait for >= minConf REAL confs (NaN/undefined never passes; residual #8)

    swap.taker.value = out.value;

    // the maker's deterministic contract on the receive chain (pays the taker, locktime T2)
    const makerC = sc.makerContractParams({
      secretHash, takerRecvPubkey: sc.hexToBytes(swap.takerRecvPubkey),
      makerRefundPubkey: this.wallet.pubkey(recvCoin), t2: swap.t2, recvCoin,
    });

    // M-3: idempotent funding; MUST run BEFORE the M-5 T2 guard. If a prior (possibly
    // crashed) run already funded this deterministic contract address, adopt that output
    // so the refund-after-T2 path can recover it; refusing here on a tight T2 would
    // strand already-locked coins. L-6: ONLY adopt if WE previously started funding
    // (persisted intent); the contract address is taker-computable, so without this
    // gate a taker could pre-fund it and trick the maker into "adopting" a foreign output.
    if (swap.makerFundingStarted) try {
      const existing = await this.chains[recvCoin].getUtxos(makerC.address);
      const u = (existing || []).find((o) => o.value >= swap.recvSats);
      if (u) {
        swap.maker = { contractAddr: makerC.address, fundTxid: u.txid, vout: u.vout, value: u.value };
        swap.state = 'maker_locked'; swap.updatedAt = now(); this.persist();
        this.send(swap.sid, sc.buildMessage.makerLocked({ quoteId: swap.quoteId, contractAddr: makerC.address, fundTxid: u.txid, vout: u.vout, t2: swap.t2 }));
        this.log.info(`swap ${short(swap.quoteId)}: adopted existing maker funding ${u.txid}:${u.vout} (idempotent)`);
        return;
      }
    } catch { /* contract address has no utxos yet, or fetch failed; proceed below */ }

    // M-5: with nothing yet locked, don't lock NEW coins if our T2 refund window is
    // already too close (e.g. resuming after extended downtime).
    const t2Margin = this.cfg.t2_fund_margin_secs ?? 3600;
    if (now() + t2Margin >= swap.t2) {
      this.log.warn(`swap ${short(swap.quoteId)}: T2 only ${swap.t2 - now()}s away; refusing to fund (refund window too tight)`);
      this.releaseSwap(swap, 'failed'); this.send(swap.sid, { ...sc.buildMessage.abort({ quoteId: swap.quoteId, reason: 'maker refund window too close; aborting' }), code: 'window_too_close' }); return;
    }

    // L4: hold the fund lock across selection -> intent -> broadcast so two concurrent HTLC fundings
    // can't pick the SAME pool UTXOs (deterministic coin selection over one getUtxos snapshot) and
    // broadcast conflicting funding txs. Every early return runs the finally, which releases the lock.
    const releaseFund = await this._htlcFundLock.acquire();
    let funding, txid;
    try {
      let utxos;
      try { utxos = await this.chains[recvCoin].getUtxos(this.wallet.address(recvCoin)); } catch (e) { this.log.warn('getUtxos', e.message); return; }
      const inputs = this.wallet.inputsFromUtxos(recvCoin, utxos, { confirmedOnly: this.cfg.pool_confirmed_only !== false });
      try {
        funding = sc.buildFundingTx({ utxos: inputs, contractAddress: makerC.address, amount: swap.recvSats, changeAddress: this.wallet.address(recvCoin), feeRate: this.cfg.fee_rate ?? 2, network: sc.getCoin(recvCoin).network });
      } catch (e) { this.log.error(`swap ${short(swap.quoteId)}: cannot fund maker contract: ${e.message}`); this.releaseSwap(swap, 'failed'); this.send(swap.sid, { ...sc.buildMessage.abort({ quoteId: swap.quoteId, reason: 'maker could not fund the swap; aborting' }), code: 'maker_fund_failed' }); return; }
      // L-6/M-3: record the funding INTENT before broadcasting, so a crash-resume can
      // safely adopt the (deterministic) contract output, and only ours.
      swap.makerFundingStarted = true; this.persist();
      try { txid = await this.chains[recvCoin].broadcast(funding.hex); }
      catch (e) { this.log.error(`swap ${short(swap.quoteId)}: broadcast maker funding failed: ${e.message}`); return; }
    } finally { releaseFund(); }

    swap.maker = { contractAddr: makerC.address, fundTxid: txid, vout: funding.vout, value: swap.recvSats };
    swap.state = 'maker_locked';
    swap.updatedAt = now();
    this.persist();
    this.send(swap.sid, sc.buildMessage.makerLocked({ quoteId: swap.quoteId, contractAddr: makerC.address, fundTxid: txid, vout: funding.vout, t2: swap.t2 }));
    this.log.info(`swap ${short(swap.quoteId)}: maker locked ${txid}:${funding.vout} (${swap.recvSats} ${recvCoin})`);
  }

  /**
   * Watch a maker-locked OR refunding swap. The XMR-claim-style invariant applies: the
   * maker output is NEVER terminal until the settling tx confirms. On ANY spend we first
   * try to extract the secret, even after we broadcast a refund, because the taker's
   * redeem can RBF/reorg-replace our unconfirmed refund (H2/H3). Only a CONFIRMED own-refund
   * settles 'refunded'.
   */
  async watchMakerLocked(swap) {
    const recvCoin = swap.to;
    let spend;
    try { spend = await this.chains[recvCoin].getOutspend(swap.maker.fundTxid, swap.maker.vout); } catch { spend = null; }
    if (spend && spend.spent && spend.txid) {
      // 1) Try to extract the secret from WHOEVER spent it (a racing/winning redeem reveals it).
      if (spend.txid !== swap.refundTxid) {
        let stx; try { stx = await this.chains[recvCoin].getTx(spend.txid); } catch { stx = null; }
        const secret = stx && sc.extractSecret(stx, sc.hexToBytes(swap.secretHash));
        if (secret) {
          swap.secret = hx(secret); swap.state = 'secret_known'; swap.redeemTxid = spend.txid; swap.updatedAt = now();
          this.persist();
          this.log.info(`swap ${short(swap.quoteId)}: taker revealed secret in ${spend.txid}; claiming taker's contract`);
          return this.claimTaker(swap);
        }
        // Spent by a non-refund tx with no extractable secret yet (mempool/fetch lag). Don't refund.
        this.log.warn(`swap ${short(swap.quoteId)}: maker output spent in ${spend.txid} but secret not extracted yet; retrying`);
        return;
      }
      // 2) Our own refund spent it; settle as 'refunded' only once it CONFIRMS (until then a
      //    higher-fee redeem could still replace it; keep watching).
      let conf = 0; try { conf = await this.chains[recvCoin].confirmations(swap.refundTxid); } catch {}
      if (conf >= (this.cfg.min_confirmations ?? 3)) { if (swap.state !== 'refunded') { swap.state = 'refunded'; swap.updatedAt = now(); this.persist(); this.log.info(`swap ${short(swap.quoteId)}: refund confirmed (${swap.refundTxid})`); } }
      return;
    }
    // not spent yet
    if (swap.state === 'refunding') return this.refundMaker(swap); // our refund didn't land/was dropped; re-broadcast (fee-bumped)
    if (now() > swap.t2 + (this.cfg.refund_margin_secs ?? 600)) return this.refundMaker(swap); // T2 passed, taker never claimed
  }

  /** Maker claims the taker's contract using the revealed secret. */
  async claimTaker(swap) {
    const sendCoin = swap.from;
    const secret = sc.hexToBytes(swap.secret);
    const contract = sc.takerContractParams({
      secretHash: sc.hexToBytes(swap.secretHash), makerRecvPubkey: this.wallet.pubkey(sendCoin),
      takerRefundPubkey: sc.hexToBytes(swap.takerRefundPubkey), t1: swap.t1, sendCoin,
    });
    // H8: re-fetch the taker output (don't trust cached value/outpoint; a 1-conf reorg or
    // double-spend may have removed it). If gone, resolve via the spender or fail loudly
    // instead of looping forever against a non-existent UTXO.
    let o; try { o = await this.chains[sendCoin].getOutput(swap.taker.fundTxid, swap.taker.vout); } catch { o = null; }
    if (!o || !(o.value > 0)) {
      let sp = null; try { sp = await this.chains[sendCoin].getOutspend(swap.taker.fundTxid, swap.taker.vout); } catch {}
      if (sp && sp.spent && sp.txid) return this.settleTakerSpend(swap, sp.txid, sendCoin);
      this.log.error(`swap ${short(swap.quoteId)}: taker output not found (reorg/double-spend?); marking failed`);
      this.releaseSwap(swap, 'failed'); return;
    }
    const value = o.value;
    const feeRate = Math.min(this.bumpFeeRate(swap, 'claimAttempts'), this.affordableFeeRate(value));
    let redeem;
    try {
      redeem = sc.buildRedeemTx({ contract, utxo: { txid: swap.taker.fundTxid, vout: swap.taker.vout, amount: value }, secret, privkey: this.wallet.key(sendCoin), destAddress: this.wallet.address(sendCoin), feeRate, network: sc.getCoin(sendCoin).network });
    } catch (e) { this.log.error(`swap ${short(swap.quoteId)}: build claim failed: ${e.message}`); return; }
    try {
      const txid = await this.chains[sendCoin].broadcast(redeem.hex);
      swap.claimTxid = txid; swap.updatedAt = now();
      this.releaseSwap(swap, 'completed');
      this.log.info(`swap ${short(swap.quoteId)}: COMPLETED: claimed ${txid} (${value} ${sendCoin}, ${feeRate} sat/vB)`);
    } catch (e) {
      // Already spent? Classify the spender; only 'completed' if it paid US (not the taker's
      // own T1 refund). Else retry with a higher fee next tick.
      let sp = null; try { sp = await this.chains[sendCoin].getOutspend(swap.taker.fundTxid, swap.taker.vout); } catch {}
      if (sp && sp.spent && sp.txid) return this.settleTakerSpend(swap, sp.txid, sendCoin);
      this.log.warn(`swap ${short(swap.quoteId)}: claim broadcast failed (will retry, fee bumping): ${e.message}`);
    }
  }

  /** Resolve a spent taker output: 'completed' only if the spender paid the maker; else 'failed'. */
  async settleTakerSpend(swap, spendTxid, sendCoin) {
    let stx = null; try { stx = await this.chains[sendCoin].getTx(spendTxid); } catch {}
    const paysMaker = stx && Array.isArray(stx.vout) && stx.vout.some((v) => v.scriptpubkey_address === this.wallet.address(sendCoin));
    if (paysMaker) { swap.claimTxid = swap.claimTxid || spendTxid; this.releaseSwap(swap, 'completed'); this.log.info(`swap ${short(swap.quoteId)}: taker contract claimed to us (${spendTxid}); completed`); }
    else { this.releaseSwap(swap, 'failed'); this.log.warn(`swap ${short(swap.quoteId)}: taker output spent by ${spendTxid} (not to us, taker refund/reorg); failed`); }
  }

  /** Maker refunds its own contract after T2 when the taker never claimed. */
  async refundMaker(swap) {
    const recvCoin = swap.to;
    if (!swap.maker) { this.releaseSwap(swap, 'failed'); return; }
    const contract = sc.makerContractParams({
      secretHash: sc.hexToBytes(swap.secretHash), takerRecvPubkey: sc.hexToBytes(swap.takerRecvPubkey),
      makerRefundPubkey: this.wallet.pubkey(recvCoin), t2: swap.t2, recvCoin,
    });
    const value = swap.maker.value || swap.recvSats;
    const feeRate = Math.min(this.bumpFeeRate(swap, 'refundAttempts'), this.affordableFeeRate(value));
    let refund;
    try {
      refund = sc.buildRefundTx({ contract, utxo: { txid: swap.maker.fundTxid, vout: swap.maker.vout, amount: value }, privkey: this.wallet.key(recvCoin), destAddress: this.wallet.address(recvCoin), feeRate, network: sc.getCoin(recvCoin).network });
    } catch (e) { this.log.error(`swap ${short(swap.quoteId)}: build refund failed: ${e.message}`); return; }
    try {
      const txid = await this.chains[recvCoin].broadcast(refund.hex);
      swap.refundTxid = txid; swap.updatedAt = now();
      // H3: refund is broadcast but NOT terminal; a racing/higher-fee taker redeem can still
      // replace it. Release the liquidity (coins are returning to the pool) and move to the
      // non-terminal 'refunding' state; watchMakerLocked keeps checking until it CONFIRMS,
      // and still extracts the secret if a redeem wins instead.
      if (swap.state !== 'refunding') { this.pools.release(swap.quoteId); this.limits.removeSwap(swap.quoteId); }
      swap.state = 'refunding'; this.persist();
      this.log.info(`swap ${short(swap.quoteId)}: refund broadcast ${txid} (${feeRate} sat/vB); watching to confirm`);
    } catch (e) {
      // Broadcast failed (CLTV not final / fee too low / already spent). Don't settle here;
      // move to 'refunding' so watchMakerLocked re-examines the spender (could be a redeem!)
      // and re-broadcasts with a higher fee next tick.
      if (swap.state !== 'refunding') { this.pools.release(swap.quoteId); this.limits.removeSwap(swap.quoteId); swap.state = 'refunding'; this.persist(); }
      this.log.warn(`swap ${short(swap.quoteId)}: refund not yet accepted (will retry, fee bumping): ${e.message}`);
    }
  }

  /**
   * Escalating fee rate for refund/claim retries (residual #2): each attempt bumps by
   * fee_bump_step sat/vB up to max_fee_rate, so a stuck low-fee spend is replaced by a
   * higher-fee one (RBF) instead of re-broadcasting identical hex into the same congestion.
   */
  bumpFeeRate(swap, counterKey) {
    const n = (swap[counterKey] = (swap[counterKey] || 0) + 1);
    const base = this.cfg.fee_rate ?? 2;
    const step = this.cfg.fee_bump_step ?? 2;
    const max = this.cfg.max_fee_rate ?? 100;
    return Math.min(base + (n - 1) * step, max);
  }

  /**
   * M1: cap a (possibly escalated) fee rate so a spend of `value` sats never yields a sub-dust output.
   * buildSpend throws once value; ceil(vsize*feeRate) < DUST, which would otherwise leave a near-floor
   * HTLC output PERMANENTLY unspendable at the escalated rate; bumpFeeRate climbs to max_fee_rate, and
   * it bumps every retry, including during the MTP-lag window where a time-locked CLTV refund cannot
   * confirm at ANY fee. 175 vB is the conservative redeem/refund vsize (real ~150), so the output stays
   * >= DUST. Clamping to this makes the spend always broadcast at the best fee the output can afford
   * instead of throwing, which is also the rate that confirms it fastest.
   */
  affordableFeeRate(value) {
    const v = Number(value) || 0;
    return Math.max(1, Math.floor((v - sc.DUST) / 175));
  }

  releaseSwap(swap, finalState) {
    this.pools.release(swap.quoteId);
    this.limits.removeSwap(swap.quoteId);
    if (finalState) swap.state = finalState;
    swap.updatedAt = now();
    this.persist();
  }

  activeCount() { let n = 0; for (const s of this.swaps.values()) if (!isTerminal(s.state)) n++; return n; }

  // ---- the periodic watcher ----

  async tick() {
    // M7: never let two ticks run concurrently over the same swaps (a slow tick past
    // watch_interval_ms would otherwise double-spend claim/refund / double-fund).
    if (this._ticking) return;
    this._ticking = true;
    try {
      this.limits.prune(Date.now());
      // M2: sweep expired quotes so a persistently-connected peer can't grow this.quotes
      // unbounded (the rate limiter caps the rate, not the resident set).
      { const t = now(); for (const [qid, q] of this.quotes) if (t > q.expiry) this.quotes.delete(qid); }
      const acceptTimeout = this.cfg.accept_timeout_secs ?? 1800;
      const takerLockedTimeout = this.cfg.taker_locked_timeout_secs ?? 14400; // 4h, comfortably under T1
      const reapAfter = this.cfg.reap_terminal_secs ?? 86400;
      for (const swap of [...this.swaps.values()]) {
        try {
          // Cumulative stats: tally each terminal swap exactly once, BEFORE it can be reaped.
          // swap.counted persists with the record; the end-of-tick persist() makes it durable.
          // L1/L2: set counted REGARDLESS of a stats hiccup; a throw here must never leave the
          // swap uncounted-yet-terminal, which would re-increment the counters every tick.
          if (isTerminal(swap.state) && !swap.counted) {
            try { if (this.stats) this.stats.record(swap); } catch (e) { this.log.error(`stats ${short(swap.quoteId)}`, e.message); }
            swap.counted = true;
          }
          if (swap.state === 'accepted' && now() - swap.createdAt > acceptTimeout) {
            this.releaseSwap(swap, 'failed'); this.log.info(`swap ${short(swap.quoteId)}: expired (taker never funded)`); continue;
          }
          if (swap.state === 'taker_locked') {
            // M-4/M-5: time out a taker whose funding never confirms; BUT only if we
            // haven't already started/broadcast our own funding (else we'd reap a swap
            // whose maker coins are on-chain). If funding started, fall through to
            // tryFundMaker, which re-adopts the existing output.
            // Until the taker's funding is actually SEEN on-chain, hold only the SHORT accept_timeout, so a
            // never-broadcast fund_txid releases the reservation in minutes, not 4h. Once seen, extend to
            // taker_locked_timeout to wait out confirmations.
            const tlTimeout = (swap.taker && swap.taker.fundingSeen) ? takerLockedTimeout : acceptTimeout;
            if (!swap.makerFundingStarted && now() - swap.updatedAt > tlTimeout) { this.releaseSwap(swap, 'failed'); this.log.info(`swap ${short(swap.quoteId)}: taker_locked timed out (${(swap.taker && swap.taker.fundingSeen) ? 'funding never confirmed' : 'funding never appeared on-chain'}); released`); continue; }
            await this.tryFundMaker(swap);
          }
          else if (swap.state === 'maker_locked' || swap.state === 'refunding') await this.watchMakerLocked(swap);
          else if (swap.state === 'secret_known') await this.claimTaker(swap);
          else if (isTerminal(swap.state) && now() - swap.updatedAt > reapAfter) await this.reapTerminal(swap);
        } catch (e) { this.log.error(`swap ${short(swap.quoteId)} tick`, e.message); }
      }
      this.persist();
    } finally { this._ticking = false; }
  }

  /**
   * Reap a terminal swap record, but NEVER drop a completed/refunded record whose
   * settling tx hasn't confirmed (residual #9), or we'd lose the audit trail for funds
   * that may still sit in a contract. aborted/failed carry no maker funds (released
   * before funding), so they reap freely.
   */
  async reapTerminal(swap) {
    if (swap.state === 'aborted') { this.swaps.delete(swap.quoteId); return; }
    if (swap.state === 'failed') {
      // M5: don't drop a 'failed' record if our funding had started; maker coins may sit at
      // the deterministic contract address (e.g. broadcast succeeded but the persist/response
      // was lost). Keep the record so it can be refunded; only reap once nothing is there.
      if (swap.makerFundingStarted && swap.to) {
        try {
          const makerC = sc.makerContractParams({ secretHash: sc.hexToBytes(swap.secretHash), takerRecvPubkey: sc.hexToBytes(swap.takerRecvPubkey), makerRefundPubkey: this.wallet.pubkey(swap.to), t2: swap.t2, recvCoin: swap.to });
          const u = (await this.chains[swap.to].getUtxos(makerC.address)) || [];
          if (u.length) { this.log.warn(`swap ${short(swap.quoteId)}: 'failed' but ${u.length} output(s) still at maker contract ${makerC.address}; keeping record (needs refund)`); return; }
        } catch { return; } // can't verify the chain; do not delete
      }
      this.swaps.delete(swap.quoteId); return;
    }
    const txid = swap.state === 'completed' ? swap.claimTxid : swap.refundTxid;
    const coin = swap.state === 'completed' ? swap.from : swap.to;
    let conf = 0; try { conf = txid ? await this.chains[coin].confirmations(txid) : 0; } catch {}
    if (conf >= (this.cfg.min_confirmations ?? 3)) this.swaps.delete(swap.quoteId);
    else this.log.warn(`swap ${short(swap.quoteId)}: ${swap.state} but settling tx ${txid || '(none)'} unconfirmed; keeping record`);
  }
}

function isTerminal(state) { return ['completed', 'refunded', 'aborted', 'failed'].includes(state); }
function short(id) { return String(id).slice(0, 8); }
