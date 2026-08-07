# swap-xmr: security status & before-funds checklist

The Monero into BTC/LTC adaptor swap. This file tracks what is proven versus what an
implementer must still verify before running with real funds (even on testnet).

## Proven

- **Cryptography** (cross-curve DLEQ + ECDSA adaptor): native `cargo test` + WASM; the atomic link (adaptor scalar → reconstructs the Monero spend-key share) holds.
- **BTC adaptor 2-of-2 redeem**: accepted on-chain (testnet4); scalar recovered from the witness.
- **BTC/LTC tx suite** (lock/redeem/cancel/refund/punish): construction verified correct; adaptor placement, BIP68/CSV (nVersion-2), DER (BIP66, low-S), witness orderings. Guarded with range/DER checks and fail-loud recovery.
- **Monero address + combined-key chain**: byte-identical to monero-ts (testnet + stagenet); the combined keys round-trip to the lock address.
- **Orchestration logic** (`adaptorswap.js`): in-process two-party sim of the full happy + refund paths with real crypto/tx, incl. the byte-consistent lock→cancel→refund chain, the adaptor-verify gates, and rejection of a malicious adaptor.

## Must verify before real funds (live / integration)

These need the live driver and/or the real chains and are **not** covered by the offline sim:

1. **CSV enforcement on-chain**: broadcast `tx_cancel` before T1 (assert node rejects, `non-BIP68-final`) and after T1 (assert accept); same for `tx_punish` vs T2. (Construction is correct + nVersion-2 verified; on-chain rejection/acceptance for this exact script is not yet demonstrated; only the redeem is.)
2. **Live Monero JOIN**: take `m_a` recovered from a **real** broadcast `tx_redeem` witness, add `m_b`, feed that exact `combinedSpendPriv` into `monero.restoreAndSweep` against a wallet funded to the lock address. (The two halves are each proven; the end-to-end hand-off needs one live run. `tools/monero-livetest.mjs` proves lock→detect→sweep; wire it to the recovered scalar.)
3. **Timelock race (T1 vs Monero 10-block unlock)**: discrete-event sim advancing both chains' heights with worst-case BTC confirmation latency; assert Bob completes redeem→recover→sweep→maturity before height(lock)+T1. Tune T1/T2 against measured testnet4/Monero-testnet block-time variance, not nominal block times.
4. **Refund fee / RBF / CPFP near T2**: the builders now take a `feeSats` param; the driver must fee-bump `tx_refund` as T2 approaches. Both Alice's `tx_redeem` and Bob's `tx_refund` are currently FIXED-fee (`FEE=1000`) and broadcast once, so a congested/stalled settle chain can leave either unconfirmed past its window (redeem → maker scrapes `m_a` and keeps both legs; refund → Bob punished + XMR stranded). This is the XMR analogue of the HTLC taker's redeem RBF ladder, which is implemented; the XMR driver's is not yet. Note: an RBF that changes the output amount changes the sighash, so the adaptor/ECDSA sigs must be re-made; decide whether to pre-sign fee tiers or re-run the adaptor exchange.
5. **Counterparty abort at every stage**: drop the next message at CREATED / BTC_LOCKED / XMR_LOCKED / CANCELLED; assert the survivor reaches a safe terminal (REFUNDED, or PUNISHED with an explicit "XMR stranded" warning).
6. **Chain reorgs**: gate every irreversible action on a confirmation-depth policy (N_btc, N_xmr); re-derive state from chain reality, never from the in-memory enum (esp. cancel-vs-redeem near T1). The `m_a`-revealing redeem is gated by the `minRevealConf` driver param (defaults to `minConf`); on a low-hashrate settle chain set it DEEPER than lock-acceptance depth (e.g. 3-6) so a shallow reorg cannot evict the lock after `m_a` is public. Fail-safe: a trip aborts to the maker-refund reclaim, never a loss.
7. **Relay layer**: bind every message to a swap-id + step; enforce ordering; make handlers idempotent (dedupe); reject replays/out-of-order. Fuzz duplicate/reorder/drop and assert no double-spend / no premature funding.
8. **Watcher loop**: Bob's redeem-watch with retries + explicit error surfacing (distinguish `recoverScalar` throw = malformed/retry from `null` = wrong inputs); must win the T1 race.

## Standing caveats

- The upstream cross-curve-DLEQ / adaptor crypto (secp256kfun) is **not formally audited**; acceptable on testnet (worthless coins); never imply mainnet-readiness.
- One swap leg is intrinsically liveness-critical (the BTC-provider "Bob"): keep the **always-online maker** in that role; warn any taker forced into it (taker sends BTC/LTC).
- The "XMR stranded forever" outcome (Bob misses the T2 refund window) is intrinsic to the protocol, not a bug; minimize via generous T2 + aggressive refund fee-bumping.
