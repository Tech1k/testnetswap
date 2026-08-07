# TestnetSwap

Non-custodial, cross-chain atomic swaps for testnet coins, right in your browser: Litecoin testnet ↔ Bitcoin testnet4, plus Monero (tXMR/sXMR) into either. You sign both sides in your own browser, so nobody ever holds your coins. Testnet only. Live at [testnetswap.com](https://testnetswap.com).

It's one of a few testnet tools: [CypherFaucet](https://cypherfaucet.com) (faucet), [TestnetPool](https://testnetpool.com) (mining pool), [TestnetWallet](https://testnetwallet.net) (wallet), and [TestnetScan](https://testnetscan.com) (explorer).

It feels like a one-provider instant exchange: pick a pair, see the rate, confirm, and get the other coin from an always-on counterparty. But it isn't custodial. Every swap is a cross-chain atomic swap, so your funds only ever sit in a contract that either completes the swap or refunds you. A vanished or malicious maker can't take your coins.

## Status

Six packages, no build step; the siblings are linked by `file:` dependencies:

| Package | What it is |
|---|---|
| [`swap-core`](swap-core) | The shared HTLC protocol: transaction building, the hashlock/secret logic, network params. No keys, no server, no UI. |
| [`swap-taker`](swap-taker) | The client-side taker engine (browser or CLI): the relay client, a chain adapter, and the HTLC and Monero swap runners. |
| [`swap-relay`](swap-relay) | The message relay and maker directory, a `{sid, msg}` pipe that holds no keys and no coins. |
| [`swap-maker`](swap-maker) | The always-on maker daemon: quotes, liquidity, and the counterparty side of a swap. |
| [`swap-xmr`](swap-xmr) | Native Monero swaps via a cross-curve adaptor construction. Experimental, off by default. |
| [`testnetswap-site`](testnetswap-site) | The static site and its read-only status/discovery API. |

The HTLC stack (`swap-core`, `swap-relay`, `swap-maker`, and the site) is built and runs end to end on testnet, with the HTLC operations proven on-chain on both Bitcoin and Litecoin. Native Monero (`swap-xmr`) is experimental and disabled by default. A taker tab inside [TestnetWallet](https://testnetwallet.net) is live too, a second browser taker built on the same engine. Live end-to-end swaps have completed on the production stack in both directions (an HTLC tLTC↔tBTC swap and a browser XMR→tLTC adaptor swap). The remaining pre-announce gate is the full [DEPLOY.md](DEPLOY.md) §7 checklist, including a deliberate stall then refund.

### Native Monero (experimental, one-way)

Native Monero swaps are one-way: Monero into tBTC or tLTC, never the reverse (that's future work). They use the Gugger cross-curve adaptor-signature construction (the basis of UnstoppableSwap): all script and timelock logic lives on the BTC/LTC side, and a secp256k1↔ed25519 DLEQ plus an ECDSA adaptor signature carry a Monero spend-key share across chains. The cryptography, the Monero key derivation, and the full two-party swap logic are in place and tested offline, and a full browser XMR→tLTC adaptor swap has now completed live on-chain. Monero ships disabled (`xmr.enabled` false). See [`swap-xmr/README.md`](swap-xmr/README.md), the [Monero adaptor-swap design](swap-xmr/DESIGN.md), and the before-funds checklist in [`swap-xmr/SECURITY.md`](swap-xmr/SECURITY.md).

## How a swap works

```
Setup  ->  You lock  ->  They lock  ->  You claim   (then they claim, atomically)
```

1. Your wallet generates a secret `S`, hash `H = SHA256(S)`; the wallet and maker agree the rate and two timelocks over the relay.
2. You lock your coin in an HTLC on the send chain (deadline `T1`, longer).
3. The maker verifies it on-chain and locks the other coin in a matching HTLC (deadline `T2`, shorter).
4. You claim the maker's coin by revealing `S`. The maker reads `S` from your spend and claims yours. Done.

The load-bearing safety rule, enforced in code: the initiator (you) always gets the **longer** refund window (`T1 > T2`). See [`swap-core`](swap-core) for the contract and [testnetswap-site/how-it-works](testnetswap-site/how-it-works.html) for the walkthrough.

## Architecture

```
 testnetswap.com (static site + /api proxy)   <- read-only, no keys
        |  "swap now" deep-link
        v
 WALLET (taker) <--WSS--> RELAY <--WSS--> MAKER DAEMON (you)
   keys, signing          (no keys)        keys, pools, accounting
        |                                       |
        v                                       v
  public explorers                       your own electrs / Esplora HTTP (primary) + public (fallback)
        +--------- tBTC + tLTC chains ----------+
                          ^
                          | liquidity top-up
                    CypherFaucet
```

**One implementation of the crypto, two consumers.** `swap-core` is the only place the HTLC/tx/secret logic lives; the taker engine and the maker daemon both import it. The site discovers and teaches, and its swap page is the shipping non-custodial in-browser taker: it generates and holds the ephemeral per-swap keys and runs the swap against the always-on maker daemon (the counterparty). A taker tab inside the wallet is a second taker built on the same engine.

## Quick start (local)

```sh
# 1. library tests
cd swap-core && node --test

# 2. relay
cd ../swap-relay && npm ci && cp config.example.json config.json   # set relayId; allowlist your maker-id
node src/main.js -c config.json

# 3. maker (new shell)
cd ../swap-maker && npm ci && cp config.example.json config.json
node src/main.js seed                       # -> put in config.json or MAKER_SEED env
node src/main.js maker-id                    # -> your ed25519 network identity; add to the relay allowlist
node src/main.js fund                        # claim faucet coins to the pool addresses
MAKER_SEED=<hex> node src/main.js -c config.json

# 4. prove a swap (new shell)
node tools/cli-taker.js --relay ws://127.0.0.1:8910/ --from tLTC --to tBTC --amount 0.01 --min-conf 0

# 5. site (new shell)
cd ../testnetswap-site && node tools/serve.js   # http://127.0.0.1:8080, proxies /api -> maker
```

Production deployment (systemd, your own electrs / Esplora HTTP endpoint, reverse proxy, monitoring, onion mirror): see **[DEPLOY.md](DEPLOY.md)**.

## The network (multi-maker, be your own maker)

TestnetSwap is a protocol you can run yourself, not just a hosted service. The relay keeps a registry
of makers, each with an unforgeable ed25519 identity (`maker_id` is a pubkey derived from the maker's
seed). Anyone can run a maker, register, and be discovered on the
[`/network`](testnetswap-site/network.html) dashboard, and takers route swaps to any maker through the
same UI (`?maker=<id>`). Safety is unchanged: every swap is non-custodial and verified on-chain by the
taker's own browser, so a hostile or impersonated maker can only grief (force a refund), never steal.
Registration is permissioned by default (fail-closed), and an operator opts into open registration.
For the protocol, threat model, and a "be your own maker" quickstart, see [NETWORK.md](NETWORK.md).

## Principles

- **Non-custodial.** The service never holds user funds. Atomic HTLC only.
- **Client-side taker.** Keys never leave the browser; no daemon required of the user.
- **Multi-maker network.** The operator runs a default always-on, faucet-funded maker; anyone can run one (permissioned by default). Each maker has an unforgeable ed25519 identity and takers route to any of them.
- **Script logic on the secp256k1 side.** tLTC ↔ tBTC HTLCs, and Monero swaps via the adaptor construction that keeps every script and timelock on the BTC/LTC chain; see the design notes.
- **Honest labeling.** Non-custodial, atomic, testnet only, permissioned makers, the pairs we actually offer. Never "trustless multi-coin exchange."
- **Value-as-plumbing.** Fixed nominal rate. This is infrastructure over the faucets, not a market.

## License

[AGPL-3.0-or-later](LICENSE). TestnetSwap runs as a hosted network service, so the AGPL §13 network-use clause applies. Vendored third-party code under each `vendor/` keeps its own license (`@scure`, `@noble`: MIT).

© 2026 [Tech1k](https://tech1k.com).
