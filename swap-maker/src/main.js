// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * swap-maker entry point + admin CLI.
 *   node src/main.js -c config.json [command]
 * commands:
 *   run        (default) start the maker daemon + status API
 *   seed       print a fresh random 32-byte seed (for config.seed)
 *   addresses  print the maker's HTLC pool + XMR settle-funding address per coin
 *   balances   fetch + print pool balances and reservations
 *   fund [coin] claim from CypherFaucet to the pool address(es)
 *   swaps      list persisted swaps
 */
import './webcrypto-shim.js'; // MUST be first: polyfills globalThis.crypto on Node 18 (used by randomSecret)
import { readFileSync } from 'node:fs';
import * as sc from '@testnetswap/swap-core';
import { Chain } from './chain.js';
import { Wallet, randomSeedHex } from './wallet.js';
import { Pools } from './pools.js';
import { Rates } from './rates.js';
import { Limits } from './limits.js';
import { FileStore } from './store.js';
import { Stats } from './stats.js';
import { Maker } from './maker.js';
import { startStatusServer } from './status.js';
import { makerIdentity } from './identity.js';

const VERSION = '0.1.0';
const ts = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(ts(), '[maker]', ...a),
  warn: (...a) => console.warn(ts(), '[maker]', ...a),
  error: (...a) => console.error(ts(), '[maker]', ...a),
};

function parseArgs(argv) {
  const out = { config: 'config.json', cmd: 'run', rest: [] };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-c' || args[i] === '--config') && args[i + 1]) { out.config = args[++i]; continue; }
    if (!out._gotCmd) { out.cmd = args[i]; out._gotCmd = true; } else out.rest.push(args[i]);
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.cmd === 'seed') { console.log(randomSeedHex()); process.exit(0); }

let cfg;
try { cfg = JSON.parse(readFileSync(args.config, 'utf8')); }
catch (e) { log.error(`cannot read config ${args.config}: ${e.message}`); process.exit(1); }
if (process.env.MAKER_SEED) cfg.seed = process.env.MAKER_SEED;
if (process.env.RELAY_MAKER_TOKEN) cfg.relay_token = process.env.RELAY_MAKER_TOKEN;
cfg.version = VERSION; // advertised in the relay roster announce

const coins = Object.keys(cfg.apis || { tBTC: 1, tLTC: 1 });
const chains = {};
for (const c of coins) chains[c] = new Chain(cfg.apis[c]);
let wallet;
try { wallet = new Wallet(cfg.seed); }
catch (e) {
  log.error(`invalid maker seed: ${e.message}`);
  log.error('set a 64-hex seed via config.json "seed" or the MAKER_SEED env var (generate one with: node src/main.js seed)');
  process.exit(1);
}
const pools = new Pools(coins);
const rates = new Rates(cfg.rate);
const limits = new Limits(cfg.limits);
const store = new FileStore(cfg.state_dir || './state');
const stats = new Stats(new FileStore(cfg.state_dir || './state', 'stats.json'));

// The dedicated XMR settle-coin funding addresses live at wallet.key('<coin>:xmr-funding'),
// distinct from the HTLC pool. Derived here exactly as enableXmr's buildSettle does (same helper),
// so the CLI (addresses/balances) and the running daemon always report the same address.
const xmrFundingAddr = (label, network) => sc.btc.p2wpkh(sc.getPublicKey(wallet.key(label)), network).address;
function xmrFundingList() {
  if (!cfg.xmr || !cfg.xmr.enabled) return [];
  const list = [{ coin: 'tBTC', label: cfg.xmr.funding_key_label || 'tBTC:xmr-funding', network: sc.BTC_TESTNET4 }];
  if (chains.tLTC && cfg.apis && cfg.apis.tLTC && cfg.xmr.rate_tltc_per_xmr != null) list.push({ coin: 'tLTC', label: 'tLTC:xmr-funding', network: sc.LTC_TESTNET });
  return list.map((f) => ({ ...f, addr: xmrFundingAddr(f.label, f.network) }));
}

async function cmdAddresses() {
  for (const c of coins) console.log(`${c}: ${wallet.address(c)}`);
  for (const f of xmrFundingList()) console.log(`${f.label}: ${f.addr}`);
}

// Print this maker's relay identity (ed25519 maker_id). Add it to the relay's allowedMakers
// (and defaultMaker, if it's the operator maker) so it can register on the network.
async function cmdMakerId() {
  console.log(makerIdentity(wallet.seed).id);
}

