# testnetswap-site

The public storefront and read-only status/discovery API for [TestnetSwap](https://testnetswap.com): non-custodial atomic swaps between **Litecoin testnet (tLTC)** and **Bitcoin testnet4 (tBTC)**.

The site **runs the swap in your browser, non-custodially.** The `swap.html` page is a self-contained client-side taker: it generates a fresh key held only in your browser (localStorage), gives you a deposit address only your browser controls, and drives the atomic swap against the maker over the relay. The site **server** still holds no keys and no coins. Everything here is static HTML/CSS/JS (no build step); the look reuses the shared testnet-suite design system (CypherFaucet / TestnetPool / TestnetWallet).

Trust model: this is the ChangeNow-style *UX* (amount → rate → deposit → receive) but the opposite *trust model*, non-custodial. Your browser is the taker, so (1) you fund a deposit address you control and (2) the tab must stay open to finish the swap (it auto-completes; closing it is safe: reopen to resume or refund after the timelock). Currently the in-browser page swaps **tBTC ↔ tLTC** (HTLC), plus experimental **tXMR/sXMR → tBTC** (adaptor swap) already integrated here behind a maker flag; it uses the lazy-loaded Monero engine and is only offered when a maker advertises it.

## Pages

- `index.html`: storefront with live maker status, a quote calculator (rate / receive / min-max / free liquidity), live stat tiles, the four-step explainer, and the honest-labeling section. "Swap now" → `swap.html`.
- `swap.html` + `assets/swap.js`: the **in-browser, non-custodial swap app**. Quote (over the relay) → ephemeral deposit address (+ optional faucet) → the atomic swap runs client-side via the vendored [`swap-taker`](../swap-taker) engine → you receive the other coin; persisted, recovery-safe (refund your deposit after the timelock if the maker stalls).
- `how-it-works.html`: the full cross-chain HTLC walkthrough, the safety model, and the contract script.
- `api.html`: the status/discovery API reference.

## Vendored engine

`vendor/swap-core/` and `vendor/swap-taker/` are byte-for-byte copies of the monorepo packages (no build step). `swap-taker` is **dependency-injected**, so `assets/swap.js` wires the vendored `swap-core` into it. Re-vendor after changes by copying `swap-core/src` + `swap-core/vendor` and `swap-taker/src/{taker,relay,esplora,buffer-shim}.js`.

## Status / discovery API

The authoritative status/discovery API is served by the **maker daemon** ([swap-maker](../swap-maker)), which is the only component that knows real free liquidity. The site reads it from the same origin under `/api/*`:

- `GET /api/pairs`: pairs, rate, limits, free liquidity
- `GET /api/quote?from=tLTC&to=tBTC&amount=0.5`: a quote against free liquidity
- `GET /api/status`: maker health, liquidity, uptime, version

The client reads from `/api` by default; override with `<meta name="testnetswap-api" content="https://api.testnetswap.com/api">` (the base must end in `/api`: the maker serves `/api/status`, `/api/pairs`, `/api/quote`) or `window.TESTNETSWAP_API`. The wallet deep-link target is configurable with `<meta name="testnetswap-wallet">` / `window.TESTNETSWAP_WALLET` (default `https://testnetwallet.net`).

## Run locally

The dev server serves the static files and proxies `/api/*` to a running maker (no deps, Node stdlib):

```sh
# start the maker first (see ../swap-maker), then:
node tools/serve.js                 # http://127.0.0.1:8080, /api -> 127.0.0.1:8911
PORT=3000 API_TARGET=http://127.0.0.1:8911 node tools/serve.js
```

## Deploy

Host the static files on any static host (the suite uses Cloudflare Pages; `_headers` is applied automatically). Reverse-proxy `/api/*` to the maker's status port, e.g. a Cloudflare Pages Function, an `_redirects`/proxy rule, or an `api.` subdomain pointing at the maker (then set `TESTNETSWAP_API` to it and add that origin to the `connect-src` in `_headers`). Add a Tor onion mirror to match the suite.

`_headers` ships a strict CSP (`default-src 'none'`, **no inline scripts**, `object-src 'none'`), HSTS, `frame-ancestors 'none'`, and a no-referrer policy. `connect-src` is locked to exactly what the in-browser swap needs: `'self'` (status API, plus `https://api.testnetswap.com` when the API is on its own subdomain), the WSS relay (`wss://relay.testnetswap.com`), the two block explorers (mempool.space for tBTC, testnetscan.com for tLTC), and the faucet (cypherfaucet.com); nothing else. If you run a different relay/explorer, update `connect-src` (and the `testnetswap-relay` meta / `window.TESTNETSWAP_RELAY`).

## License

AGPL-3.0-or-later. © 2026 Tech1k.
