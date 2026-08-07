// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker/xmr-handler: makes the maker daemon offer native BTC<->XMR swaps,
 * additively (it never touches the HTLC path). The relay is a dumb {sid,msg} pipe,
 * so XMR-protocol messages route straight through; this handler runs the proven
 * `bobSwap` driver per taker session over a transport bound to that sid.
 *
 * Direction: tXMR -> tBTC (taker = Alice/XMR provider, maker = BOB/BTC provider,
 * liveness-critical, exactly the role the always-on maker should hold). The maker
 * funds tx_lock from a DEDICATED tBTC funding address (separate from the HTLC pool,
 * so the two paths never select the same UTXO) and sweeps the received XMR to its
 * own Monero address.
 *
 * Admission control (H-1): every swap start is gated by an injected rate/limit
 * `gate(sid)`, a global concurrency cap, and an internal liquidity reservation
 * against the dedicated funding address's confirmed balance. tx_lock funding is
 * serialized by a mutex so concurrent swaps can't double-select a UTXO.
 *
 * Preamble (then the driver bundle-exchange begins):
 *   taker -> maker : xmr_request_quote { from, to, send_pico, quote_only? }
 *   maker -> taker : xmr_quote { lock_sats, xmr_pico, t1_blocks, t2_blocks, rate, network }
 */
import { driver, adaptorswap as as, defaultXmrTimelocks } from '@testnetswap/swap-xmr';

const DRIVER_TYPES = new Set(['bundle', 'lock_outpoint', 'cancel_presig', 'refund_adaptor', 'btc_locked', 'xmr_locked', 'redeem_adaptor', 'abort']);
const ABORT_TYPES = new Set(['abort', 'xmr_error', 'error']);
// The from-ticker IS the Monero network: tXMR = testnet, sXMR = stagenet. The maker serves
// whichever networks it is configured for (supportedNetworks) and rejects the rest.
const TICKER_NET = { tXMR: 'testnet', sXMR: 'stagenet' };
const isXmr = (c) => c === 'tXMR' || c === 'sXMR';
const MAX_BUF = 64; // per-session stray-message buffer cap (M-6)

