# TestnetSwap: deployment runbook

How to stand up the whole service. Components, in dependency order: `swap-core` (library, no build) → `swap-relay` (WSS pipe) → `swap-maker` (the daemon) → `testnetswap-site` (static site + status API proxy).

```
 testnetswap.com (static site + /api proxy)   <- read-only, no keys
        |  "swap now" deep-link
        v
 WALLET (taker) <--WSS--> RELAY <--WSS--> MAKER DAEMON (you)
   keys, signing          (no keys)        keys, pools, accounting
        |                                       |
        v                                       v
  public explorers                       your electrs/Esplora (primary) + public (fallback)
        +--------- tBTC + tLTC chains ----------+
                          ^
                          | liquidity top-up
                    CypherFaucet
```

Ports (defaults): relay `8910` (WSS), maker status API `8911` (HTTP, read-only), site `8080` (dev).

## 0. Prerequisites

- **Node.js 20 LTS or newer** (the maker/relay are Node; `swap-core` is vendored, no build). Node 18 reached end-of-life 2025-04-30 and no longer gets security patches; do not run the public-facing relay/maker on it. On Node 18 a `webcrypto-shim` keeps things working, but it's a stopgap, not a supported runtime; on Node 20+ the shim is a no-op. If there's no system Node, a userland install works: download the official static tarball to `~/.local/node` and put `~/.local/node/bin` on `PATH`.
- **Chain access** for tBTC + tLTC. Public Esplora works for low volume (mempool.space/testnet4, litecoinspace.org/testnet); for production point the maker at **your own endpoint first** with the public ones as fallback (the maker's `apis` config takes an ordered list per coin). It must be an **Esplora HTTP API: Blockstream/mempool `electrs`, not raw ElectrumX/Fulcrum** (those are Electrum-protocol, no HTTP). If the maker shares a box with your explorer, point it at **loopback** to skip the public rate limits entirely. This only affects the MAKER's view; the browser taker independently verifies tBTC against mempool.space, which is what keeps swaps non-custodial; don't repoint the taker's tBTC at an operator-run explorer.
- A **CypherFaucet** to fund the maker's pools (the operator already runs one).

## 1. swap-core (no install step)

It's a vendored ESM library; `swap-relay` and `swap-maker` reference it via `file:../swap-core`. Keep the packages as siblings, and note the **maker needs both `swap-core` and `swap-xmr`** next to it: `swap-maker/package.json` has an *unconditional* `file:../swap-xmr` dependency, so `cd swap-maker && npm ci` fails with `ENOENT ../swap-xmr` if it's missing, **even when `xmr.enabled` is false**. Run its tests once to be sure:

```sh
cd swap-core && node --test     # expect all green
```

## 2. swap-relay

```sh
cd swap-relay && npm ci          # installs `ws`
cp config.example.json config.json
# set relayId (your relay's public hostname) + choose a registration policy (see below)
node src/main.js -c config.json  # smoke test -> "relay: listening ws://127.0.0.1:8910"
```

The relay is a dumb pipe: it authenticates makers by an **ed25519 challenge** (each maker's
`maker_id` is the hex of a pubkey derived from its seed), routes line-delimited JSON between taker
sessions and each taker's chosen maker, serves the maker directory at `GET /roster`, enforces
payload/rate/connection caps, and holds nothing. Production: put it behind TLS (WSS); this is **required**,
since the signature authenticates only the handshake, e.g. a reverse proxy terminating TLS to
`127.0.0.1:8910`, so browsers can reach it. Use [`swap-relay/deploy/apache-testnetswap.conf.example`](swap-relay/deploy/apache-testnetswap.conf.example)
as the canonical relay/api proxy config: it also documents that `mod_proxy_wstunnel` holds one worker
per live WebSocket, so the Apache MPM **`MaxRequestWorkers` must exceed `maxTakers`+`maxMakers`** (~564;
the event MPM defaults to 400 and would 503 legit takers before the relay's own caps engage), and the
relay unit's matching `LimitNOFILE`.

**Registration policy** (see [`NETWORK.md`](NETWORK.md)):
- `relayId`: bound into each maker's signed challenge (prevents cross-relay signature replay). Set
  it to the relay's public hostname.
- `openRegistration`: defaults to **false** (permissioned, fail-closed). Only `maker_id`s in
  `allowedMakers` may register. Set `true` to let any valid ed25519 identity join.
- `allowedMakers: [maker_id, ...]`: the permissioned allow-list (get an id via
  `swap-maker: node src/main.js maker-id`).
- `defaultMaker`: the `maker_id` a taker with no `?maker` is routed to (typically the operator's).
- `makerToken`: **optional** extra gate for `defaultMaker` only (via `RELAY_MAKER_TOKEN` env). Not
  needed for the ed25519 handshake; leave empty unless you want to token-gate your own default maker.
- `allowedOrigins`: **optional** browser-Origin allowlist. Empty (default) accepts any Origin; a
  non-empty list rejects handshakes from other origins (blocks drive-by cross-origin abuse). **For
  launch, empty is the safe choice:** WebSocket handshakes match the Origin by exact string, so a
  non-empty list also rejects Cloudflare Pages preview URLs (each a distinct origin) and *every*
  no-Origin native/wallet client. Only set it (e.g. `["https://testnetswap.com","https://testnetswap-dev.pages.dev"]`)
  once you know exactly which browser origins serve the site and that no native client uses this relay;
  never omit the origin the site is actually served from.

systemd: see `swap-relay/deploy/swap-relay.service`.

> **Behind the reverse proxy:** set `trustProxyHops: 1` in the relay config (the example does).
> Apache terminates TLS and proxies to `127.0.0.1:8910`, so without it every client is seen as
> `127.0.0.1` and `maxPerIp` becomes a global cap (the 9th concurrent user is refused). With it,
> the relay reads the real client IP that `mod_proxy` appends to `X-Forwarded-For`. Set it to `0`
> only if the relay is exposed directly with no proxy.

> **Deployment topology: pick one and be consistent.** The shipped `*.service` units assume the
> hardened model: two dedicated unprivileged users (`swap-relay`, `swap-maker`), code in `/opt`,
> secrets in `/etc/.../env` (`chmod 600`), state under `/var/lib` via `StateDirectory`, with
> `ProtectHome=true`. If instead you run everything as `ubuntu` from `/home/ubuntu/testnetswap`
> (simpler), you MUST adapt the units: `ProtectHome=true` hides `/home`, so the service can't read
> its code/config/state and you'll be tempted to strip all the hardening. At minimum: keep the
> relay and maker as **two separate unprivileged users** (a relay-process compromise must not sit
> in the same account as the maker's hot seed + swap state), set `WorkingDirectory`/`ReadWritePaths`
> to the `/home/ubuntu/...` paths, use `ProtectHome=read-only` or `tmpfs`, and `chmod 600` the
> maker's env/seed files so the relay user can't read them.

## 3. swap-maker

```sh
cd swap-maker && npm ci
node src/main.js seed                 # -> 64-hex; this is the maker's HD seed. BACK IT UP.
cp config.example.json config.json    # edit: apis (your own node first), rate, limits, t1/t2, status_port, state_dir
```

Keep secrets **out** of `config.json`, pass them by env (the unit uses an `EnvironmentFile`):

- `MAKER_SEED=<64-hex>`: the pool keys AND the maker's ed25519 network identity both derive from this.
- `RELAY_MAKER_TOKEN=<token>`: **optional**, only needed if this maker is the relay's `defaultMaker`
  and that relay sets `makerToken`. The maker otherwise authenticates by the ed25519 challenge.

Set `relay_url` in `config.json` to the relay you're joining (`wss://…`). To register on a
permissioned relay, give the operator your `maker_id` (`node src/main.js maker-id`) to allow-list.

Useful CLI subcommands (same `src/main.js`):

| Command | What it does |
|---|---|
| `seed` | print a fresh random seed |
| `maker-id` | print this maker's `maker_id` (ed25519 pubkey from the seed, its network identity) |
| `addresses` | print the maker's tBTC / tLTC **pool addresses**, plus the `tBTC:xmr-funding` / `tLTC:xmr-funding` settle addresses when XMR is on (fund these) |
| `balances` | live confirmed/unconfirmed balance at each pool address |
| `fund [tBTC\|tLTC]` | claim one faucet payout to the pool address(es) |
| `swaps` | list persisted swaps and their state |
| `run` (default) | run the daemon |

### Fund the pools

`node src/main.js addresses` prints the pool addresses (and the `tBTC:xmr-funding` / `tLTC:xmr-funding` settle addresses when XMR is on); the daemon also logs them on startup. Fund them from CypherFaucet:

- Quick (dev/smoke-test only): `node src/main.js fund` (one 0.01 claim per coin; the public faucet is rate-limited ~1/hr/address, so this is for testing, not for building real liquidity).
- **Production: fund the pool OUT OF BAND.** The public 0.01/hr claim is for untrusted users, not your own maker; don't let it throttle your liquidity. Since you run CypherFaucet + TestnetPool, send to the pool addresses in bulk from your faucet/mining wallet (testnet coins are free, so size the pools generously, say hundreds of each). Keep `max_per_swap ≪ pool size` so one swap can't drain it and you serve many before a refill.
- **Taker entry path:** the shipped mins are faucet-parity (0.009 of each coin) so a coinless user can hit "Fund from faucet" on the deposit screen (one 0.01 claim) and complete a minimum swap in one step, with a network-fee buffer and staying above dust. Raise the mins if you don't want that entry path.

### Limits (the real control surface, tune in `config.json`)

- `per_coin.{tBTC,tLTC}.{min_send_sats,max_send_sats}`: min is faucet-parity 0.009 (one 0.01 "Fund from faucet → swap" claim, fee-safe, above dust); max well below pool size. Shipped defaults (tLTC 0.009 to 5, tBTC 0.009 to 0.05) keep one swap a small slice so the pool serves many; raise the maxes for a bigger real pool, but keep `max_send ≪ pool`.
- `max_concurrent_committed` (default 20): global cap on in-flight swaps. Peak pool exposure ≈ this × `max_send`, so size the pool above that. Raise it for more simultaneous users (e.g. a classroom); lower it to be conservative.
- `max_concurrent_per_peer` (1): one identity = one swap in flight, the key anti-hog / anti-griefing control (abandoned swaps lock liquidity only until the timelock, then auto-release).
- `rate_limit_per_peer` / `rate_window_ms` (10 / 60s): per-peer request throttle.

### Timelocks & confirmations

`t1_hours`/`t2_hours` (example ships **24/12**, time-based CLTV) and `min_confirmations` (example ships **2**; code fallback 3). These two are coupled: the taker waits `min_confirmations` of the maker's lock before revealing the secret **and refuses to reveal within ~2h of T2** (a safety margin against the redeem not confirming in time). Up to 4 confirmations (2 on the taker deposit + 2 on the maker lock) must land inside `t2_hours` minus that 2h. On an irregular testnet where a confirmation can take an hour or more, a short T2 makes legit swaps **abort safely to refund** (no loss, but a failed-looking swap); hence the wide 24/12 defaults and `t2_fund_margin_secs: 14400`. On a fast/reliable chain you can shrink them, or drop `min_confirmations` to 1 to halve the confirmation budget (trades a little reorg hardening); **`0` is unsafe** (accepts mempool-only funding). Additional tunables: `fee_bump_step`/`max_fee_rate` (escalating-fee RBF retries), `taker_locked_timeout_secs`, `t2_fund_margin_secs` (keep it `> ~2h + 2-conf time`, or the maker funds swaps the taker is already too late to claim), `reap_terminal_secs`.

systemd: see `swap-maker/deploy/swap-maker.service`. **Treat maker uptime as the product's uptime.**

### (Optional, EXPERIMENTAL) native XMR maker: tXMR → tBTC (or tLTC)

Off by default. An `xmr` block in `config.json` lets the maker also offer native Monero adaptor swaps that settle to a BTC-family coin. **It is gated experimental** and logs a warning on startup. In-flight swaps are *seed-recoverable* (per-swap keys are deterministic from the seed + session id, and a durable record is written to `state/xmr-swaps.json`), and **automatic unwind-resume after a crash IS implemented**; on startup the maker loads those durable records and best-effort unwinds/recovers each (it logs the attempt). What is still **not implemented is CPFP fee-bumping of the pre-signed XMR txs**, so don't run it unattended with value you can't manually recover. Keys: `enabled`, `i_understand_experimental` (silences the warning), `network` (testnet/stagenet), `node` (HTTPS+CORS Monero RPC, e.g. `https://xmr-testnet-node.librenode.com`), `sweep_address` (a Monero address you control, received XMR is swept here), `rate_tbtc_per_xmr`, `min_pico`/`max_pico`, `t1_blocks`/`t2_blocks`, `max_concurrent`, optional `funding_key_label`. **Settle coins:** tBTC is always on; XMR can **also settle to tLTC** where the maker offers it; set `rate_tltc_per_xmr` and run a tLTC pool (`apis.tLTC`), and the adaptor swap settles to tLTC identically (all script/timelock logic is on the secp256k1 side, so LTC "just works"; a settle coin with no rate isn't offered). On startup the daemon logs a **dedicated funding address per settle coin** (distinct from the HTLC pool; also printed by `node src/main.js addresses`): always tBTC (`tBTC:xmr-funding`), plus tLTC (`tLTC:xmr-funding`) when tLTC settle is enabled. Fund each separately. The browser taker reaches Monero over the **same nodes**, configured as a comma-separated fallback list via `TESTNETSWAP_XMR_NODES_TESTNET` / `TESTNETSWAP_XMR_NODES_STAGENET` (window global or `<meta>`); **set 2 to 3 HTTPS nodes per network** so one flaky node doesn't take the whole XMR path down, and add **every** node origin to the site's `connect-src`. A single node is a hard SPOF.

## 4. testnetswap-site

Static files. Two dynamic dependencies: the read-only status/discovery API (the **maker's** API reverse-proxied under `/api`), and, new, the **in-browser swap page** (`swap.html` + `assets/swap.js`), which runs the whole tBTC↔tLTC atomic swap client-side and talks to the maker directly over the relay (the site server still holds no keys/coins).

- Host the static files (the suite uses Cloudflare Pages; `_headers` applies automatically). **Attach the public domain:** in the Pages project add `testnetswap.com` (+ `www`) as custom domains and point DNS at Pages; the apex does not serve until you do this. The vendored engine lives in `vendor/swap-core` + `vendor/swap-taker` + `vendor/swap-xmr` (byte-identical to the monorepo packages) and the **Monero engine** (`vendor/monero-engine.bundle.js` + `vendor/monero.worker.js`, rebuilt reproducibly from pinned `monero-ts` via [`tools/monero-bundle`](testnetswap-site/tools/monero-bundle): `npm ci && npm run vendor`). `vendor/VENDOR.lock` is the integrity manifest; after **any** vendored change re-hash it and **run the integrity gate before publishing**: `node testnetswap-site/tools/check-vendor.mjs` (expect "no vendor drift; VENDOR.lock verified"). CI (`.github/workflows/ci.yml`) runs this + all suites on push, but Cloudflare Pages auto-deploy does not, so run it yourself before a manual publish.
- Reverse-proxy `/api/*` → the maker's status port (`8911`). Options: a Pages Function, an `_redirects`/proxy rule, or an `api.testnetswap.com` subdomain pointing at the maker (then set `window.TESTNETSWAP_API` / the `<meta name="testnetswap-api">` and add that origin to `connect-src` in `_headers`).
- **The relay must be publicly reachable over WSS at the address the page expects.** `assets/swap.js` defaults `SWAP_RELAY = wss://relay.testnetswap.com/` (override via `window.TESTNETSWAP_RELAY` or a `<meta name="testnetswap-relay">`). Whatever you use must be in `connect-src` in **both** `index.html` and `_headers` (already includes the relay + `api.testnetswap.com` + `testnetscan.com` (LTC) + `mempool.space` + `cypherfaucet.com`, plus the Monero node origins on the swap page; `style-src 'unsafe-inline'` is required for the swap UI's inline styles). The HTLC swap (tBTC↔tLTC) is pure JS, **but `swap.html` also ships the experimental in-browser Monero taker**, so its `_headers` rule needs `script-src … 'wasm-unsafe-eval' 'unsafe-eval' blob:`, `worker-src 'self' blob:`, and **cross-origin isolation** (`Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin`) for the threaded Monero WASM (SharedArrayBuffer). These are set only on `/swap` (both URL forms) and `/vendor/monero.worker.js`, never on the strict pages. If you serve via Apache instead of Pages, replicate all of this from `swap-relay/deploy/apache-testnetswap.conf.example`; CSP **and** COEP/COOP, or the Monero swap will not load.
- The swap is non-custodial in the browser: it generates an **ephemeral per-swap key** in `localStorage`, shows a deposit address only that browser controls, runs the swap, and persists recovery so a stalled swap is refundable after the timelock. Keep the relay + maker up for the duration of a swap.
- Local dev mirrors the API proxy: `node tools/serve.js` serves the files and proxies `/api` → `127.0.0.1:8911`. (For the swap page locally, point `window.TESTNETSWAP_RELAY` at your dev relay, e.g. `ws://127.0.0.1:8910/`, and serve over `http://localhost` so the module + CSP behave.)
- Add a **Tor onion mirror** to match the suite, and register/lock the domain (it's infrastructure people will depend on).

> Note: `testnetwallet` (the wallet) deploys the same way: a separate static site on its own origin (Cloudflare Pages, `_headers` applied). Its Swap tab is live: the wallet ships the BTC/LTC/XMR wallet plus an in-wallet taker, a second shipping taker alongside testnetswap.com's swap page. Give it its own origin (keys live in its `localStorage`).

## 5. Monitoring (uptime-kuma)

- **Maker health**: HTTP GET `https://api.testnetswap.com/api/status`, keyword `"maker_online":true`. This is the canonical "is the service up" check (the site talks to the `api.` subdomain directly via `<meta name="testnetswap-api">`; `testnetswap.com/api/status` only works if you add a Pages `/api` proxy route).
- **Relay**: TCP/WS check on the relay's public WSS endpoint.
- **Site**: HTTP GET `/` 200.
- Optional: alert when `liquidity.free` for either coin drops below a threshold, so you refill before the pool dries.

## 6. Operational notes & gotchas

- **Confirmed vs mempool balances.** `/api/status` liquidity is computed from **confirmed** UTXOs (the safe default, you can't reliably quote against unconfirmed pool funds). Right after a swap, the freed/spent amounts lag until the swap's txs confirm; in-flight swaps are tracked separately by reservation accounting (`committed`), so quotes never over-commit. Don't be alarmed if `total` doesn't move the instant a swap completes.
- **Reservation accounting.** Quotes are always against **free** = total − committed. A swap reserves on accept and releases on completion/timeout.
- **Refunds.** If a swap stalls, the owner must broadcast the refund after its timelock. The maker does this automatically for its own side (`refund_margin_secs`); the taker (wallet) persists state and prompts the user. The design goal is that a stall costs liveness, not funds.
- **Fees.** Spends floor at the min-relay rate and refuse to create dust; bump `fee_rate` if testnet relay is congested.
- **Secrets.** The maker seed and relay token are the only secrets. Back up the seed; keep both in `chmod 600` env files, never in `config.json` or git.

## 7. Security checklist before going public

- [ ] `makerToken` is long and random; identical in relay + maker; only in env files. (Optional now: the relay authenticates makers by their ed25519 identity; `makerToken` only gates the operator's `defaultMaker`.)
- [ ] Maker seed backed up; env files `chmod 600`, owned by the service user.
- [ ] Relay reachable only over WSS (TLS); status API not exposed except via the read-only `/api` proxy.
- [ ] **`trustProxyHops` matches your ACTUAL proxy chain**: `1` for a single Apache in front, **`2` if Cloudflare (or any CDN) sits in front of Apache**. Too low ⇒ `X-Forwarded-For` is spoofable; too high ⇒ every client reads as the proxy IP and `maxPerIp` becomes a global cap (self-DoS).
- [ ] **Relay `allowedOrigins`**: leave `[]` for launch (accept-any is safe: swaps are non-custodial and `maxPerIp` + per-conn/maker rate limits bound abuse), OR set it to the exact browser origins the site is served from. Never omit the origin actually serving the site, and confirm no no-Origin native/wallet client depends on this relay (a non-empty list rejects them).
- [ ] **Timelocks vs confirmations**: `t2_hours` leaves room for `min_confirmations` on both legs **plus** the taker's ~2h reveal margin, so swaps don't abort to refund on a slow chain (example ships 24/12 + `t2_fund_margin_secs 14400` for `min_confirmations 2`).
- [ ] Limits set so one peer/one swap can't drain a pool; `max_concurrent_per_peer` ≤ 2.
- [ ] Maker pointed at **your own electrs/Esplora (primary)** with public explorers as fallback; public explorers rate-limit the maker's server-side polling under load.
- [ ] **XMR: leave `xmr.enabled:false` for the initial public launch.** It's experimental; auto-resume of an interrupted unwind **is** implemented (best-effort, seed+sid-recoverable) but there's still no CPFP fee-bumping; prefer not to restart the maker mid-swap unattended. Enable it only after a supervised live run.
- [ ] **If XMR is enabled: configure MULTIPLE HTTPS Monero nodes per network**: comma-separated `TESTNETSWAP_XMR_NODES_TESTNET` / `TESTNETSWAP_XMR_NODES_STAGENET` (or the matching `<meta>`) on the site, and per-network `node` on the maker; add every node origin to the site `connect-src`. A single node is a hard SPOF; a flaky one is what broke earlier live runs.
- [ ] uptime-kuma monitors live; alerting on maker offline + low liquidity.
- [ ] Site `_headers` CSP correct for your API origin; onion mirror up; DNS auto-renew + registrar lock.
- [ ] **Vendored-crypto integrity green** before publishing: `node testnetswap-site/tools/check-vendor.mjs` (CI runs it on push; a manual Pages publish does not). The `/swap` page carries `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin` (needed for the Monero engine).
- [ ] **A `LICENSE` file exists at repo root** (AGPL-3.0): the README links to it; the footer Source link (to the repo) satisfies the AGPL network-use offer.
- [ ] **Live dry-run done before announcing**: one real tBTC↔tLTC swap in each direction end-to-end, plus a deliberate stall → refund. Live happy-path swaps have run against the production maker + relay + nodes (an HTLC swap and an XMR→settle adaptor swap); the deliberate stall → refund here is the remaining live check.

## 8. Upgrading a live deployment (rolling out the multi-maker network)

If a single-maker TestnetSwap is already live, this is the delta to roll out: the relay went multi-maker (ed25519 identity + roster), the maker gained an identity + hardening, the site gained the `/network` page, the in-browser deposit/cancel flow, a11y, and a **fund-loss fix in the deposit "Cancel"** you do NOT want to skip. The three components are independent; deploy in this order so the maker can register the moment it comes up.

**0. Pre-flight (once).** `git pull` to current `master`. Nothing here touches the maker seed. Do it during low/no traffic; if any swaps are in flight, let them settle first (the maker persists + resumes, but a clean restart is simpler).

**1. Relay (holds no state, safe to restart any time).**
- Update `/etc/swap-relay/config.json` with the NEW multi-maker keys (the old `makerToken`-only config is obsolete):
  - `relayId`: your relay hostname (e.g. `relay.testnetswap.com`), bound into the maker challenge.
  - `openRegistration: false`, `allowedMakers: ["<your-maker-id>"]`, `defaultMaker: "<your-maker-id>"`; get the id with `MAKER_SEED=<hex> node src/main.js maker-id` on the maker box.
  - `makerMsgsPerMin: 600`; keep `trustProxyHops` matching your proxy chain (1 Apache-only, 2 behind Cloudflare); `makerToken` is now optional (leave empty).
- Redeploy the code (`swap-relay/`) and `sudo systemctl restart swap-relay`. Watch the log for `registration: permissioned; 1 allowed`.

**2. Maker (holds keys + swap state, quiesce first).**
- Update `/etc/swap-maker/config.json`: `min_confirmations: 2` (middle ground between fast (1) and reorg-safe (3); on worthless testnet coins the difference costs nothing), `xmr.enabled` per your risk appetite (off is the conservative v1, see §7), and the faucet-parity `limits` (tLTC `min_send_sats 900000` / `max_send_sats 500000000`, tBTC `min_send_sats 900000` / `max_send_sats 5000000`, `max_concurrent_committed 20`), `apis` with your own node first. `relay_token` is no longer required.
- Redeploy `swap-maker/` **with both `swap-core/` and `swap-xmr/` as siblings** (`swap-xmr` is an unconditional `file:` dep, required to install even with XMR disabled), then **`cd swap-maker && npm ci`**: the workspace deps (`swap-core`, `swap-xmr`) are **copied** into `swap-maker/node_modules`, not symlinked, so a plain `git pull` + restart runs **stale dependency code** (this exact omission crashed the maker on 2026-07-27). Use `npm ci`, not `npm install`: it wipes and reinstalls the copied workspace deps from the committed lockfile, so the refresh is **deterministic** and a redeploy on the seed-holding box never silently pulls a newer in-range transitive dep. Only after the reinstall: `sudo systemctl restart swap-maker`. It derives its ed25519 identity from the seed and registers with the relay; the log shows `registered on relay as <id>`.
- Confirm: `curl -s https://<relay>/roster` lists your `maker_id`.

**3. Site (static: the deposit-Cancel fund-safety fix lives here, ship it).**
- Redeploy `testnetswap-site/` to Cloudflare Pages (the `_headers` CSP already includes the relay https origin + Monero nodes; `sitemap.xml`, per-page OG, and the **re-vendored `esplora.js`** are all in this tree). If you serve via Apache instead, apply the CSP from the commented vhost in `swap-relay/deploy/apache-testnetswap.conf.example`.
- If your hostnames differ from the defaults (`relay.testnetswap.com` / `api.testnetswap.com`), set `window.TESTNETSWAP_RELAY` / the `<meta>` and update `_headers` `connect-src`.

**4. Verify (before announcing).**
- `/network` lists the maker; the swap page shows the maker selector (hidden when only one) and `Testnet only` pill; `Min / Max` reflects `0.009 / 5` tLTC.
- **Do the §7 live dry-run** (a real swap each direction + a stall→refund) on the upgraded stack. This is the gate; the happy path has now run live, but the stall → refund path still needs a live pass.

> Rollback: the relay/site can revert instantly (stateless / static). The maker's on-disk swap state is forward-compatible, but keep the prior `swap-maker/` build around so you can downgrade the daemon without touching `state/` if needed.
