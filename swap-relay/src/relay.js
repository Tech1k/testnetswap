// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-relay: a dumb WSS message pipe for the TestnetSwap NETWORK (see ../../NETWORK.md).
 * It holds NO funds and NO keys and never inspects swap semantics. It routes {sid,msg} between
 * taker sessions and the MAKER each taker chose, keeps a roster of registered makers, and serves
 * it at GET /roster for discovery.
 *
 * Maker identity: maker_id = hex(ed25519 pubkey). On connect the relay issues a per-socket
 * challenge; the maker signs "testnetswap-relay-maker|v1|<relayId>|<nonce>|<expiry>" and the relay
 * verifies with node:crypto (no swap-core dep). The signed string is relay-bound + time-bound
 * (defeats cross-relay replay). Registration is PERMISSIONED by default (openRegistration:false →
 * only allowedMakers); the operator opts into open registration. TLS is provided by the reverse
 * proxy (the relay listens plaintext on loopback); a public deployment MUST be behind WSS.
 *
 * Transport:
 *   maker → relay : ?role=maker ; then {type:'maker_register',maker_id,sig,info} ;
 *                   then {type:'maker_announce',info} heartbeats ; then {sid,msg} routing.
 *   taker → relay : ?role=taker&maker=<id> ; raw swap-core msgs → routed to that maker only.
 *   GET /roster   : the maker directory (validated self-reported info + relay-observed uptime).
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual, createPublicKey, verify as edVerify } from 'node:crypto';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8910,
  relayId: 'relay.testnetswap.com', // bound into the maker challenge (prevents cross-relay replay)
  makerToken: '',              // OPTIONAL now: an extra gate for the operator's defaultMaker id
  openRegistration: false,     // SECURE DEFAULT: permissioned (only allowedMakers). Opt into open.
  allowedMakers: [],           // maker_ids permitted when not open
  defaultMaker: '',            // operator maker_id, where a taker with no ?maker is routed (legacy)
  vouched: {},                 // operator TRUST hints: { "<maker_id>": "<label>" }. Config-only; a maker can NEVER self-claim this.
  allowedOrigins: [],          // if NON-EMPTY, only WS handshakes whose Origin is in this list are accepted (defends against drive-by cross-origin abuse from any page in a victim's browser). Empty = accept any Origin (needed for BYO-wallet / native clients that send no Origin). Set to your site origin(s).
  maxPayloadBytes: 256 * 1024,   // 256 KiB. The XMR adaptor-swap 'bundle' message carries a cross-curve DLEQ proof (~114 KB); a 64 KiB cap makes the ws server 1009-close the connection the instant a bundle is sent, so every XMR swap dies with 'recv timeout bundle'. HTLC messages are tiny.
  maxBufferedBytes: 8 * 1024 * 1024,
  maxTakers: 500,
  maxMakers: 64,               // concurrent registered makers (protected by maxPerIp)
  maxPendingMakers: 64,        // challenged-but-unregistered sockets
  maxPerIp: 8,                 // concurrent connections per IP (takers AND makers)
  maxPendingMakersPerIp: 2,    // per-IP sub-cap on UNAUTH pending-maker slots (keeps a few IPs from monopolizing the global maxPendingMakers pool)
  msgsPerMinPerConn: 120,      // per-taker flood guard
  makerMsgsPerMin: 600,        // per-maker flood guard (higher: makers announce + route more than takers)
  registerTimeoutMs: 10000,    // a challenged maker must register within this or be closed
  makerStaleMs: 90000,         // prune makers with no announce within this
  heartbeatMs: 30000,
  rosterCacheMs: 3000,         // GET /roster response is cached this long
  rosterRatePerMin: 60,        // per-IP GET /roster rate limit
  maxNameLen: 40,
  trustProxyHops: 0,
};

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/; // ed25519 signature = 64 bytes
const SPKI = Buffer.from('302a300506032b6570032100', 'hex'); // ed25519 SPKI prefix + 32-byte pubkey
const pubFromRaw = (hex) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
const newSid = () => randomBytes(9).toString('hex');
const newNonce = () => randomBytes(32).toString('hex');
const TICKERS_FROM = new Set(['tBTC', 'tLTC', 'tXMR', 'sXMR']);
const TICKERS_TO = new Set(['tBTC', 'tLTC']);
const ROUTE_DROP_LIMIT = 20; // consecutive taker->maker drops (maker buffer saturated) before the offending taker is closed
const RATE_LIMIT_CLOSE = 60;  // consecutive over-limit taker frames (sustained flood) before the socket is closed, not just error-replied