// A promise-chain mutex so concurrent swaps serialize tx_lock funding (build -> broadcast).
function makeFundLock() {
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

export function createXmrHandler({ x, btc, cfg, log = console, makeChains, sweepAddrFor, supportedNetworks = ['testnet'], sendCoinNetwork, settleCoins = ['tBTC'], sendCoinNetworkFor, rateFor, gate, maxConcurrent, deriveKm, store, recordStat, getFreeLiq, onComplete, onError, sha256, bytesToHex }) {
  // C1: per-swap key material is DETERMINISTIC from the maker seed + sid (via injected
  // deriveKm) rather than fresh-random, so a crash after tx_lock never makes the BTC
  // unrecoverable; the keys are always reconstructable from the seed + the persisted sid.
  const genKm = (sid) => (typeof deriveKm === 'function' ? deriveKm(sid) : as.genKeyMaterial(x));
  // Durable record of in-flight XMR swaps (sid -> {sid, ts, params, phase}). Lets a restart
  // SEE that a swap was mid-flight and recover its key (deterministic from sid). Best-effort.
  const persistRecord = (rec) => { if (!store) return; try { const all = store.load().filter((r) => r.sid !== rec.sid); all.push(rec); store.save(all); } catch (e) { log.warn('xmr persist', e.message); } };
  const forgetRecord = (sid) => { if (!store) return; try { store.save(store.load().filter((r) => r.sid !== sid)); } catch (e) { log.warn('xmr forget', e.message); } };
  // B2: tally each SETTLED XMR swap into cumulative stats EXACTLY once. rec.counted (persisted
  // BEFORE recording) makes resume()/late-redeem retries idempotent; a crash between recording and
  // forgetRecord can't re-count. Best-effort + fully wrapped: a stats error can NEVER disrupt the
  // fund-handling/settle path. Shape for record(): from=send ticker (tXMR/sXMR), to=settle coin
  // (tBTC/tLTC), sendSats=XMR volume in PICO (the UI divides XMR by 1e12), recvSats=settle SATS,
  // updatedAt=unix secs from the record ts. state is 'completed' (maker swept XMR) or 'refunded'.
  const recordTerminal = (rec, state) => {
    if (typeof recordStat !== 'function' || !rec || rec.counted) return;
    rec.counted = true; persistRecord(rec);       // flag first so a throw below can never re-count
    try { recordStat({ state, updatedAt: Math.floor((Number(rec.ts) || Date.now()) / 1000), from: rec.from, to: rec.settle || 'tBTC', sendSats: rec.xmrPico, recvSats: rec.lockSats }); }
    catch (e) { try { log.warn(`xmr stat ${String(rec.sid).slice(0, 8)}`, e && e.message); } catch { /* best-effort */ } }
  };
  const xc = cfg.xmr || {};
  const RATE = xc.rate_tbtc_per_xmr ?? 0.01;     // nominal tBTC per 1 XMR (default / tBTC rate)
  // Settlement coin = the BTC-family coin the maker locks (tBTC or tLTC). These resolvers default to
  // the single-coin (tBTC) wiring, so a maker configured for tBTC only behaves exactly as before.
  const scnFor = (settle) => (typeof sendCoinNetworkFor === 'function' ? sendCoinNetworkFor(settle) : sendCoinNetwork);
  const rateForCoin = (settle) => (typeof rateFor === 'function' ? rateFor(settle) : RATE);
  // Settle-coin-aware timelocks (L5). config t1_blocks/t2_blocks are tBTC-block-time values; a faster
  // settle chain (tLTC ~2.5min blocks vs tBTC ~10min) needs proportionally MORE blocks for the SAME
  // wall-clock refund window. Floor each settle coin at its per-chain safe default (defaultXmrTimelocks:
  // tBTC 72, tLTC 288 ~= 12h) so enabling tLTC settlement can't silently inherit the too-short tBTC
  // count. max() still lets an operator widen the window past the floor.
  const blocksFor = (settle) => {
    const d = defaultXmrTimelocks(settle);
    return { t1: Math.max(xc.t1_blocks ?? d.t1, d.t1), t2: Math.max(xc.t2_blocks ?? d.t2, d.t2) };
  };
  const MIN_PICO = BigInt(xc.min_pico ?? 1_000_000_000), MAX_PICO = BigInt(xc.max_pico ?? 50_000_000_000);
  const MAX_CONCURRENT = maxConcurrent ?? xc.max_concurrent ?? 4;
  // A settle lock must survive the adaptor unwind: cancel -> refund/punish each subtracts the fixed
  // 1000-sat adaptor fee (driver FEE), and every output must clear DUST (546, adaptorswap.out). So a
  // lock below 546 + 2*1000 = 2546 sats can be quoted but not refunded/punished. Refuse it up front.
  const MIN_SETTLE_LOCK_SATS = 546 + 2 * 1000;
  // U-5: lock_sats is computed with Number math; refuse a config whose max amount
  // could exceed exact-integer range.
  if (MAX_PICO > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('xmr.max_pico exceeds Number.MAX_SAFE_INTEGER; use a smaller cap');

  const sessions = new Map();   // sid -> { transport, active }
  const committed = new Map();   // sid -> lock_sats reserved against the funding address (in-flight)
  const outpointIndex = new Map(); // "lockTxid:vout" -> live rec, for authenticated taker resume after a relay drop
  const fundLock = makeFundLock();

  const activeCount = () => { let n = 0; for (const s of sessions.values()) if (s.active) n++; return n; };
  const committedSats = () => { let n = 0; for (const v of committed.values()) n += v; return n; };

  function transportFor(sid, send) {
    let s = sessions.get(sid);
    if (s) return s.transport;
    const t = {
      buf: [], w: [],
      send: (m) => send(sid, m),
      recv(type, ms = 3_600_000) {
        const i = this.buf.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const to = setTimeout(() => { const j = this.w.indexOf(w); if (j >= 0) { this.w.splice(j, 1); rej(new Error('recv timeout ' + type)); } }, ms);
          const w = { type, resolve: (m) => { clearTimeout(to); res(m); }, reject: rej };
          this.w.push(w);
        });
      },
      _deliver(m) {
        // L-2: a counterparty abort/error fast-fails the running driver instead of
        // letting it burn the full timeout.
        if (ABORT_TYPES.has(m.type)) { const err = new Error('counterparty ' + m.type + ': ' + (m.reason || '')); while (this.w.length) this.w.shift().reject(err); return; }
        const i = this.w.findIndex((w) => w.type === m.type);
        if (i >= 0) this.w.splice(i, 1)[0].resolve(m);
        else if (this.buf.length < MAX_BUF) this.buf.push(m); // M-6: bounded
      },
    };
    sessions.set(sid, { transport: t, active: false });
    return t;
  }

  /** True if this message belongs to the XMR protocol (so the maker should delegate here). */
  function owns(msg) { return msg && typeof msg.type === 'string' && (msg.type === 'xmr_request_quote' || msg.type === 'xmr_resume' || DRIVER_TYPES.has(msg.type)); }

  // Authenticated, read-only RESUME. A taker whose relay WS dropped during the long redeem wait
  // reconnects with a NEW sid and re-requests the already-released redeem adaptor. Authorized ONLY by a
  // signature from Alice's swap btcKey over (outpoint || requesting-sid); the outpoint is public on-chain,
  // so the signature is the authorizer, and binding it to the requesting sid stops replay into another
  // session. It NEVER starts/aborts/rebinds a swap, allocates no key or liquidity, and only re-sends
  // material the maker already committed and persisted (idempotent). The in-flight bobSwap is untouched;
  // it observes Alice's redeem on-chain, independent of which sid the adaptor arrived on.
  const resumeChallenge = (lockTxid, lockVout, sid) => bytesToHex(sha256(new TextEncoder().encode('testnetswap/xmr-resume/v1|' + lockTxid + '|' + lockVout + '|' + sid)));
  function handleResume(sid, msg, send) {
    const rec = outpointIndex.get(String(msg && msg.lockTxid) + ':' + Number(msg && msg.lockVout));
    if (!rec || !rec.unwind || !rec.unwind.alice || !rec.unwind.alice.btcPub) return; // unknown outpoint -> O(1) silent drop (no sig-verify CPU spent)
    let okSig = false;
    try { okSig = !!x.ecdsa_verify(rec.unwind.alice.btcPub, resumeChallenge(msg.lockTxid, msg.lockVout, sid), msg.sig); } catch {}
    if (!okSig) return; // not genuine Alice -> drop (closes the public-outpoint phase-disclosure oracle). A bad-sig flood does NOT touch the cap below, so it cannot grief Alice's real resume; its cost is one verify, bounded by the relay's per-conn/maxTakers limits.
    const nowMs = Date.now();
    if (rec._lastResume && nowMs - rec._lastResume < 3000) return; // throttle a genuine over-eager poller (Alice polls ~20s, so this never self-limits her)
    rec._lastResume = nowMs;
    if (rec.phase === 'redeem_released' && rec.unwind.redeemAdaptor) send(sid, { type: 'redeem_adaptor', adaptor: rec.unwind.redeemAdaptor });
    else send(sid, { type: 'xmr_resume_wait' }); // still maturing: never releases the adaptor early
  }

  async function onMessage(sid, msg, send) {
    if (msg.type === 'xmr_resume') return handleResume(sid, msg, send); // BEFORE the session guard: arrives on a fresh, sessionless sid
    if (msg.type === 'xmr_request_quote') return startSwap(sid, msg, transportFor(sid, send), send);
    // M-6: only feed driver messages to an EXISTING active session; otherwise drop
    // (don't let an idle peer create sessions / buffer unbounded).
    const s = sessions.get(sid);
    if (!s || !s.active) return;
    s.transport._deliver(msg);
  }

  function quoteFor(sendPico, net, settle) {
    // Validate BEFORE BigInt(): a non-integer / non-numeric send_pico (1.5, "abc", {}, undefined)
    // would throw inside BigInt and, because startSwap calls quoteFor outside a try/catch, skip the
    // caller's xmr_error reply AND sessions.delete(sid) - hanging the taker and leaking the session
    // (there is no reaper for inactive XMR sessions). Return null instead, which the caller already
    // maps to amount_out_of_band + cleanup. Accept only a non-negative integer or an all-digits string.
    let pico;
    if (typeof sendPico === 'number') { if (!Number.isInteger(sendPico) || sendPico < 0) return null; pico = BigInt(sendPico); }
    else if (typeof sendPico === 'string' && /^[0-9]+$/.test(sendPico)) { pico = BigInt(sendPico); }
    else return null;
    if (pico < MIN_PICO || pico > MAX_PICO) return null;
    const rate = rateForCoin(settle);
    if (!(rate > 0)) return null;                 // settlement coin the maker doesn't price
    const lockSats = Math.round((Number(pico) / 1e12) * rate * 1e8);
    if (!Number.isSafeInteger(lockSats) || lockSats <= 0) return null;
    if (lockSats < MIN_SETTLE_LOCK_SATS) return null; // undersized: unwind path would hit dust (mirrors HTLC minHtlc)
    // `network` lets the taker assert both sides encode the SAME Monero net; a
    // mismatch would silently derive a different lock address (lost funds).
    const { t1, t2 } = blocksFor(settle);
    // Additive quote fields so a taker can clamp/validate BEFORE committing (XMR parity with the HTLC
    // quote's min_sats/max_sats): the per-swap pico band, the concurrency cap, and the free settle-coin
    // depth (`free` = sats the maker can pay out on `settle`). Old clients ignore unknown fields.
    const freeLiq = (typeof getFreeLiq === 'function' && getFreeLiq()) || null;
    // Advertise the EFFECTIVE min: config min_pico floored UP to the smallest pico whose settle lock still
    // clears MIN_SETTLE_LOCK_SATS at THIS coin's rate. Otherwise advertised (min_pico) != enforced (the
    // lockSats>=floor gate above), so a taker quoting exactly the advertised min bounces with
    // amount_out_of_band. lockSats = round(pico * rate / 1e4), so pico >= floor*1e4/rate clears the floor.
    const effMinPico = Math.ceil(MIN_SETTLE_LOCK_SATS * 1e4 / rate);
    const advMinPico = Math.max(Number(MIN_PICO), effMinPico);
    return { lock_sats: lockSats, xmr_pico: Number(pico), t1_blocks: t1, t2_blocks: t2, rate, network: net, to: settle,
      min_pico: advMinPico, max_pico: Number(MAX_PICO), max_concurrent: MAX_CONCURRENT,
      free: freeLiq ? (freeLiq[settle] ?? null) : null };
  }

  async function startSwap(sid, req, transport, send) {
    const s = sessions.get(sid);
    if (s.active) { send(sid, { type: 'xmr_error', code: 'swap_in_progress', reason: 'swap already in progress' }); return; }
    if (!(isXmr(req.from) && settleCoins.includes(req.to))) { send(sid, { type: 'xmr_error', code: 'unsupported_pair', reason: `unsupported pair (tXMR/sXMR -> ${settleCoins.join('/')})` }); sessions.delete(sid); return; }
    const net = TICKER_NET[req.from];
    if (!net || !supportedNetworks.includes(net)) { send(sid, { type: 'xmr_error', code: 'unsupported_network', reason: `this maker does not serve ${net || req.from} Monero (serves: ${supportedNetworks.join(', ')})` }); sessions.delete(sid); return; }
    const settle = req.to;                          // tBTC or tLTC: the BTC-family coin the maker locks
    const q = quoteFor(req.send_pico, net, settle);
    if (!q) { send(sid, { type: 'xmr_error', code: 'amount_out_of_band', reason: 'amount out of range' }); sessions.delete(sid); return; }
    // Preview: reply with the quote but DON'T start a swap (so a taker browsing
    // rates doesn't tie up a maker session / on-chain lock).
    if (req.quote_only) { send(sid, { type: 'xmr_quote', ...q }); sessions.delete(sid); return; }

    // ---- admission control (H-1) ----
    if (typeof gate === 'function') { const g = gate(sid); if (g && !g.ok) { send(sid, { type: 'xmr_error', code: 'rate_limited', reason: g.reason || 'rate limited' }); sessions.delete(sid); return; } }
    if (activeCount() >= MAX_CONCURRENT) { send(sid, { type: 'xmr_error', code: 'maker_at_capacity', reason: 'maker at capacity for XMR swaps, try later' }); sessions.delete(sid); return; }

    // Reserve OPTIMISTICALLY before any await so two concurrent starts can't both pass
    // the liquidity gate (TOCTOU): committedSats() then already includes this swap, and a
    // genuine over-commit fails closed (both reject) rather than over-admitting.
    s.active = true;
    committed.set(sid, q.lock_sats);

    const km = genKm(sid);
    const chains = makeChains(net, settle);         // the settle chain becomes chains.btc (driver is generic over it)

    // liquidity check against the dedicated funding address's confirmed balance
    if (typeof chains.btc.freeBalance === 'function') {
      let avail = 0;
      try { avail = await chains.btc.freeBalance(); } catch (e) { committed.delete(sid); send(sid, { type: 'xmr_error', code: 'liquidity_check_failed', reason: 'liquidity check failed' }); sessions.delete(sid); return; }
      if (avail < committedSats()) { committed.delete(sid); send(sid, { type: 'xmr_error', code: 'no_liquidity', reason: 'insufficient maker liquidity' }); sessions.delete(sid); return; }
    }

    send(sid, { type: 'xmr_quote', ...q });

    // Serialize tx_lock funding so concurrent swaps can't double-select a UTXO.
    let releaseFund = null;
    const wrappedChains = {
      ...chains,
      btc: {
        ...chains.btc,
        buildLockFunding: async (a) => { releaseFund = await fundLock.acquire(); try { return await chains.btc.buildLockFunding(a); } catch (e) { if (releaseFund) { releaseFund(); releaseFund = null; } throw e; } },
        broadcast: async (h) => { const r = await chains.btc.broadcast(h); if (releaseFund) { releaseFund(); releaseFund = null; } return r; },
      },
    };

    // Capture the current Monero daemon height so the maker's waitLocked/sweep wallets scan from
    // ~now instead of genesis (a genesis rescan can exceed the sweep poll window and strand XMR).
    // Best-effort: on a read failure fall back to 0 (slow but still correct; Alice's lock is
    // always AFTER this point, so any height <= the lock height scans the lock in).
    let xmrRestoreHeight = 0;
    if (typeof chains.xmr.daemonHeight === 'function') {
      try { xmrRestoreHeight = Math.max(0, Number(await chains.xmr.daemonHeight()) || 0); }
      catch (e) { log.warn(`xmr swap ${sid.slice(0, 8)}: daemon height read failed (${e.message}); wallet will sync from genesis`); }
    }

    const sweepDest = sweepAddrFor(net);
    // Durable record. onUnwindReady/onRedeemReleased attach the MINIMAL material a restart needs to
    // reconstruct + auto-run bobUnwind (crash-resume). Persisted BEFORE running; the key is
    // seed+sid-reconstructable, so even an immediate crash leaves the swap recoverable + visible.
    const rec = { sid, ts: Date.now(), from: req.from, settle, lockSats: q.lock_sats, xmrPico: q.xmr_pico, t1Blocks: q.t1_blocks, t2Blocks: q.t2_blocks, moneroNetwork: net, xmrRestoreHeight, phase: 'running' };
    const params = {
      sendCoinNetwork: scnFor(settle), moneroNetwork: net, t1Blocks: q.t1_blocks, t2Blocks: q.t2_blocks,
      lockAmount: q.lock_sats, xmrAmount: q.xmr_pico, xmrRestoreHeight, xmrSweepDest: sweepDest,
      setupTimeoutMs: 120000, lockTimeoutMs: 3_600_000, redeemTimeoutMs: 3_600_000,
      onUnwindReady: (m) => { rec.unwind = m; rec.phase = 'locked'; outpointIndex.set(String(m.lockTxid) + ':' + Number(m.lockVout), rec); persistRecord(rec); },
      onRedeemReleased: (ra) => { if (rec.unwind) { rec.unwind.redeemAdaptor = ra; rec.phase = 'redeem_released'; persistRecord(rec); } },
    };
    persistRecord(rec);
    log.info(`xmr swap ${sid.slice(0, 8)}: ${q.xmr_pico} pico ${req.from} -> ${q.lock_sats} sats ${settle} (active ${activeCount()}/${MAX_CONCURRENT})`);
    let resolved = false; // true once funds are provably settled (swept / refunded); only then forget the record
    try {
      const r = await driver.bobSwap({ x, btc, transport, chains: wrappedChains, km, params });
      log.info(`xmr swap ${sid.slice(0, 8)}: COMPLETED: swept ${r.sweepTxids.join(',')}`);
      resolved = true;
      recordTerminal(rec, 'completed');           // maker provably paid (XMR swept)
      if (onComplete) onComplete(sid, r);
    } catch (e) {
      log.warn(`xmr swap ${sid.slice(0, 8)}: ${e.message}`);
      if (e.unwind) {
        try {
          const u = await driver.bobUnwind({ x, btc, chains: wrappedChains, km, unwind: e.unwind, xmrRestoreHeight, xmrSweepDest: sweepDest });
          if (u.state === 'completed') { log.info(`xmr swap ${sid.slice(0, 8)}: late-redeem recovered; swept ${u.sweepTxids.join(',')}`); recordTerminal(rec, 'completed'); resolved = true; }
          else if (u.state === 'refunded' && u.confirmed !== false) { log.info(`xmr swap ${sid.slice(0, 8)}: refunded ${u.refundTxid}`); recordTerminal(rec, 'refunded'); resolved = true; }
          else { log.warn(`xmr swap ${sid.slice(0, 8)}: refund broadcast (${u.refundTxid}) not yet confirmed; keeping durable record for resume() to monitor/re-attempt (XMR refund can't RBF)`); rec.refundTxid = u.refundTxid; rec.phase = 'refund_pending'; persistRecord(rec); }
        } catch (e2) {
          // Unwind FAILED: funds may still be locked on-chain. Keep the durable record so the
          // operator/a future resume can retry recovery (deterministic km from the sid).
          log.error(`xmr swap ${sid.slice(0, 8)}: UNWIND FAILED: funds may be locked; record kept for recovery: ${e2.message}`);
        }
      }
      if (onError) onError(sid, e);
    } finally {
      if (releaseFund) { releaseFund(); releaseFund = null; }
      committed.delete(sid);
      sessions.delete(sid);
      if (rec.unwind) outpointIndex.delete(String(rec.unwind.lockTxid) + ':' + Number(rec.unwind.lockVout)); // resume is only for the live wait
      if (resolved) forgetRecord(sid); // only drop the durable record once funds are provably settled
    }
  }

  function onGone(sid) { /* keep an active swap running to honor any in-flight unwind; just drop an idle session */ const s = sessions.get(sid); if (s && !s.active) sessions.delete(sid); }

  /**
   * On startup, AUTOMATICALLY recover any XMR swaps that were in-flight at the last shutdown/crash.
   * For each record with persisted unwind material, reconstruct the full unwind (deterministic from
   * the seed-derived km + the persisted alice bundle / outpoint / cancel-presig / adaptors) and run
   * driver.bobUnwind, which itself re-checks whether Alice already redeemed and, if so, recovers
   * m_a and sweeps the XMR instead of refunding. Best-effort + fail-safe: on any error the record is
   * KEPT (funds are always seed+sid-recoverable) so it can be retried. Runs in the background; it
   * does real chain I/O, so callers should NOT await it during startup. Never rejects.
   */
  async function resume() {
    if (!store) return [];
    let recs = []; try { recs = store.load(); } catch (e) { log.error(`xmr resume: state load failed (${e.message}); manual review needed`); return []; }
    if (!recs.length) return [];
    log.warn(`xmr resume: ${recs.length} in-flight XMR swap(s) found after restart; attempting automatic unwind. sids: ${recs.map((r) => String(r.sid).slice(0, 8)).join(', ')}`);
    // Recover CONCURRENTLY: a single hung recovery (e.g. a redundant sweep that polls a now-empty
    // address for ~100 min) must not head-of-line-block the others; a queued record whose T2 window
    // elapses during the wait could otherwise let a taker punish and cost the maker that swap's BTC.
    await Promise.allSettled(recs.map((rec) => recoverOne(rec)));
    return recs;
  }

  async function recoverOne(rec) {
    const tag = String(rec.sid).slice(0, 8);
    // No unwind material => the crash was BEFORE the lock hit the chain; nothing is on-chain to
    // unwind and the key is seed+sid-derivable, so just drop the stale record.
    if (!rec.unwind) { log.warn(`xmr resume ${tag}: no unwind material (crash before lock): nothing on-chain; dropping stale record`); forgetRecord(rec.sid); return; }
    const net = rec.moneroNetwork;
    try {
      const km = genKm(rec.sid);
      const settle = rec.settle || 'tBTC';          // older records predate the settle field -> tBTC
      const chains = makeChains(net, settle);
      // Self-heal: if the lock output never made it on-chain (tx_lock broadcast failed AFTER we
      // persisted the unwind material), there is nothing to unwind; drop the phantom record instead
      // of re-broadcasting a doomed cancel on every restart. (getOutput throws when the tx is unknown;
      // if it's also not spent, the lock simply never landed.)
      let onChain = true;
      try { await chains.btc.getOutput(rec.unwind.lockTxid, rec.unwind.lockVout); }
      catch { let spent = false; try { spent = (await chains.btc.getSpend(rec.unwind.lockTxid, rec.unwind.lockVout)).spent; } catch {} if (!spent) onChain = false; }
      if (!onChain) { log.warn(`xmr resume ${tag}: lock ${String(rec.unwind.lockTxid).slice(0, 12)} never confirmed on-chain; dropping phantom record`); forgetRecord(rec.sid); return; }
      const unwind = driver.bobReconstructUnwind({ x, btc, km, persisted: rec.unwind, sendCoinNetwork: scnFor(settle), moneroNetwork: net, t1Blocks: rec.t1Blocks, t2Blocks: rec.t2Blocks });
      const u = await driver.bobUnwind({ x, btc, chains, km, unwind, xmrRestoreHeight: rec.xmrRestoreHeight || 0, xmrSweepDest: sweepAddrFor(net) });
      if (u.state === 'completed') { log.info(`xmr resume ${tag}: late-redeem recovered; swept ${u.sweepTxids.join(',')}`); recordTerminal(rec, 'completed'); forgetRecord(rec.sid); }
      else if (u.state === 'refunded' && u.confirmed !== false) { log.info(`xmr resume ${tag}: refunded ${u.refundTxid}`); recordTerminal(rec, 'refunded'); forgetRecord(rec.sid); }
      else { log.warn(`xmr resume ${tag}: refund broadcast (${u.refundTxid}) not yet confirmed; record KEPT for the next resume to monitor (XMR refund can't RBF)`); rec.refundTxid = u.refundTxid; rec.phase = 'refund_pending'; persistRecord(rec); }
    } catch (e) {
      log.error(`xmr resume ${tag}: automatic unwind FAILED (${e.message}): funds are seed+sid-recoverable; record kept for retry/operator action`);
    }
  }

  // Capabilities for /api/status, so the site can offer exactly the networks this maker serves
  // (tXMR = testnet, sXMR = stagenet) and hide XMR entirely when it is off.
  const caps = () => ({
    enabled: true,
    networks: supportedNetworks.slice(),
    tickers: supportedNetworks.map((n) => (n === 'stagenet' ? 'sXMR' : 'tXMR')),
    settle: settleCoins.slice(),                    // which coins XMR can settle to (tBTC and/or tLTC)
    rates: settleCoins.reduce((o, s) => { const r = rateForCoin(s); if (r > 0) o[s] = r; return o; }, {}),
    // Confirmed free balance (sats) at each SETTLE funding address, injected + polled by main.js so
    // the site can show XMR-settle liquidity. Undefined when the getter isn't wired (tests / tBTC-only).
    free: (typeof getFreeLiq === 'function' ? getFreeLiq() : undefined),
    min_pico: Number(MIN_PICO), max_pico: Number(MAX_PICO), rate_tbtc_per_xmr: RATE,
    active: activeCount(), max_concurrent: MAX_CONCURRENT,
  });
  return { owns, onMessage, onGone, resume, caps, deriveKm: genKm, _stats: () => ({ active: activeCount(), committedSats: committedSats() }) };
}
