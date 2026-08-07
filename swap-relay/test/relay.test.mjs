// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercises the multi-maker relay: ed25519 registration handshake, permissioned/open modes,
// roster + info sanitization (XSS defense), taker->maker routing, and the cross-maker injection
// guard. Uses real ws clients + the real maker identity. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startRelay } from '../src/relay.js';
import { makerIdentity } from '../../swap-maker/src/identity.js';

const NOLOG = { info() {}, warn() {}, error() {} };
const seed = (n) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const idA = makerIdentity(seed(1));
const idB = makerIdentity(seed(2));

// waitFor attaches its listener SYNCHRONOUSLY so a server message sent immediately on connect
// (challenge/hello) is never missed. Callers attach before triggering the response.
function waitFor(ws, pred, ms = 3000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { ws.off('message', h); rej(new Error('timeout')); }, ms);
    const h = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (pred(m)) { clearTimeout(to); ws.off('message', h); res(m); } };
    ws.on('message', h);
  });
}
const onType = (ws, t, ms) => waitFor(ws, (m) => m.type === t, ms);
const onSid = (ws, ms) => waitFor(ws, (m) => m.sid != null && m.msg, ms);
const signReg = (id, ch) => id.sign(`testnetswap-relay-maker|v1|${ch.relay_id}|${ch.nonce}|${ch.expiry}`);

async function startOn(cfg) {
  const relay = startRelay({ port: 0, host: '127.0.0.1', relayId: 'test-relay', ...cfg }, { log: NOLOG });
  await new Promise((r) => relay.httpServer.once('listening', r));
  return { relay, port: relay.httpServer.address().port };
}
// Full maker registration; returns { ws, res } where res is the _relay_hello OR error message.
async function register(port, id, info = {}, sigFor = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?role=maker`);
  const ch = await onType(ws, '_relay_challenge');            // listener attached at creation
  const resP = waitFor(ws, (m) => m.type === '_relay_hello' || m.type === 'error'); // attach BEFORE send
  ws.send(JSON.stringify({ type: 'maker_register', maker_id: id.id, sig: sigFor ? sigFor(id, ch) : signReg(id, ch), info }));
  return { ws, res: await resP };
}
async function connectTaker(port, makerId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?role=taker${makerId ? '&maker=' + makerId : ''}`);
  const hello = await onType(ws, '_relay_hello');            // attached at creation
  return { ws, hello };
}

test('permissioned registration + roster info sanitization (XSS defense)', async () => {
  const { relay, port } = await startOn({ allowedMakers: [idA.id], defaultMaker: idA.id, openRegistration: false });
  try {
    const a = await register(port, idA, { name: '<img src=x onerror=alert(1)>', pairs: [{ from: 'tLTC', to: 'tBTC', rate: 0.01, min_sats: 1, max_sats: 9, liquidity_free_sats: 5, liquidity_unit: 'tBTC' }] });
    assert.equal(a.res.type, '_relay_hello');
    assert.equal(a.res.maker_id, idA.id);

    const roster = await (await fetch(`http://127.0.0.1:${port}/roster`)).json();
    assert.equal(roster.makers.length, 1);
    assert.equal(roster.makers[0].maker_id, idA.id);
    assert.equal(roster.makers[0].info.name, undefined, 'malicious name dropped (charset filter)');
    assert.equal(roster.makers[0].info.pairs[0].from, 'tLTC', 'valid pair kept');
    assert.equal(roster.makers[0].default, true);

    const b = await register(port, idB, {});
    assert.equal(b.res.type, 'error');
    assert.match(b.res.reason, /not permitted/);
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); }
});

test('operator "vouched" badge is config-only, sanitized, and un-self-claimable', async () => {
  // idA is vouched by the operator with a junk label (bad chars must be stripped);
  // idB is NOT vouched but tries to forge the badge through its self-reported info.
  const r1 = await startOn({ openRegistration: true, vouched: { [idA.id]: 'Op<e>rator!!' } });
  try {
    const a = await register(r1.port, idA, { pairs: [] });
    const b = await register(r1.port, idB, { vouched: 'Elite', pairs: [] });
    assert.equal(a.res.type, '_relay_hello');
    assert.equal(b.res.type, '_relay_hello');
    const roster = await (await fetch(`http://127.0.0.1:${r1.port}/roster`)).json();
    const A = roster.makers.find((m) => m.maker_id === idA.id);
    const B = roster.makers.find((m) => m.maker_id === idB.id);
    assert.equal(A.vouched, 'Operator', 'config label kept; junk chars stripped');
    assert.equal(B.vouched, null, 'a maker not in the operator config is never vouched');
    assert.equal(B.info.vouched, undefined, 'self-reported "vouched" is dropped by sanitizeInfo');
    a.ws.close(); b.ws.close();
  } finally { r1.relay.stop(); }

  // A non-string label defaults to "Vouched"; a non-hex key is ignored (no crash).
  const r2 = await startOn({ openRegistration: true, vouched: { [idA.id]: true, 'bad-key': 'X' } });
  try {
    const a = await register(r2.port, idA, { pairs: [] });
    assert.equal(a.res.type, '_relay_hello');
    const A = (await (await fetch(`http://127.0.0.1:${r2.port}/roster`)).json()).makers.find((m) => m.maker_id === idA.id);
    assert.equal(A.vouched, 'Vouched', 'non-string label falls back to the default');
    a.ws.close();
  } finally { r2.relay.stop(); }
});

