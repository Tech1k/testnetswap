# swap-maker

The always-on, faucet-funded **maker daemon** for [TestnetSwap](https://testnetswap.com): the counterparty to every swap. It imports [`swap-core`](../swap-core) for all the HTLC/tx/secret crypto (one implementation, two consumers; the other is the wallet taker), connects to the [`swap-relay`](../swap-relay), quotes against free liquidity, and drives both sides of a swap to completion or refund.

This is the only swap component that holds keys and coins, but it swaps **atomically**, so it can't take a taker's funds, and a taker can't take its pool: it only locks its liquidity after verifying the taker's funded contract on-chain, and only its own timelock can refund it.

## What it does

- **HD wallet** (`wallet.js`): derives the tBTC + tLTC pool keys/addresses from one seed.
- **Chain client** (`chain.js`): Esplora-style HTTP reads (UTXOs, tx, height, broadcast) with an ordered list of endpoints per coin (your own electrs / Esplora HTTP endpoint first, public explorers as fallback). This is the Esplora REST API (Blockstream/mempool electrs), NOT the Electrum protocol (ElectrumX/Fulcrum).
- **Pools + reservation accounting** (`pools.js`): tracks `total / committed / free` per coin. Quotes are always against **free** (= total − in-flight), so a pending swap never over-commits.
- **Limits** (`limits.js`): per-coin min/max send, `max_concurrent_committed`, `max_concurrent_per_peer`, and a per-peer rate limit. This is the real control surface (not price).
- **Rates** (`rates.js`): a fixed nominal rate (no price discovery; testnet coins are worthless; this is plumbing).
- **Orchestration** (`maker.js`): the relay client + swap state machine: quote → accept (reserve) → verify the taker's lock on-chain → lock its own → watch for the taker's redeem → extract the secret → claim the taker's contract. Auto-refunds its own side if a swap stalls past the timelock.
- **Status API** (`status.js`): read-only `GET /api/status`, `/api/pairs`, `/api/quote` (the site/wallet discovery surface).
- **Persistence** (`store.js`): swap records survive restarts, so in-flight swaps resume and refunds aren't forgotten.

## Run

```sh
npm ci
node src/main.js seed                   # generate the HD seed (back it up)
export MAKER_SEED=<hex>                  # every command below reads this (or put it in config.json "seed")
node src/main.js maker-id               # your network identity; allow-list this on the relay
cp config.example.json config.json      # edit apis / rate / limits / timelocks / relay_url
node src/main.js fund                    # claim faucet coins to the pool addresses
node src/main.js -c config.json          # run the daemon
```

Every command except `seed` needs the seed, so set `MAKER_SEED` (or `config.json` `"seed"`) **before**
`fund`/`maker-id`/`addresses`; otherwise they exit with `invalid maker seed`.

### CLI subcommands

| Command | Purpose |
|---|---|
| `seed` | print a fresh 64-hex seed |
| `maker-id` | print this maker's `maker_id` (ed25519 pubkey derived from the seed, your network identity) |
| `addresses` | print the tBTC / tLTC pool addresses (fund these) |
| `balances` | live confirmed/unconfirmed balance per pool |
| `fund [tBTC\|tLTC]` | claim one CypherFaucet payout to the pool address(es) |
| `swaps` | list persisted swaps and their state |
| `run` (default) | run the daemon |

### Join a network (be your own maker)

The maker registers with the relay using an **ed25519 identity** derived from its seed; no shared
token needed. To join a TestnetSwap network (someone else's or your own):

1. `node src/main.js maker-id` → your `maker_id`.
2. Point `relay_url` in `config.json` at the network's relay (e.g. `wss://relay.testnetswap.com/`).
3. Send your `maker_id` to the relay operator to be allow-listed (or connect directly if the relay
   runs `openRegistration: true`).
4. `MAKER_SEED=<hex> node src/main.js -c config.json`: the daemon signs the relay's challenge,
   registers, and announces its liquidity. You then appear on the network dashboard and takers can
   route swaps to `?maker=<your-id>`.

`RELAY_MAKER_TOKEN` is **optional** now: it only matters if you run the relay yourself and gate your
own `defaultMaker` id with `makerToken`. See [`../NETWORK.md`](../NETWORK.md) for the full protocol.

### Prove a swap (CLI taker)

`tools/cli-taker.js` is a headless taker for testing the whole path without the wallet; it claims from the faucet, runs the full protocol over the relay, and completes a real on-chain swap in either direction:

```sh
node tools/cli-taker.js --relay ws://127.0.0.1:8910/ --from tLTC --to tBTC --amount 0.01 --min-conf 0
node tools/cli-taker.js --relay ws://127.0.0.1:8910/ --from tBTC --to tLTC --amount 0.00004 --min-conf 0
```

## Config

See `config.example.json`. Keep secrets out of it; pass `MAKER_SEED` and `RELAY_MAKER_TOKEN` by env. Key fields: `apis` (ordered endpoints per coin), `rate`, `limits`, `min_confirmations`, `fee_rate`, `t1_hours`/`t2_hours`, `status_host`/`status_port`, `state_dir`, `faucet_url`/`faucet_slugs`.

### Native XMR maker (optional, experimental; off by default)

An `xmr` block in `config.json` lets this maker **also** offer native Monero adaptor swaps: `tXMR`/`sXMR` (Monero testnet/stagenet) settling **into** a BTC-family **settle coin**. It's opt-in and stays disabled unless `xmr.enabled: true`; it logs an EXPERIMENTAL warning on startup.

- **Settle coins.** `tBTC` is always available (needs the tBTC pool + `rate_tbtc_per_xmr`). `tLTC` is added when you *also* run a tLTC pool (`apis.tLTC`) **and** set `xmr.rate_tltc_per_xmr`; the adaptor swap is chain-agnostic over the secp256k1 side, so LTC settles identically. A settle coin with no rate simply isn't offered.
- **Funding addresses.** Each settle coin locks from a **dedicated** funding address (labels `tBTC:xmr-funding` / `tLTC:xmr-funding`), seed-derived but **separate from the HTLC pool** so the XMR path and HTLC path never draw the same UTXO. The daemon logs these on startup; fund them out of band, like the pools.
- **Config block.** `xmr.enabled`, `xmr.i_understand_experimental` (silences the startup warning), `xmr.network`/`xmr.node`/`xmr.sweep_address` (or the multi-network `xmr.networks: { testnet: {…}, stagenet: {…} }` form), `xmr.rate_tbtc_per_xmr`/`xmr.rate_tltc_per_xmr`, `xmr.min_pico`/`xmr.max_pico`, `xmr.t1_blocks`/`xmr.t2_blocks`, `xmr.max_concurrent`.
- **Experimental.** In-flight swaps are seed+sid-recoverable and **auto-resume (best-effort)** on restart; CPFP fee-bumping is not yet implemented. Leave `xmr.enabled: false` for the initial public launch and enable only after a supervised live run. See [`../DEPLOY.md`](../DEPLOY.md) and [`../swap-xmr/README.md`](../swap-xmr/README.md).

## Notes

- **Confirmed vs mempool:** `balances`/status count **confirmed** UTXOs (you shouldn't quote against unconfirmed pool funds); reservation accounting covers in-flight swaps separately, so freed/spent amounts may lag a completed swap until its txs confirm.
- Treat this daemon's uptime as the service's uptime; monitor it (see [../DEPLOY.md](../DEPLOY.md)).

## License

AGPL-3.0-or-later. © 2026 Tech1k.