function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function clientIp(req, hops) {
  const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!hops || hops < 1) return direct;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!xff.length) return direct;
  const idx = xff.length - hops;
  return idx >= 0 ? (xff[idx] || direct) : direct;
}

function makerTokenFrom(req, u) {
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return u.searchParams.get('token') || '';
}

// Verify a maker's challenge signature. The signed string is relay-bound + time-bound.
function verifyMakerSig({ makerId, sig, relayId, nonce, expiry }) {
  if (!HEX64.test(makerId || '') || typeof sig !== 'string' || !HEX128.test(sig)) return false;
  if (!Number.isInteger(expiry) || expiry * 1000 < Date.now()) return false;
  const msg = Buffer.from('testnetswap-relay-maker|v1|' + relayId + '|' + nonce + '|' + expiry);
  try { return edVerify(null, msg, pubFromRaw(makerId), Buffer.from(sig, 'hex')); } catch { return false; }
}

// STRICT validation of self-reported maker info before storing/serving. Roster strings are
// rendered into the key-holding origin, so this + textContent-only rendering + the CSP are the
// XSS defense. Everything unrecognized/oversized is dropped, never stored.
const MAXNUM = 1e15;  // magnitude cap: a maker can't advertise absurd (but finite) values into the roster display
const MAXPICO = 1e21; // ~1e9 XMR in pico, a generous cap on advertised XMR bounds
function sanitizeInfo(info, maxNameLen) {
  if (!info || typeof info !== 'object') return {};
  const out = {};
  if (typeof info.name === 'string') { const n = info.name.slice(0, maxNameLen); if (/^[\w .\-]*$/.test(n)) out.name = n; }
  if (typeof info.version === 'string') { const v = info.version.slice(0, 24).replace(/[^\w.\-]/g, ''); if (v) out.version = v; }
  if (Array.isArray(info.pairs)) {
    out.pairs = info.pairs.slice(0, 8).map((p) => {
      if (!p || typeof p !== 'object') return null;
      const num = (x, int) => (int ? (Number.isInteger(x) && x >= 0 && x <= MAXNUM ? x : null) : (typeof x === 'number' && isFinite(x) && x > 0 && x <= MAXNUM ? x : null));
      const from = TICKERS_FROM.has(p.from) ? p.from : null;
      const to = TICKERS_TO.has(p.to) ? p.to : null;
      if (!from || !to) return null;
      return { from, to, rate: num(p.rate), min_sats: num(p.min_sats, 1), max_sats: num(p.max_sats, 1), liquidity_free_sats: num(p.liquidity_free_sats, 1), liquidity_unit: TICKERS_TO.has(p.liquidity_unit) ? p.liquidity_unit : null };
    }).filter(Boolean);
  }
  if (info.xmr && typeof info.xmr === 'object') {
    const x = info.xmr; const o = { enabled: !!x.enabled };
    if (Array.isArray(x.networks)) o.networks = x.networks.filter((n) => n === 'testnet' || n === 'stagenet').slice(0, 4);
    if (Array.isArray(x.tickers)) o.tickers = x.tickers.filter((t) => t === 'tXMR' || t === 'sXMR').slice(0, 4);
    if (Array.isArray(x.settle)) o.settle = x.settle.filter((c) => c === 'tBTC' || c === 'tLTC').slice(0, 4);
    if (x.rates && typeof x.rates === 'object') { const r = {}; for (const c of ['tBTC', 'tLTC']) { const v = x.rates[c]; if (typeof v === 'number' && isFinite(v) && v > 0 && v <= MAXNUM) r[c] = v; } if (Object.keys(r).length) o.rates = r; }
    // XMR-settle free liquidity (confirmed sats per settle coin at the maker's funding address). Sanitized
    // exactly like rates: only tBTC/tLTC keys, positive finite numbers within the MAXNUM magnitude cap.
    if (x.free && typeof x.free === 'object') { const f = {}; for (const c of ['tBTC', 'tLTC']) { const v = x.free[c]; if (typeof v === 'number' && isFinite(v) && v > 0 && v <= MAXNUM) f[c] = v; } if (Object.keys(f).length) o.free = f; }
    if (Number.isInteger(x.min_pico) && x.min_pico >= 0 && x.min_pico <= MAXPICO) o.min_pico = x.min_pico;
    if (Number.isInteger(x.max_pico) && x.max_pico >= 0 && x.max_pico <= MAXPICO) o.max_pico = x.max_pico;
    if (typeof x.rate_tbtc_per_xmr === 'number' && isFinite(x.rate_tbtc_per_xmr) && x.rate_tbtc_per_xmr > 0 && x.rate_tbtc_per_xmr <= MAXNUM) o.rate_tbtc_per_xmr = x.rate_tbtc_per_xmr;
    out.xmr = o;
  }
  if (info.stats && typeof info.stats === 'object') {
    const s = info.stats; const o = {};
    if (Number.isInteger(s.completed) && s.completed >= 0 && s.completed <= MAXNUM) o.completed = s.completed;
    if (Number.isInteger(s.refunded) && s.refunded >= 0 && s.refunded <= MAXNUM) o.refunded = s.refunded;
    if (Number.isInteger(s.failed) && s.failed >= 0 && s.failed <= MAXNUM) o.failed = s.failed;
    if (typeof s.success_rate === 'number' && isFinite(s.success_rate) && s.success_rate >= 0 && s.success_rate <= 1) o.success_rate = s.success_rate;
    out.stats = o;
  }
  return out;
}