async function cmdBalances() {
  for (const c of coins) {
    try { const u = await chains[c].getUtxos(wallet.address(c)); const conf = u.filter((x) => x.status && x.status.confirmed).reduce((s, x) => s + x.value, 0); const unc = u.reduce((s, x) => s + x.value, 0) - conf; pools.setTotal(c, conf); console.log(`${c}: ${conf} sats confirmed (+${unc} unconfirmed) at ${wallet.address(c)}`); }
    catch (e) { console.log(`${c}: error ${e.message}`); }
  }
  for (const f of xmrFundingList()) {
    try { const u = await chains[f.coin].getUtxos(f.addr); const conf = u.filter((x) => x.status && x.status.confirmed).reduce((s, x) => s + x.value, 0); const unc = u.reduce((s, x) => s + x.value, 0) - conf; console.log(`${f.label}: ${conf} sats confirmed (+${unc} unconfirmed) at ${f.addr}`); }
    catch (e) { console.log(`${f.label}: error ${e.message}`); }
  }
}

async function cmdFund(which) {
  const slugs = cfg.faucet_slugs || { tBTC: 'btc-testnet', tLTC: 'ltc-testnet' };
  const url = (cfg.faucet_url || 'https://cypherfaucet.com') + '/api/v1/claim';
  const targets = which ? [which] : coins;
  for (const c of targets) {
    const addr = wallet.address(c);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network: slugs[c], address: addr }) });
      const t = await r.text();
      console.log(`${c} (${addr}): ${r.status} ${t.slice(0, 240)}`);
    } catch (e) { console.log(`${c}: claim error ${e.message}`); }
  }
}

async function cmdSwaps() {
  const swaps = store.load();
  if (!swaps.length) { console.log('no swaps'); return; }
  for (const s of swaps) console.log(`${s.quoteId.slice(0, 8)}  ${s.state.padEnd(13)}  ${s.sendSats} ${s.from} -> ${s.recvSats} ${s.to}  taker=${s.taker?.fundTxid?.slice(0, 12) || '-'} maker=${s.maker?.fundTxid?.slice(0, 12) || '-'}`);
}

/*
 * Activate native BTC<->XMR swaps (additive; HTLC path untouched). Direction is
 * tXMR->tBTC: the maker is BOB (BTC provider, liveness-critical); it funds tx_lock
 * from a DEDICATED tBTC funding address (separate from the HTLC pool, so the two
 * paths never select the same UTXO) and sweeps received XMR to cfg.xmr.sweep_address.
 * Gated by `cfg.xmr.enabled`; deps (WASM crypto + monero-ts) load lazily here.
 */