test('bad signature is rejected', async () => {
  const { relay, port } = await startOn({ openRegistration: true });
  try {
    const r = await register(port, idA, {}, (id, ch) => id.sign(`testnetswap-relay-maker|v1|${ch.relay_id}|deadbeef|${ch.expiry}`));
    assert.equal(r.res.type, 'error');
    assert.match(r.res.reason, /bad maker signature/);
    r.ws.close();
  } finally { relay.stop(); }
});

test('open mode: taker routes to its chosen maker; cross-maker injection blocked', async () => {
  const { relay, port } = await startOn({ openRegistration: true });
  try {
    const a = await register(port, idA, { pairs: [] }); assert.equal(a.res.type, '_relay_hello');
    const b = await register(port, idB, { pairs: [] }); assert.equal(b.res.type, '_relay_hello');

    const t = await connectTaker(port, idA.id);
    assert.equal(t.hello.maker_id, idA.id);
    assert.equal(t.hello.maker_online, true);

    const aRecv = onSid(a.ws);
    t.ws.send(JSON.stringify({ type: 'request_quote', from: 'tLTC', to: 'tBTC' }));
    const env = await aRecv;
    assert.equal(env.msg.type, 'request_quote');
    const sid = env.sid;

    const tRecv = onType(t.ws, 'quote');
    a.ws.send(JSON.stringify({ sid, msg: { type: 'quote', recv_sats: 100 } }));
    assert.equal((await tRecv).recv_sats, 100);

    let evil = false;
    t.ws.on('message', (d) => { try { if (JSON.parse(d).recv_sats === 999) evil = true; } catch {} });
    const bNo = onType(b.ws, '_relay_nosession');
    b.ws.send(JSON.stringify({ sid, msg: { type: 'quote', recv_sats: 999 } }));
    assert.equal((await bNo).sid, sid);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(evil, false, 'maker B could not inject into maker A\'s taker session');

    t.ws.close(); a.ws.close(); b.ws.close();
  } finally { relay.stop(); }
});

test('sanitizeInfo caps absurd magnitudes + rejects out-of-range values', async () => {
  const { relay, port } = await startOn({ openRegistration: true });
  try {
    const a = await register(port, idA, {
      pairs: [{ from: 'tLTC', to: 'tBTC', rate: 1e30, min_sats: 1, max_sats: 1e18, liquidity_free_sats: 5, liquidity_unit: 'tBTC' }],
      xmr: { enabled: true, min_pico: 1e30, max_pico: 5 },
      stats: { completed: 1e30, success_rate: 2 },
    });
    assert.equal(a.res.type, '_relay_hello');
    const info = (await (await fetch(`http://127.0.0.1:${port}/roster`)).json()).makers[0].info;
    assert.equal(info.pairs[0].rate, null, 'absurd rate dropped');
    assert.equal(info.pairs[0].max_sats, null, 'over-cap max_sats dropped');
    assert.equal(info.pairs[0].liquidity_free_sats, 5, 'sane liquidity kept');
    assert.equal(info.xmr.min_pico, undefined, 'over-cap min_pico dropped');
    assert.equal(info.xmr.max_pico, 5, 'sane max_pico kept');
    assert.equal(info.stats.completed, undefined, 'over-cap completed dropped');
    assert.equal(info.stats.success_rate, undefined, 'out-of-range success_rate dropped');
    a.ws.close();
  } finally { relay.stop(); }
});

test('origin allowlist: a disallowed Origin is rejected; an allowed one connects', async () => {
  const { relay, port } = await startOn({ openRegistration: true, allowedOrigins: ['https://good.example'] });
  try {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/?role=taker`, { headers: { origin: 'https://evil.example' } });
    const err = await waitFor(bad, (m) => m.type === 'error');
    assert.match(err.reason, /origin not allowed/);

    const good = new WebSocket(`ws://127.0.0.1:${port}/?role=taker`, { headers: { origin: 'https://good.example' } });
    const hello = await onType(good, '_relay_hello');
    assert.equal(hello.role, 'taker');
    bad.close(); good.close();
  } finally { relay.stop(); }
});

test('taker with no ?maker routes to defaultMaker; offline when it is not connected', async () => {
  const { relay, port } = await startOn({ openRegistration: true, defaultMaker: idA.id });
  try {
    const t1 = await connectTaker(port, null);
    assert.equal(t1.hello.maker_id, idA.id);
    assert.equal(t1.hello.maker_online, false);
    t1.ws.close();

    const a = await register(port, idA, { pairs: [] }); assert.equal(a.res.type, '_relay_hello');
    const t2 = await connectTaker(port, null);
    assert.equal(t2.hello.maker_online, true);
    t2.ws.close(); a.ws.close();
  } finally { relay.stop(); }
});
