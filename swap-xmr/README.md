# swap-xmr

Native, non-custodial **Monero → BTC/LTC** atomic swaps for TestnetSwap (the Gugger / xmr-btc-swap adaptor-signature construction): XMR settles **into** tBTC or tLTC. The construction is symmetric, but only this direction is deployed; the reverse (BTC/LTC → XMR) is future work. This is the Monero half of the matrix; the same-curve `tBTC ↔ tLTC` HTLC lives in [`swap-core`](../swap-core).

> **Status:** experimental, disabled by default. The crypto core, the BTC/LTC tx suite, the Monero engine, and the maker orchestration (`swap-maker/src/xmr-handler.js`) are all built and offline-tested, and a full browser XMR→tLTC adaptor swap (including a live on-chain reclaim) has now completed on the production stack. The remaining gate before enabling XMR in production is the before-funds checklist in [SECURITY.md](SECURITY.md). See [the design doc](DESIGN.md) for the rationale.

## Why a different construction

Monero has no script and no timelocks, so the same-curve HTLC can't be used. Instead **all** script/timelock logic lives on the Bitcoin/Litecoin side, and the cross-chain link is made with **ECDSA adaptor signatures** + a **cross-curve secp256k1↔ed25519 DLEQ proof**. One 252-bit scalar `s` is the discrete log of both a secp256k1 point (the adaptor encryption key) and an ed25519 point (a Monero spend-key share); publishing the decrypted adaptor signature on the BTC/LTC chain leaks `s`, reconstructing the Monero key. The crypto is the production secp256kfun crates, never hand-rolled.

## What's built

| Piece | Status |
|---|---|
| Cross-curve DLEQ + adaptor crypto (native + WASM) | `crypto/`: `cargo test` |
| The atomic link (recovered scalar reconstructs the Monero key share) | Proven |
| **2-of-2 lock + adaptor redeem, on-chain** (testnet4): spend accepted, scalar recovered from the witness | `tools/btc-adaptor-livetest.mjs` |
| BTC/LTC tx suite as a library (lock/redeem/cancel/refund/punish) + roles/timelocks/state machine | Offline-tested (`node --test`) |
| Cancel/refund/punish (CSV windows elapse) | Constructed + offline-tested; not yet broadcast live |
| Monero address encoder + combined-key derivation, validated against monero-ts (testnet + stagenet) | `tools/monero-validate.mjs` |
| monero-ts ↔ live remote daemon connectivity | `tools/monero-node-check.mjs` |
| Monero lock → detect → restore-from-combined-keys → sweep, **live on testnet** | `tools/monero-livetest.mjs`: completed end to end |
| **Cross-chain swap logic** (setup/DLEQ verify → redeem & refund secret-flow) | `src/adaptorswap.js` + in-process 2-party sim (happy + refund) |
| **Async role drivers** (`bobSwap`/`aliceSwap`, theft-safe ordering, all gates) | `src/driver.js` + the offline driver suite (`node --test`) |
| **Maker orchestration** (per-session BTC-provider role, admission control, dedicated funding, sweep) | `swap-maker/src/xmr-handler.js` |
| Combined live orchestrated tXMR→tBTC (real esplora + monero-ts adapters) | `tools/xmr-swap-live.mjs`: runnable; a full run is ~1h (Monero unlocks) |
| Wallet XMR swap UI (browser tXMR→tBTC) | Built; runs when the maker enables XMR (experimental) |
| XMR↔XMR routing + reverse direction | Future work |

## Layout

| Path | What |
|---|---|
| `crypto/` | Rust → WASM crypto core (DLEQ + adaptor sigs + key-share math) |
| `src/crypto.js` | loads + wraps the WASM (Node `pkg-node`, browser `pkg-web`) |
| `src/btcswap.js` | the BTC/LTC tx suite + DER codec + witness assembly + scalar recovery |
| `src/swap.js` | roles (Alice=XMR/Bob=BTC, maker takes the liveness-critical Bob role), relative-timelock policy, state machine, `ORCHESTRATION_INVARIANTS` |
| `src/monero.js` | Monero address encoder (base58 + keccak) + combined-key derivation + monero-ts lock/detect/sweep wrappers |
| `src/adaptorswap.js` | cross-chain swap-step builders: key bundles + DLEQ verify, redeem/refund construction, adaptor exchange, scalar recovery → combined Monero key |
| `src/driver.js` | the async role state-machines (`bobSwap`/`aliceSwap`) sequencing the toolkit over injectable transport + chain adapters, enforcing the theft-safe ordering |
| `tools/btc-adaptor-livetest.mjs` | the on-chain BTC-side proof |
| `tools/monero-validate.mjs` | offline check of the address/key chain vs monero-ts |
| `tools/monero-livetest.mjs` | live Monero lock→detect→sweep round-trip |
| `test/` | offline tests (`node --test`) |

## The swap (happy path)

A = XMR provider (receives BTC); B = BTC provider (receives XMR), liveness-critical.

1. **Setup**: both derive key shares; exchange DLEQ proofs + adaptor sigs; pre-sign `tx_cancel`/`tx_refund`.
2. **B locks BTC** into a 2-of-2 P2WSH (`tx_lock`).
3. **A locks XMR** to a standard address whose spend key = `S_a + S_b` (after B's lock confirms).
4. **A redeems BTC** via `tx_redeem` (B's signature is an adaptor under `S_a`); broadcasting **reveals `s_a`**.
5. **B sweeps XMR** with `s_a + s_b` (after Monero's 10-block lock).

Refund path: after `T1` blocks either party broadcasts `tx_cancel`; **B refunds** via `tx_refund` (A's signature is an adaptor under `S_b`, leaking `s_b` so A reclaims the XMR); if B stalls past `T2`, A **punishes** and takes the BTC (XMR then stranded, the one unavoidable failure, hence the maker holds the B role).

## Build & test

```sh
cd crypto && cargo test && wasm-pack build --release --target nodejs --out-dir pkg-node   # crypto core
cd .. && node --test                                                                      # JS tx suite + roles
node tools/btc-adaptor-livetest.mjs                                                        # live BTC-side proof
```

## License

AGPL-3.0-or-later. © 2026 Tech1k.
