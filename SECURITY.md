# Security policy

TestnetSwap is a non-custodial, atomic swap system for **testnet coins only**. This policy describes what the design protects, what it deliberately does not, and how to report a vulnerability.

## Threat model

Every swap is a cross-chain atomic swap. Your funds only ever sit in a contract that either completes the swap or refunds you, and no part of the service (not the maker, not the relay, not a compromised site) ever holds your keys. The safety of a swap rests on the on-chain contracts, not on trusting any operator.

The theft boundary is the load-bearing property, and it holds: a malicious or vanished counterparty can **grief** you (stall a swap, waste your time, make you wait out a timelock), but it cannot **take your coins**. A counterparty cannot claim your contract without revealing the secret that lets you claim theirs, and if it disappears you reclaim your funds after your refund timelock. Denial of service and griefing are possible by design; theft is not.

What this policy is not:

- **Not mainnet.** TestnetSwap runs on Bitcoin testnet4, Litecoin testnet, and Monero testnet/stagenet. The coins are worthless by design. Nothing here should be read as a claim of mainnet readiness, and the code carries no such guarantee.
- **No bug bounty.** There is no reward program. The coins have no value, so there is nothing to steal and nothing to pay out. Reports are still welcome; we want the software to be correct.

## Privacy

Non-custodial is not the same as private. The relay routes the protocol messages in plaintext, and one operator runs the relay, the default maker, the block explorer, and links to the faucet, so a passive relay/operator can correlate a great deal about a swap: your IP address, the timing, the amounts, the deposit and receive addresses, and the link between a taker and the maker it chose. Swaps are **safe** (nobody can take your coins) but they are **not anonymous**. This matters most for **Monero** swaps: moving Monero through here does not give you Monero's usual privacy against the operator, who sees the full message flow and both on-chain endpoints. If you need network-level privacy, put the relay and your explorer/node behind Tor and treat amounts and timing as observable.

## Client integrity

The browser app is served from a single origin (Cloudflare Pages), and every "your keys stay in your browser" guarantee ultimately rests on trusting that origin: there is no subresource-integrity or client-side re-verification of the code the browser runs, because a compromised origin could strip such a check anyway. The vendored crypto is pinned by `testnetswap-site/vendor/VENDOR.lock` and verified in CI (`check-vendor.mjs`), which catches drift against the in-repo canonical sources. The Monero engine (`monero-engine.bundle.js`, `monero.worker.js`) is a large bundle of [monero-ts](https://github.com/woodser/monero-ts). It is **buildable from source you can pin**: `testnetswap-site/tools/monero-bundle` repackages the pinned `monero-ts@0.11.10` npm artifact (whose prebuilt wasm ships inside that package, anchored by the lockfile's `integrity` hash) into the UMD bundle. Anyone can `npm ci && npm run build && npm run verify` to build and load-check a functionally-equivalent bundle from that pinned source. The currently-shipped bundle is a vendored prebuilt artifact (validated by real in-browser swaps); a rebuilt bundle must pass the tool's `verify` (a browser-faithful no-`process` load check) **and** a real browser tXMR→tBTC swap before it is re-vendored; a headless build check alone cannot catch browser-only breakage. What is NOT reproduced here is monero-ts's wasm *itself* from Monero C++ source (emscripten builds are not bit-deterministic and that is upstream's domain); trusting `monero-ts@0.11.10` from npm is the same trust model as any native/wasm dependency, and a far better position than an unanchored blob. The remaining single trust anchor is the serving origin, since a static site has no client-side way to re-verify its own code.

## Review status

The swap protocol, the transaction builders, the relay, and the maker and taker state machines have been through internal adversarial review, and the serious issues it turned up are fixed. That is not a substitute for an independent audit, and none is claimed. The upstream cryptography (the same-curve HTLC on secp256k1, and the cross-curve adaptor and DLEQ crates on the Monero side) is not formally audited. That is acceptable on testnet, and never on mainnet.

## Monero module

Native Monero swaps (`swap-xmr`) are **experimental** and ship **disabled** (`xmr.enabled: false`). One swap leg is intrinsically liveness-critical, in-flight state is best-effort recoverable, and fee-bumping the refund transaction is not yet implemented. Before running that module with any funds (even testnet), work through the before-funds checklist in [`swap-xmr/SECURITY.md`](swap-xmr/SECURITY.md). It tracks exactly what is proven versus what an implementer must still verify against the live chains.

## Reporting a vulnerability

Email **hello@tech1k.com** with a description, reproduction steps, and the impact you see. Please:

- Practice responsible disclosure: report privately first, and give a reasonable window to fix before publishing.
- Keep all testing on testnet. The whole system is testnet-scoped; no testing should ever touch mainnet funds.
- Include enough detail to reproduce: versions, config, transactions, logs.

You will get an acknowledgement, and a follow-up when a fix lands. There is no bounty, so credit in the fix commit or release notes is the thanks on offer. Tell us how you would like to be credited, or if you would rather stay anonymous.