async function enableXmr(maker) {
  if (!chains.tBTC) { log.error('xmr swaps need a tBTC pool (apis.tBTC)'); process.exit(1); }
  // The maker can serve one OR both Monero networks (tXMR=testnet, sXMR=stagenet). Config is
  // either the multi form (xmr.networks: { testnet: {node, sweep_address}, stagenet: {...} }) or
  // the single form (xmr.network / xmr.node / xmr.sweep_address), which we normalize to the map.
  let netCfgs;
  if (cfg.xmr.networks && typeof cfg.xmr.networks === 'object' && Object.keys(cfg.xmr.networks).length) {
    netCfgs = cfg.xmr.networks;
  } else {
    if (!cfg.xmr.node) { log.error('xmr.node (or xmr.networks) required when xmr.enabled'); process.exit(1); }
    if (!cfg.xmr.sweep_address) { log.error('xmr.sweep_address (or xmr.networks) required when xmr.enabled'); process.exit(1); }
    netCfgs = { [cfg.xmr.network || 'testnet']: { node: cfg.xmr.node, sweep_address: cfg.xmr.sweep_address } };
  }
  const { loadXmrCrypto, adapters } = await import('@testnetswap/swap-xmr');
  const { createXmrHandler } = await import('./xmr-handler.js');
  const moneroTs = (await import('monero-ts')).default;
  const xc = await loadXmrCrypto();
  // Validate + resolve per-network engine settings (node + MoneroNetworkType + sweep address).
  const NETS = {};
  for (const net of Object.keys(netCfgs)) {
    const nc = netCfgs[net] || {};
    const NT = moneroTs.MoneroNetworkType[String(net).toUpperCase()];
    if (NT === undefined || (net !== 'testnet' && net !== 'stagenet')) { log.error(`xmr network invalid: ${net} (use testnet and/or stagenet)`); process.exit(1); }
    if (!nc.node) { log.error(`xmr network ${net}: node required`); process.exit(1); }
    if (!nc.sweep_address) { log.error(`xmr network ${net}: sweep_address required`); process.exit(1); }
    NETS[net] = { node: nc.node, NT, sweep: nc.sweep_address };
  }
  // Settlement coin = the BTC-family coin the maker LOCKS for an XMR swap. Each gets a DEDICATED,
  // deterministic funding key (distinct from the HTLC pool key) so XMR locks never draw from the same
  // UTXO set as HTLCs. tBTC is always available (required above); tLTC is added when the maker has a
  // tLTC pool AND an XMR->tLTC rate (xmr.rate_tltc_per_xmr); the adaptor swap is chain-agnostic over
  // the secp256k1 side, so LTC "just works" with LTC params.
  const SETTLE = {};
  const buildSettle = (coin, network, apis, rate, label) => {
    const fundKey = wallet.key(label); const fundKeyHex = sc.bytesToHex(fundKey);
    const fundAddr = xmrFundingAddr(label, network);
    if (chains[coin] && fundAddr === wallet.address(coin)) { log.error(`xmr ${coin} funding key '${label}' collides with the ${coin} HTLC pool address; choose a distinct label`); process.exit(1); }
    SETTLE[coin] = { network, api: (Array.isArray(apis) ? apis[0] : apis), fundKeyHex, fundAddr, rate };
  };
  buildSettle('tBTC', sc.BTC_TESTNET4, cfg.apis.tBTC, cfg.xmr.rate_tbtc_per_xmr ?? 0.01, cfg.xmr.funding_key_label || 'tBTC:xmr-funding');
  if (chains.tLTC && cfg.apis.tLTC && cfg.xmr.rate_tltc_per_xmr != null) {
    buildSettle('tLTC', sc.LTC_TESTNET, cfg.apis.tLTC, cfg.xmr.rate_tltc_per_xmr, 'tLTC:xmr-funding');
  }
  // XMR funding free-liquidity poll (additive, NON-INVASIVE; it never touches the HTLC pool or the
  // handler's own reservation/liquidity gate). Each SETTLE coin's dedicated funding address is read for
  // its CONFIRMED free balance (the same esplora sum the handler's chains.btc.freeBalance() uses) so
  // /api/status can advertise XMR-settle depth. Every fetch is guarded: a failure keeps last-known-good
  // and can NEVER crash the maker or block a swap. Exposed to the handler via getFreeLiq().
  const xmrFree = {};   // settle coin -> confirmed free sats at its funding address (last-known-good)
  const freeChains = {};
  for (const [coin, s] of Object.entries(SETTLE)) {
    freeChains[coin] = adapters.esploraBtcChain({ btc: sc.btc, sc, x: xc, api: s.api, network: s.network, fundKeyHex: s.fundKeyHex, feeRate: cfg.xmr.fee_rate || 2 });
  }
  const pollXmrFree = async () => {
    for (const [coin, ch] of Object.entries(freeChains)) {
      try { const bal = await ch.freeBalance(); if (Number.isFinite(bal) && bal >= 0) xmrFree[coin] = bal; }
      catch (e) { log.warn(`xmr free-liq ${coin}`, e && e.message); }   // keep last-known-good
    }
  };
  pollXmrFree().catch(() => {});   // once at start (fire-and-forget; never blocks startup)
  const xmrFreeTimer = setInterval(() => { pollXmrFree().catch(() => {}); }, cfg.balance_interval_ms || 60000);
  xmrFreeTimer.unref && xmrFreeTimer.unref();
  maker.xmrFreeTimer = xmrFreeTimer;   // exposed so the shutdown handler can clearInterval it (unref'd, but tidy)
  // Bob never calls xmr.lock (Alice funds the Monero side), so fundWallet is null. The settle chain
  // becomes chains.btc; the driver is generic over which secp256k1 chain that is.
  const makeChains = (net, settle = 'tBTC') => {
    const S = SETTLE[settle] || SETTLE.tBTC;
    return {
      btc: adapters.esploraBtcChain({ btc: sc.btc, sc, x: xc, api: S.api, network: S.network, fundKeyHex: S.fundKeyHex, feeRate: cfg.xmr.fee_rate || 2 }),
      xmr: adapters.moneroXmrEngine({ moneroTs, node: NETS[net].node, networkType: NETS[net].NT, fundWallet: null }),
    };
  };
  // C1: deterministic per-swap key material from the maker seed + sid, so an in-flight XMR
  // swap's BTC is always reconstructable (never lost to a fresh-random key on crash).
  const txtEnc = new TextEncoder();
  const concatBytes = (...arr) => { let n = 0; for (const a of arr) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; };
  const deriveKm = (sid) => {
    const share = (tag) => { const h = Uint8Array.from(sc.sha256(concatBytes(wallet.seed, txtEnc.encode('xmr-km|' + sid + '|' + tag)))); h[31] &= 0x0f; if (h.every((b) => b === 0)) h[0] = 1; return sc.bytesToHex(h); };
    return { mSpend: share('mSpend'), vView: share('vView'), btcKey: share('btcKey'), btcPunishKey: share('btcPunishKey') };
  };
  const xmrStore = new FileStore(cfg.state_dir || './state', 'xmr-swaps.json');
  maker.xmr = createXmrHandler({
    x: xc, btc: sc.btc, cfg, log, makeChains, deriveKm, store: xmrStore,
    sweepAddrFor: (net) => NETS[net].sweep, supportedNetworks: Object.keys(NETS),
    settleCoins: Object.keys(SETTLE),
    sendCoinNetworkFor: (settle) => (SETTLE[settle] || SETTLE.tBTC).network,
    rateFor: (settle) => (SETTLE[settle] ? SETTLE[settle].rate : 0),
    maxConcurrent: cfg.xmr.max_concurrent ?? 4,
    // B2: tally each settled XMR swap into cumulative stats exactly once (best-effort; the handler
    // gates on a persisted `counted` flag and wraps this so a stats error can never disrupt a swap).
    recordStat: (swap) => { if (maker.stats) maker.stats.record(swap); },
    // H-1: rate-limit swap starts using the shared limiter (per-sid token bucket).
    gate: (sid) => maker.limits.rateOk(sid, Date.now()) ? { ok: true } : { ok: false, reason: 'rate limited' },
    // XMR-settle free liquidity (confirmed sats per settle coin at its funding address), polled above.
    getFreeLiq: () => ({ ...xmrFree }),
    // For the authenticated taker-resume challenge hash (must match the taker's sc.sha256/bytesToHex).
    sha256: sc.sha256, bytesToHex: sc.bytesToHex,
  });
  const froms = Object.keys(NETS).map((n) => (n === 'stagenet' ? 'sXMR' : 'tXMR'));
  log.info(`native XMR swaps ENABLED (${froms.join('/')} -> ${Object.keys(SETTLE).join('/')}; ${Object.entries(SETTLE).map(([c, s]) => c + ' @ ' + s.rate + '/XMR').join(', ')}; ${Object.entries(NETS).map(([n, v]) => n + ' @ ' + v.node).join(', ')})`);
  for (const [c, s] of Object.entries(SETTLE)) log.info(`xmr ${c} funding address (fund separately from the HTLC pool): ${s.fundAddr}`);
  // Auto-recover any swap interrupted by the last crash/restart. Runs in the background (real chain
  // I/O), never rejects; funds are seed+sid-recoverable regardless.
  maker.xmr.resume().catch((e) => log.error('xmr resume', e && e.message));
  if (!cfg.xmr.i_understand_experimental) {
    log.warn('native XMR maker is EXPERIMENTAL: run with monitoring. In-flight swaps auto-resume on restart (best-effort) and are always seed+sid-recoverable; CPFP fee-bumping is not yet implemented. Set xmr.i_understand_experimental:true to silence.');
  }
}