export function startRelay(userConfig = {}, { log = console } = {}) {
  const cfg = { ...DEFAULTS, ...userConfig };
  const allow = new Set((cfg.allowedMakers || []).map((m) => String(m).toLowerCase()).filter((m) => HEX64.test(m)));
  const openReg = !!cfg.openRegistration;
  const defaultMaker = (cfg.defaultMaker || '').toLowerCase();
  // Operator-vouched trust labels. Sourced ONLY from config (never from a maker's self-reported info),
  // so a maker cannot forge a "vouched" badge. Keys must be valid maker_ids; labels are length/charset-capped.
  const vouched = new Map();
  for (const [id, raw] of Object.entries(cfg.vouched || {})) {
    const k = String(id).toLowerCase();
    if (!HEX64.test(k)) continue;
    const lbl = (typeof raw === 'string' ? raw : '').slice(0, 24).replace(/[^\w .\-]/g, '').trim() || 'Vouched';
    vouched.set(k, lbl);
  }
  if (!openReg && allow.size === 0 && !defaultMaker) log.warn && log.warn('relay: permissioned mode but no allowedMakers/defaultMaker set; no maker can register');

  const makers = new Map();     // maker_id -> { ws, info, connectedSince, lastSeen }
  const takers = new Map();     // sid -> { ws, makerId }
  const ipConns = new Map();    // ip -> total connection count
  const rosterRate = new Map(); // ip -> { start, count }
  const pendingByIp = new Map(); // ip -> count of UNAUTH pending-maker sockets (per-IP sub-cap of the global pendingCount pool)
  let pendingCount = 0;
  let rosterCache = { at: 0, body: null };

  const makerOnline = (id) => { const m = makers.get(id); return !!(m && m.ws && m.ws.readyState === m.ws.OPEN); };

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) {
      if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > cfg.maxBufferedBytes) { try { ws.close(); } catch {} return; }
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  }
  // Route a taker's frame to a maker WITHOUT ever closing the maker on backpressure. send() sheds a
  // slow CONSUMER by closing it, which is right when the maker is delivering to a slow taker, but
  // WRONG in the taker->maker direction, where taker-controlled data would otherwise let cheap,
  // unauthenticated taker traffic force-disconnect the authenticated maker (the network core) and
  // drop every swap it routes. Here we instead drop the offending taker's message and let the caller
  // penalize the TAKER. Returns true if delivered, false if dropped (maker saturated/closed).
  function routeToMaker(mws, obj) {
    if (!mws || mws.readyState !== mws.OPEN) return false;
    if (typeof mws.bufferedAmount === 'number' && mws.bufferedAmount > cfg.maxBufferedBytes) return false;
    try { mws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }
  function rateOk(ws, cap) {
    const now = Date.now();
    if (now - ws._rateStart > 60000) { ws._rateStart = now; ws._rateCount = 0; }
    // A cap of 0 is falsy and falls back to the default (not a "disable/unlimited" sentinel); pass a large number for effectively-unlimited.
    return ++ws._rateCount <= (cap || cfg.msgsPerMinPerConn);
  }

  function buildRoster() {
    const list = [];
    for (const [id, m] of makers) {
      if (!(m.ws && m.ws.readyState === m.ws.OPEN)) continue;
      list.push({ maker_id: id, info: m.info || {}, connected: true, connected_since: Math.floor(m.connectedSince / 1000), last_seen: Math.floor(m.lastSeen / 1000), default: id === defaultMaker, vouched: vouched.get(id) || null });
    }
    list.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || a.connected_since - b.connected_since);
    return { ok: true, makers: list, default_maker: defaultMaker || null, generated_at: Math.floor(Date.now() / 1000) };
  }

  const httpServer = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'GET') { res.writeHead(405, cors); return res.end('{"ok":false}'); }
    const url = (req.url || '').split('?')[0];
    if (url === '/health') { res.writeHead(200, cors); return res.end(JSON.stringify({ ok: true, makers: makers.size, takers: takers.size })); }
    if (url === '/roster') {
      const ip = clientIp(req, cfg.trustProxyHops); const now = Date.now();
      let rr = rosterRate.get(ip); if (!rr || now - rr.start > 60000) { rr = { start: now, count: 0 }; rosterRate.set(ip, rr); }
      if (++rr.count > cfg.rosterRatePerMin) { res.writeHead(429, cors); return res.end('{"ok":false,"reason":"rate limited"}'); }
      if (!rosterCache.body || now - rosterCache.at > cfg.rosterCacheMs) rosterCache = { at: now, body: JSON.stringify(buildRoster()) };
      res.writeHead(200, { ...cors, 'Cache-Control': 'public, max-age=3' }); return res.end(rosterCache.body);
    }
    res.writeHead(404, cors); res.end('{"ok":false,"reason":"not found"}');
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: cfg.maxPayloadBytes });

  wss.on('connection', (ws, req) => {
    let role = 'taker', token = '', ip = (req.socket && req.socket.remoteAddress) || 'unknown', wantMaker = '';
    try { const u = new URL(req.url, 'ws://x'); role = u.searchParams.get('role') || 'taker'; token = makerTokenFrom(req, u); wantMaker = (u.searchParams.get('maker') || '').toLowerCase(); ip = clientIp(req, cfg.trustProxyHops); } catch {}

    // Origin allowlist (opt-in). WebSocket handshakes are exempt from the same-origin policy, so any
    // page a victim visits can open this relay from the victim's browser/IP; a non-empty allowlist
    // blocks that drive-by cross-origin abuse. Empty list = accept any Origin (BYO-wallet / native).
    // Only a BROWSER sets Origin, and it can't be forged from a page, so enforcing the list ONLY when an
    // Origin is present still blocks every drive-by while letting NON-browser clients through: the maker
    // (a loopback Node ws client with no Origin) and native/BYO wallets. They authenticate separately
    // (maker = ed25519 challenge + allowlist), and a page can't make an Origin-less connection, so this
    // adds no drive-by surface. (Without the `origin &&` guard, a non-empty list silently rejects the
    // maker and no maker can register - the roster stays empty.)
    if (Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.length) {
      const origin = String((req.headers && req.headers.origin) || '');
      if (origin && !cfg.allowedOrigins.includes(origin)) { send(ws, { type: 'error', reason: 'origin not allowed' }); try { ws.close(); } catch {} return; }
    }

    const n = (ipConns.get(ip) || 0) + 1;
    if (n > cfg.maxPerIp) { send(ws, { type: 'error', reason: 'too many connections' }); ws.close(); return; }
    ipConns.set(ip, n);
    const releaseIp = () => { const c = (ipConns.get(ip) || 1) - 1; if (c <= 0) ipConns.delete(ip); else ipConns.set(ip, c); };

    ws._rateStart = Date.now(); ws._rateCount = 0; ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

    if (role === 'maker') return handleMaker(ws, token, releaseIp, ip);
    return handleTaker(ws, wantMaker, releaseIp);
  });

  function handleMaker(ws, token, releaseIp, ip) {
    if (pendingCount >= cfg.maxPendingMakers) { send(ws, { type: 'error', reason: 'relay busy' }); ws.close(); releaseIp(); return; }
    // Per-IP sub-cap on unauthenticated pending-maker slots. maxPendingMakers is a GLOBAL pre-auth pool
    // claimed before signature verification, so without this a few IPs (bounded only by maxPerIp) could
    // hold every pending slot and block real makers from registering. Checked BEFORE any increment so a
    // reject returns before ws.on('close') is registered (no spurious decrement of a live peer's count).
    const ipPend = pendingByIp.get(ip) || 0;
    if (ipPend >= cfg.maxPendingMakersPerIp) { send(ws, { type: 'error', reason: 'relay busy' }); ws.close(); releaseIp(); return; }
    pendingByIp.set(ip, ipPend + 1);
    pendingCount++;
    const releasePending = () => { const c = (pendingByIp.get(ip) || 1) - 1; if (c <= 0) pendingByIp.delete(ip); else pendingByIp.set(ip, c); };
    ws._role = 'maker'; ws._registered = false;
    const nonce = newNonce();
    const expiry = Math.floor(Date.now() / 1000) + Math.ceil(cfg.registerTimeoutMs / 1000) + 5;
    send(ws, { type: '_relay_challenge', relay_id: cfg.relayId, nonce, expiry, v: 1 });
    const regTimer = setTimeout(() => { if (!ws._registered) { send(ws, { type: 'error', reason: 'registration timeout' }); try { ws.close(); } catch {} } }, cfg.registerTimeoutMs);

    ws.on('message', (data) => {
      if (!rateOk(ws, cfg.makerMsgsPerMin)) return; // M3: throttle maker frames (announce/route flood guard) before any parse work
      let env; try { env = JSON.parse(data.toString()); } catch { return; }
      if (!env || typeof env !== 'object') return;
      if (env.type === '_ping') { send(ws, { type: '_pong' }); return; }
      if (!ws._registered) {
        if (env.type !== 'maker_register') return; // drop all pre-registration frames
        const makerId = String(env.maker_id || '').toLowerCase();
        if (!verifyMakerSig({ makerId, sig: env.sig, relayId: cfg.relayId, nonce, expiry })) { send(ws, { type: 'error', reason: 'bad maker signature' }); try { ws.close(); } catch {} return; }
        if (!openReg && !allow.has(makerId)) { send(ws, { type: 'error', reason: 'registration not permitted' }); try { ws.close(); } catch {} return; }
        if (cfg.makerToken && makerId === defaultMaker && !tokenEq(token, cfg.makerToken)) { send(ws, { type: 'error', reason: 'bad maker token' }); try { ws.close(); } catch {} return; }
        const existing = makers.get(makerId);
        if (existing && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) { send(ws, { type: 'error', reason: 'maker already connected' }); try { ws.close(); } catch {} return; }
        if (!existing && makers.size >= cfg.maxMakers) { send(ws, { type: 'error', reason: 'roster full' }); try { ws.close(); } catch {} return; }
        clearTimeout(regTimer); ws._registered = true; ws._makerId = makerId; pendingCount = Math.max(0, pendingCount - 1); releasePending();
        const t = Date.now();
        makers.set(makerId, { ws, info: sanitizeInfo(env.info, cfg.maxNameLen), connectedSince: t, lastSeen: t });
        rosterCache.body = null;
        log.info && log.info('relay: maker registered ' + makerId.slice(0, 12));
        send(ws, { type: '_relay_hello', role: 'maker', maker_id: makerId });
        return;
      }
      // Announce updates advertised info + liveness; it does NOT bust the roster cache (a maker
      // could otherwise flood announces to force a rebuild on every /roster hit). The ≤rosterCacheMs
      // TTL refreshes updated info; register/disconnect/prune invalidate immediately (new/gone maker).
      if (env.type === 'maker_announce') { const m = makers.get(ws._makerId); if (m && m.ws === ws) { m.info = sanitizeInfo(env.info, cfg.maxNameLen); m.lastSeen = Date.now(); } return; }
      if (env.sid != null) {
        const t = takers.get(env.sid);
        if (t && t.makerId === ws._makerId) send(t.ws, env.msg);              // cross-maker injection guard
        else send(ws, { type: '_relay_nosession', sid: env.sid });
      }
    });
    ws.on('close', () => {
      if (ws._registered) { const m = makers.get(ws._makerId); if (m && m.ws === ws) { makers.delete(ws._makerId); rosterCache.body = null; log.info && log.info('relay: maker gone ' + ws._makerId.slice(0, 12)); } }
      else { pendingCount = Math.max(0, pendingCount - 1); releasePending(); clearTimeout(regTimer); }
      releaseIp();
    });
    ws.on('error', () => {});
  }

  function handleTaker(ws, wantMaker, releaseIp) {
    if (takers.size >= cfg.maxTakers) { send(ws, { type: 'error', reason: 'relay full' }); ws.close(); releaseIp(); return; }
    const makerId = (wantMaker && HEX64.test(wantMaker)) ? wantMaker : defaultMaker;
    const sid = newSid();
    ws._role = 'taker'; ws._sid = sid;
    takers.set(sid, { ws, makerId });
    send(ws, { type: '_relay_hello', role: 'taker', sid, maker_id: makerId || null, maker_online: makerOnline(makerId) });
    ws.on('message', (data) => {
      if (!rateOk(ws)) {
        send(ws, { type: 'error', reason: 'rate limited' });
        if ((ws._rlHits = (ws._rlHits || 0) + 1) > RATE_LIMIT_CLOSE) { try { ws.close(); } catch {} } // sustained flood: close, not just error-reply forever
        return;
      }
      ws._rlHits = 0;
      let msg; try { msg = JSON.parse(data.toString()); } catch { send(ws, { type: 'error', reason: 'invalid json' }); return; }
      if (msg && msg.type === '_ping') { send(ws, { type: '_pong' }); return; }
      if (!makerId || !makerOnline(makerId)) { send(ws, { type: 'error', reason: 'maker offline' }); return; }
      if (!routeToMaker(makers.get(makerId).ws, { sid, msg })) {
        // Maker saturated: drop THIS taker's frame (never close the maker) and penalize the taker.
        send(ws, { type: 'error', reason: 'maker busy' });
        if ((ws._routeDrops = (ws._routeDrops || 0) + 1) > ROUTE_DROP_LIMIT) { try { ws.close(); } catch {} }
        return;
      }
      ws._routeDrops = 0;
    });
    ws.on('close', () => { takers.delete(sid); releaseIp(); if (makerId && makerOnline(makerId)) routeToMaker(makers.get(makerId).ws, { sid, msg: { type: '_taker_gone' } }); });
    ws.on('error', () => {});
  }

  const hb = setInterval(() => {
    const now = Date.now();
    wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} });
    for (const [id, m] of makers) { if (now - m.lastSeen > cfg.makerStaleMs) { makers.delete(id); rosterCache.body = null; try { m.ws.close(); } catch {} log.info && log.info('relay: pruned stale maker ' + id.slice(0, 12)); } }
    // Prune expired per-IP roster-rate buckets so the map can't grow unbounded (e.g. IPv6 rotation).
    for (const [ip, rr] of rosterRate) { if (now - rr.start > 60000) rosterRate.delete(ip); }
  }, cfg.heartbeatMs);
  hb.unref && hb.unref();

  httpServer.listen(cfg.port, cfg.host, () => log.info && log.info(`relay: ws+http://${cfg.host}:${cfg.port} (registration: ${openReg ? 'OPEN' : 'permissioned'}; ${allow.size} allowed; default ${defaultMaker.slice(0, 12) || 'none'})`));

  return {
    wss, httpServer,
    stop() { clearInterval(hb); for (const ws of wss.clients) try { ws.close(); } catch {} wss.close(); httpServer.close(); },
    stats() { return { makers: makers.size, takers: takers.size, pending: pendingCount }; },
    roster() { return buildRoster(); },
  };
}
