# swap-taker

The shared, non-custodial **taker** engine for [TestnetSwap](https://testnetswap.com), the client half of every swap. It runs the taker side of a `tBTC ↔ tLTC` HTLC swap and a `tXMR → tBTC` Monero adaptor swap, holds only ephemeral per-swap keys, and never runs a server. The same files execute under Node and vendor **verbatim** (no build step) into the browser, so there is one taker implementation, not one per surface.

This is the counterpart to [`swap-maker`](../swap-maker): the maker daemon holds pools and keys, the taker holds neither beyond the throwaway keys for the swap in front of it. Both sides drive [`swap-core`](../swap-core) (and, for Monero, [`swap-xmr`](../swap-xmr)): one implementation of the crypto, two consumers.

Part of the testnet tooling family alongside CypherFaucet, TestnetPool, and TestnetWallet.

## Dependency-injected, by design

Every heavy dependency (swap-core, the swap-xmr toolkit, and the chain and relay adapters) is passed **in**, not imported by the engine itself. `taker.js` carries no import paths of its own. That is what lets the exact same file run across surfaces without rewriting: Node tests and the CLI taker, and the testnetswap.com swap page and the TestnetWallet swap tab, a second browser surface. The browser taker injects its own vendored copies of swap-core / swap-xmr; Node calls `loadNodeDeps()` to assemble the same bundle.

The engine holds no long-lived secrets. Each swap generates fresh key material (`genHtlcKeys`) that lives only for that swap; there is no wallet, no daemon, no persisted key. State that must outlive a page reload is the small recovery blob needed to refund or reclaim a stalled swap; that is handed to the host through an awaited hook (`onAfterFund` / `onBeforeLock`) and stored by the host, never by the engine.

## Flows

Two takers, both non-custodial, both fail-closed on a counterparty stall:

- **HTLC taker** (`tBTC ↔ tLTC`): `runHtlcTaker`. The taker funds first (the longer timelock, T1), the maker funds second (T2), and the taker redeems by revealing the secret. It only funds after `checkAcceptAgainstQuote` passes, only redeems after `verifyMakerContract` + `verifyFundedOutput` confirm the maker's real on-chain output, and aborts before locking a coin if the execution-time rate has slipped below the caller's floor. If the maker stalls after the taker has funded, `runHtlcTaker` throws with a `recovery` blob attached; `refundHtlc` re-derives the contract from that blob and reclaims the coins after T1.

- **Monero adaptor taker** (`tXMR → tBTC`): `runXmrTaker`, driving the Alice role of the [swap-xmr](../swap-xmr) adaptor swap. Monero is **one-way**: XMR settles into tBTC, never the reverse (the reverse is future work). The recovery blob is built and persisted through an awaited hook **before** any XMR is locked, so a maker stall can never strand funds; `reclaimXmr` chases the on-chain refund to recover the key and sweep the Monero home, or punishes past T2 to claim the maker's BTC. This module is **experimental** and ships disabled; see [`swap-xmr/SECURITY.md`](../swap-xmr/SECURITY.md) for the before-funds checklist.

Every flow takes an `onStatus(stage, detail)` callback so the host UI can show progress.

## Modules

| File | Responsibility |
|------|----------------|
| `src/taker.js` | the pure, dependency-injected taker engine: HTLC taker + refund, XMR adaptor taker + reclaim, per-swap key generation, funding-address derivation |
| `src/relay.js` | browser WebSocket transport to the message relay, wrapped to the `{ send, recv(type), hello, close }` shape the engine expects |
| `src/esplora.js` | Esplora-style BTC/LTC chain adapter (read, broadcast, confirmation depth, spend-watch) shared by both takers |
| `src/buffer-shim.js` | a minimal `Buffer` global for the browser, matching Node semantics for the toolkit's hex helpers and loud on malformed input |
| `src/index.js` | entry point: re-exports the engine + browser adapters, plus `loadNodeDeps()` to assemble the injected deps under Node |

## Vendoring

The browser sites do not bundle. These files are copied byte-for-byte into `testnetswap-site/vendor/swap-taker` and loaded as plain `.mjs`. A drift guard (`node testnetswap-site/tools/check-vendor.mjs`) fails the build if a vendored copy ever diverges from the source here, so the shipped taker is provably the tested taker. If you change anything under `src/`, re-vendor and re-run that check.

## Test

```sh
node --test          # 6 tests, zero deps, Node's built-in runner
```

The suites drive both takers over an in-memory transport and mock chains: the full HTLC happy path, a maker stall into refund, the rate-floor abort, and the XMR taker's recovery-before-lock guarantee.

## License

AGPL-3.0-or-later. © 2026 Tech1k.