async function cmdRun() {
  // relay_token is OPTIONAL now: maker identity is proven by the ed25519 challenge handshake. A token
  // only matters if this maker is the relay's operator/defaultMaker AND that relay sets makerToken;
  // otherwise the relay ignores it. Don't hard-require it; the relay rejects with a clear reason if needed.
  const maker = new Maker({ cfg, chains, wallet, pools, rates, limits, log, store, stats });
  await maker.init();
  for (const c of coins) log.info(`pool ${c}: ${wallet.address(c)}`);
  if (cfg.xmr && cfg.xmr.enabled) await enableXmr(maker);
  const startedAt = Date.now();
  const statusSrv = startStatusServer({ maker, cfg, version: VERSION, startedAt, log });
  maker.start();
  log.info(`maker v${VERSION} running (rate ${rates.price} tBTC/tLTC, min_conf ${cfg.min_confirmations ?? 3})`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log.info('shutting down'); if (maker.xmrFreeTimer) clearInterval(maker.xmrFreeTimer); maker.stop(); statusSrv.stop(); process.exit(0); });
}

const dispatch = { run: cmdRun, addresses: cmdAddresses, balances: cmdBalances, fund: () => cmdFund(args.rest[0]), swaps: cmdSwaps, 'maker-id': cmdMakerId };
const fn = dispatch[args.cmd];
if (!fn) { log.error(`unknown command: ${args.cmd}`); process.exit(1); }
fn().catch((e) => { log.error(e.stack || e.message); process.exit(1); });
