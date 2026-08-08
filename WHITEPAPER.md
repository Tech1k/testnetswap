# TestnetSwap: Non-Custodial Cross-Chain Atomic Swaps for Testnet Coins, in the Browser

**Kristian Kramer (Tech1k)**  
Independent · [testnetswap.com](https://testnetswap.com) · hello@tech1k.com

**Version 0.1 · August 2026 · Testnet only, experimental**

## Abstract

TestnetSwap is a non-custodial cross-chain atomic swap system for cryptocurrency testnets. It runs two constructions behind one interface. The first is a same-curve Hash Time-Locked Contract (HTLC) swap between Litecoin testnet (tLTC) and Bitcoin testnet4 (tBTC), both secp256k1 UTXO chains. The second is a cross-curve construction that settles Monero (tXMR or sXMR) into either UTXO chain using a secp256k1 to ed25519 discrete-log equality proof combined with an ECDSA adaptor signature that carries a Monero spend-key share across curves. Both sides are signed in the user's own browser. No component of the service, not the maker, not the relay, and not a compromised web server, ever holds the user's keys or coins; a swap's safety rests on on-chain contracts rather than on trusting any operator. The taker engine is a single dependency-injected module that runs unchanged under Node and in the browser, and the cryptographic code is vendored byte-identically across surfaces and enforced by a hash manifest in continuous integration. This document describes the two constructions in detail, states the timelock-safety arguments with their concrete parameters, and gives an honest threat model that separates what has been demonstrated from what a deployment must still verify before it is trusted with anything of value. All coins involved are testnet coins with no monetary value by design. The upstream cryptography is not formally audited. This is a testnet research system, and nothing here claims mainnet readiness.

## 1. Introduction

### 1.1 Motivation

Atomic swaps let two parties exchange coins on different chains without a custodian: either both legs happen or neither does. For two chains that share a scripting model and an elliptic curve, the classic HTLC solves this cleanly. Monero breaks the classic recipe: it has no scripts and no timelocks, so there is nowhere on the Monero chain to host a hashlock, a refund branch, or any decision logic about who receives the coins if a swap stalls. The atomic link therefore has to be built entirely on the Bitcoin or Litecoin side and carried across to Monero by cryptography rather than by a matching on-chain script.

Beyond the cryptography, most working trustless Monero swap implementations are desktop applications that drive a full Monero node. TestnetSwap targets a different and harder deployment: the whole taker runs client-side in a browser tab, non-custodially, with the Monero wallet operations (key-share math, lock-address derivation, scanning, and sweeping) executed as WebAssembly. The goal is a swap a user can perform from a web page without installing software and without ever handing keys to an operator.

### 1.2 Contributions

1. A non-custodial, in-browser implementation of the cross-curve Monero-into-UTXO adaptor swap, including the Monero-side wallet work in WebAssembly.
2. A single taker engine, injected with all heavy dependencies, that runs byte-identically across Node (tests and a CLI), the website, and a wallet, with the shipped browser code provably equal to the tested code via a vendoring hash manifest checked in CI.
3. A same-curve HTLC swap for tLTC and tBTC with an explicit, parameterized timelock-safety argument, including a fee-bumping redeem ladder whose worst-case duration is coupled by a runtime assertion to the secret-reveal safety margin.
4. A threat model and a "proven versus must-verify-before-real-funds" checklist that treats the experimental Monero path honestly and keeps it disabled by default.

### 1.3 Scope and non-goals

TestnetSwap operates on testnet chains only. The coins are worthless by construction, which is what makes it an acceptable place to run cryptography that has had internal adversarial review but no independent formal audit. Native Monero swaps ship disabled (`xmr.enabled: false`) and behind an explicit `i_understand_experimental` acknowledgment. The deployed Monero direction is one-way: Monero settles into tBTC or tLTC, never the reverse. The construction is symmetric and the reverse direction is future work; Section 7 explains why the reverse is not merely a matter of flipping a flag. Nothing in this document should be read as a claim of mainnet safety.

## 2. Background and Prior Work

### 2.1 Same-curve HTLC swaps

A Hash Time-Locked Contract funds an output that can be spent two ways: by anyone who reveals a preimage `S` of a published hash `H = SHA256(S)` and signs with the recipient key, or, after an absolute timelock, by the funder's refund key. Two parties swap by each funding an HTLC on their respective chains under the same `H`. Whoever holds `S` claims the counterparty's output by revealing `S` on-chain; the counterparty reads `S` from that spend and claims the first output. If either side stalls, the timelocks return the coins. TestnetSwap's tLTC and tBTC legs are both secp256k1 P2WSH chains, so a single HTLC construction serves both (`swap-core/src/networks.js:25-42`).

### 2.2 Adaptor signatures

An adaptor signature (a "one-time verifiably encrypted signature") is a signature that is encrypted under a public point `Y = y·G`: it can be verified as a commitment to a valid signature without being one, and it can be completed into a valid signature by anyone who knows the discrete log `y`. Crucially, publishing the completed signature reveals `y` to anyone holding the adaptor. Adaptor signatures let a party's on-chain spend leak a scalar secret as a side effect, which is the mechanism that binds two chains without a shared hashlock.

### 2.3 The Monero scriptless problem

Monero has neither scripts nor timelocks (`swap-xmr/DESIGN.md:9`). It cannot host an HTLC. The only lever available is the spend key of a Monero output. If a Monero output is locked to a key that is the sum of two secret shares held by the two parties, then whoever ends up learning both shares can spend it. The swap is engineered so that the act of settling the Bitcoin or Litecoin side (an ordinary on-chain spend) leaks the missing Monero share to the correct party through an adaptor signature. All refund, cancel, and punish logic lives on the UTXO side.

### 2.4 Prior art and how this differs

The construction follows the Bitcoin-Monero cross-chain atomic swap of Gugger (Cryptology ePrint Archive 2020/1126; arXiv 2101.12332), the same lineage as the Farcaster and UnstoppableSwap / xmr-btc-swap stacks (`swap-xmr/DESIGN.md:11-18`). Those reference stacks typically run the BTC-into-XMR direction as a desktop client with a full node. TestnetSwap differs in three ways: it is browser-based and non-custodial (the Monero WebAssembly wallet runs in the page); it deploys the Monero-into-UTXO direction, which places the liveness-critical role on the always-online maker rather than on the browser user (Section 5.6); and it reuses one injected taker engine across a website and a wallet.

## 3. System Architecture

### 3.1 A six-package monorepo with no build step

The system is six sibling packages, each an ES module at version 0.1.0 with `engines.node >= 20`, under AGPL-3.0-or-later:

| Package | Responsibility |
|---|---|
| `swap-core` | Pure HTLC protocol: contract construction, transaction building, secret handling, state machine, wire messages. No keys, no coins, no server, no UI. |
| `swap-taker` | The client-side taker engine: relay client, chain adapter, HTLC and Monero swap runners. |
| `swap-relay` | A keyless `{sid, msg}` message pipe plus a maker directory. |
| `swap-maker` | The always-on maker daemon: quotes, liquidity, and the counterparty side of every swap. |
| `swap-xmr` | Native Monero swaps via the cross-curve adaptor construction. Experimental, off by default. |
| `testnetswap-site` | The static website and a read-only status and discovery API. |

There is no build step. Sibling packages are linked by `file:` dependencies (for example `swap-taker` depends on `file:../swap-core` and `file:../swap-xmr`), and the cryptographic libraries (`@scure/btc-signer`, `@noble/*`) are vendored as `.mjs` files that run identically in the browser and under Node, with no bundler and no CDN (`swap-core/README.md:39`). Litecoin testnet parameters are defined locally because the vendored signer ships only Bitcoin parameters (`swap-core/src/networks.js:13`).

### 3.2 The dependency-injected two-surface taker engine

The engine in `swap-taker/src/taker.js` takes every heavy dependency as an argument and imports nothing of its own; the exported functions destructure `sc` (swap-core), `x` (the WebAssembly adaptor crypto), `btc`, `as` (adaptor swap), `driver`, and the chain and relay adapters from their parameters. The same file therefore runs on two surfaces:

- Under Node, `swap-taker/src/index.js` provides `loadNodeDeps()`, which bare-imports swap-core and swap-xmr and loads the WebAssembly crypto (`swap-taker/src/index.js:14-20`).
- In the browser, the site injects its own vendored copies: `assets/swap.js` imports `/vendor/swap-core` and `/vendor/swap-taker`, builds an esplora-backed `chains` object, and calls `runHtlcTaker({ sc, transport, chains, km, params })`; `assets/xmr-swap.js` injects the adaptor-swap modules and calls `runXmrTaker(...)`.

The engine holds no long-lived secrets. `genHtlcKeys` mints a fresh preimage and three fresh private keys per swap; state that must outlive a page reload is a small recovery blob handed to the host through awaited hooks and stored by the host, never by the engine (`swap-taker/src/taker.js:31-43`, `:96-99`). Trust in the maker is not assumed inside the engine: the taker funds only after `checkAcceptAgainstQuote`, redeems only after `verifyMakerContract` and `verifyFundedOutput` on the confirmed maker output, and aborts if the execution-time rate falls below the previewed minimum (`swap-taker/src/taker.js:77,127,143,81`).

### 3.3 The relay: a keyless message pipe

The relay is "a dumb WSS message pipe that holds no funds and no keys and never inspects swap semantics" (`swap-relay/src/relay.js:3-4`). It routes line-delimited JSON `{sid, msg}` frames between takers and makers and publishes a maker directory at `GET /roster`. It authenticates makers with an ed25519 challenge whose signed string is domain-separated, relay-bound, and time-bound:

```
"testnetswap-relay-maker|v1|" + relayId + "|" + nonce + "|" + expiry
```

The 32-byte nonce is fresh per socket and the `relayId` binds the signature to this relay, so a signature cannot be replayed to another relay or reused on another connection (`swap-relay/src/relay.js:85-90`; the maker builds the identical string at `swap-maker/src/maker.js:109`). The relay is permissioned by default (`openRegistration: false`), routes a maker's frame to a taker only when the taker's chosen `makerId` matches the authenticated sending socket (blocking cross-maker injection), and validates all self-reported roster strings through `sanitizeInfo` before storing them, because those strings later render into the same origin that holds taker keys (`swap-relay/src/relay.js:97-135`). It enforces payload, per-connection, per-maker, and per-IP limits (Section 6.5). It holds nothing.

### 3.4 The maker daemon

The maker is the always-on counterparty. In an HTLC swap it is the participant that funds second with the shorter timelock, after independently verifying the taker's contract and the taker's funded output at the required confirmation depth (`swap-maker/src/maker.js:331-416`). It quotes and commits liquidity against a free balance defined as confirmed on-chain total minus outstanding reservations, with idempotent reservation accounting so a restart does not double-spend a UTXO into two swaps (`swap-maker/src/pools.js:2-35`). For Monero swaps the maker plays the liveness-critical Bob role (Section 5.6) and funds the UTXO leg from a dedicated settle-coin address that is kept strictly separate from the HTLC pool; the daemon refuses to start if that funding address collides with the pool address (`swap-maker/src/main.js:159-172`). Per-swap Monero key material is derived deterministically from the maker seed and the session id, so in-flight UTXO value is always reconstructable after a crash (`swap-maker/src/main.js:204-211`).

### 3.5 The non-custodial browser model

On the website, the swap page is a self-contained client-side taker. It generates a fresh key held only in the browser, gives the user a deposit address that only the browser controls, and drives the swap against the maker over the relay; the web server holds no keys and no coins (`testnetswap-site/README.md:5`). The per-swap keys live in `localStorage` as hex under `testnetswap.swaps.v1`, are re-derived on reload, and are wiped on completion, leaving only a key-free receipt (`assets/swap.js:87,555,653-660`). The deposit address is the P2WPKH of the ephemeral funding key, whose private key exists only in that browser (`swap-taker/src/taker.js:46-48`). For Monero the user deposits directly to the combined 2-of-2 lock address, which is the lock transaction itself.

The recovery blob is persisted through an awaited hook before any coins move, and persistence failure aborts the swap. In the HTLC path, `runHtlcTaker` calls `await onAfterFund(recovery)` before broadcasting the funding transaction; a throw there aborts before any coins move, and a broadcast that never lands voids the persisted blob so the deposit is treated as untouched (`swap-taker/src/taker.js:96-99,107-109`). In the Monero path, `runXmrTaker` is fail-closed: it requires an `onBeforeLock` hook, persists the full recovery blob, and read-back-verifies it before any tXMR is locked; a failed persist throws rather than proceeding (`swap-taker/src/taker.js:249,297-313`; `assets/xmr-swap.js:405-419`).

### 3.6 Vendoring integrity and content security policy

Because a non-custodial browser guarantee ultimately rests on the served code, the shipped taker must be provably the tested taker. `testnetswap-site/tools/check-vendor.mjs` enforces this two ways. First, a drift check requires every vendored `.js` under the site to be sha256-identical to its in-repo canonical source; the tool's own comment records the incident that motivated it, a silently drifted `swap-xmr/src/swap.js` that had lost a timelock cap and was caught only by luck. Second, a `VENDOR.lock` manifest lists a sha256 for every shipped vendored file, including third-party bundles that have no in-repo canonical (the Monero engine and worker, the WebAssembly, the QR encoder). Any drift, mismatch, or missing entry exits non-zero. The check runs in CI on every push and is required before a manual publish (`.github/workflows/ci.yml`; `DEPLOY.md:151,189`).

The site sets a per-page Content-Security-Policy rather than one on `/*`, because Cloudflare Pages joins same-named headers, so a global policy would intersect with and silently weaken a page policy (`_headers:1-7`). Every page except the swap page is served under a strict policy: `default-src 'none'; script-src 'self'` with a tightly scoped `connect-src` allowlist. The swap page, and only it, relaxes to `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:` with `worker-src 'self' blob:` and the two Monero node origins, plus `Cross-Origin-Embedder-Policy: require-corp`, which the threaded Monero WebAssembly needs for `SharedArrayBuffer`. That relaxation is confined to the one page that holds ephemeral spend keys, and it is defended in depth by relay input validation and by rendering all untrusted roster data through `textContent` only (`_headers:54-62`; Section 6.5). Global hardening on `/*` sets `X-Frame-Options: DENY`, HSTS, `nosniff`, `no-referrer`, and a locked-down `Permissions-Policy`.

## 4. Same-Curve Construction: HTLC (tLTC and tBTC)

### 4.1 The contract

The HTLC witness script, built with the vendored signer and identical on both chains, is (`swap-core/src/htlc.js:59-70`):

```
OP_IF
    OP_SIZE  <0x20>  OP_EQUALVERIFY
    OP_SHA256  <secretHash(32)>  OP_EQUALVERIFY
    OP_DUP  OP_HASH160  <recipientPkh(20)>
OP_ELSE
    <locktime>  OP_CHECKLOCKTIMEVERIFY  OP_DROP
    OP_DUP  OP_HASH160  <refundPkh(20)>
OP_ENDIF
OP_EQUALVERIFY
OP_CHECKSIG
```

The `OP_SIZE 0x20 OP_EQUALVERIFY` forces the preimage to be exactly 32 bytes, closing a preimage-length ambiguity. Both branches converge on a P2PKH-style tail, so the spender must place its public key on the witness stack, not just a signature. The IF branch redeems by revealing a 32-byte `S` with `SHA256(S) == secretHash`, signed by the recipient; the ELSE branch refunds after an absolute CLTV locktime, signed by the refund key. The funded output is a version-0 P2WSH; `verifyContract` recomputes the P2WSH address from the claimed witness script, requires it to equal the expected address, binds every embedded field, and fails closed if any expected argument is missing (`swap-core/src/htlc.js:72,143-157,131-138`).

Locktimes are time-based per BIP65: at or above `CLTV_THRESHOLD = 500000000` they are unix timestamps. `buildContract` rejects any locktime above `0xffffffff`, the maximum 32-bit nLockTime, because a CLTV operand above that can never be satisfied by any transaction and would make the refund branch permanently unspendable (a refund-less contract). The timelock policy layer independently caps durations at `MAX_CLTV_TIME = 4294967295` (the same value), so a real swap locktime, on the order of the current unix time plus a few hours, is always well within range (`swap-core/src/htlc.js:52-53`; `swap-core/src/swap.js:65`).

### 4.2 Role asymmetry and timelock ordering

The role mapping is centralized in `swap-core/src/swap.js:99-125`:

| | Chain it locks | Recipient (claims with secret) | Refund | Locktime |
|---|---|---|---|---|
| Taker (initiator), funds first | send chain | maker | taker | T1 (longer) |
| Maker (participant), funds second | receive chain | taker | maker | T2 (shorter) |

The load-bearing rule is `T1 > T2`. The initiator generates the secret and funds first, so it must hold the longer refund window. Inverting the order would let the initiator reveal at the last moment, claim the counterparty output, and still refund its own before the participant could react.

### 4.3 Timelock validation, in depth

`validateTimelocks({t1, t2, nowSec})` enforces, in order (`swap-core/src/swap.js:80-95`): both timelocks are integers; the upper bound `<= MAX_CLTV_TIME` is checked first, fail-closed; both `>= 1`; `t2 < t1` strictly; `t1 - t2 >= MIN_T_GAP_SECS`; and, when `nowSec` is supplied, `t2 - nowSec >= MIN_T2_FROM_NOW_SECS` and `t1 - nowSec <= MAX_SWAP_SECS`. The constants are `MIN_T_GAP_SECS = 4 h`, `MIN_T2_FROM_NOW_SECS = 3 h`, and `MAX_SWAP_SECS = 7 days`; defaults are `T1 = 12 h`, `T2 = 6 h` (`swap-core/src/swap.js:52-66`).

(One documentation-versus-code note for precision: several prose files describe the minimum gap as "2h," but the enforced constant in code is 4 h, raised for testnet4 confirmation lag. The enforced value is 4 h.)

The same constraints are re-checked at four more layers: a stateless wire floor on the ACCEPT message; a time-aware `checkAcceptAgainstQuote` that binds the quote id, pair, amounts, and absolute locktimes to the quoted durations with slack and runs the full `validateTimelocks`; `verifyMakerContract` before revealing; and an on-chain binding that asserts the script-embedded locktime equals the expected value (`swap-core/src/protocol.js:109-127,167-191`; `swap-core/src/swap.js:133-137,145`; `swap-taker/src/taker.js:77,127`).

### 4.4 Protocol and state machine

Messages are line-delimited JSON over the relay; byte fields are hex and amounts are integer satoshis (`swap-core/src/protocol.js`):

```
taker -> maker : request_quote { from, to, send_sats }
maker -> taker : quote        { ..., recv_sats, rate, t1_hours, t2_hours, quote_id, expiry }
taker -> maker : initiate     { quote_id, secret_hash, taker_recv_pubkey, taker_refund_pubkey, ... }
maker -> taker : accept       { quote_id, recv_sats, t1, t2, maker_recv_pubkey, maker_refund_pubkey, ... }
taker -> maker : taker_locked { quote_id, contract_addr, fund_txid, vout, t1 }
maker -> taker : maker_locked { quote_id, contract_addr, fund_txid, vout, t2 }
   (taker redeems on-chain revealing S; maker extracts S and redeems)
any            : abort | error { quote_id?, reason }
```

`parseMessage` rejects prototype-pollution keys (`__proto__`, `constructor`, `prototype`), restricts tickers to tBTC and tLTC, and bounds sizes and amounts (`swap-core/src/protocol.js:146-154,29-30,47`). The state machine runs `created -> taker_funded -> maker_funded -> redeemed -> completed`, with `refundable`, `refunded`, `aborted`, and `failed`; `redeemed` marks the point where the secret becomes public and `completed` marks the maker's follow-on claim (`swap-core/src/swap.js:20-48`).

### 4.5 The reveal margin and the redeem fee ladder

The safety-critical moment is the taker's redeem, which reveals `S`. The taker refuses to reveal unless it has a comfortable margin before T2:

```
reveal only if   accept.t2 - now()  >=  revealMinMarginSecs  ( = 2 h )
```

Otherwise it aborts without revealing and refunds at T1 instead (`swap-taker/src/taker.js:146-151`). Once revealed, `S` is public from the first broadcast, so receipt depends on the redeem confirming before T2. To keep a low-fee redeem from stalling on a congested chain, the taker runs an RBF ladder: it rebroadcasts the same input at an escalating fee rate (`2 -> 8 -> 14 -> ... -> 40` sat/vB), spaced by a full poll window tuned to testnet4's roughly ten-minute blocks, until the redeem confirms or the ceiling is reached (`swap-taker/src/taker.js:155-186`). The defaults are `redeemBumps = 7`, `redeemPollTries = 10`, `redeemPollMs = 60 s`, `redeemMaxFeeRate = 40`.

The realized worst-case ladder duration is eight inner cycles of nine minutes, about 72 minutes, comfortably inside the 120-minute reveal margin. A runtime assertion couples the two so that no caller can misconfigure them into an unsafe state (`swap-taker/src/taker.js:60-63`):

```
redeemBumps * (redeemPollTries - 1) * redeemPollMs  <  revealMinMarginSecs * 1000
```

(For precision: the assertion counts seven inner windows, about 63 minutes, one window fewer than the loop's realized 72; both are below 120 minutes, so the coupling holds, but the exact worst case a reader should cite is 72 minutes.)

Two independent margins protect the two parties. `revealMinMarginSecs` (2 h, taker-side) ensures the taker's own redeem confirms before T2. `MIN_T_GAP_SECS` (4 h, protocol-side) ensures that after the taker reveals `S`, the maker still has at least the gap (6 h at defaults) to read `S` and confirm its claim on the taker's T1 output before T1 opens the taker's refund. Do not conflate them.

After the ladder, a tail loop keeps the max-fee redeem in the mempool and keeps polling until it confirms or T2 is within `tailBufferSecs` (120 s), so the redeem gets the entire remaining safe window rather than just the ladder span. The engine reports success only on an actual confirmation: the return carries a `confirmed` flag, and if the redeem is still unconfirmed it retains the full recovery blob rather than nulling it, so the host keeps monitoring instead of losing the coin should the redeem be evicted (for example by the maker's T2 refund on a stalled chain) (`swap-taker/src/taker.js:187-203`).

### 4.6 Fees, dust, and coin selection

Spends use a fee fixpoint loop rather than a single-pass estimate, because ECDSA DER signatures vary from 71 to 73 bytes with no low-R grinding; the loop measures the finalized virtual size and bumps the fee until it covers `ceil(vsize * feerate)`, guarding against a non-relayable, funds-stranding refund (`swap-core/src/tx.js:16-20,84-101`). A dust guard (`DUST = 546`) rejects outputs that cannot cover their own spend, and `buildFundingTx` enforces a minimum HTLC value `DUST + ceil(175 * feerate)` so the funded output can pay its own redeem and clear dust, plus an exactly-one-output binding so a short or ambiguous contract output can never be reported as funded (`swap-core/src/tx.js:143-151,167-177`). The taker selects only confirmed inputs, largest first, never spending an unconfirmed or replaceable input into a contract (`swap-taker/src/taker.js:85-91`).

### 4.7 Recovery

The recovery blob holds parameters only; the contract is re-derived deterministically in `refundHtlc`, which refuses before T1, rebuilds the ELSE-branch refund, and broadcasts (`swap-taker/src/taker.js:210-231`). Because the blob is persisted before broadcast and voided if the broadcast never lands, a crash at any point leaves the funds either untouched or refundable, never stranded in an unknown state.

## 5. Cross-Curve Construction: Monero into BTC/LTC

Roles here are fixed by the protocol, not by who is taker or maker: **Alice** is the Monero provider (locks XMR, receives the UTXO coin) and **Bob** is the UTXO provider (locks BTC or LTC, receives XMR, and is liveness-critical). The crate versions underlying the crypto claims are `ecdsa_fun 0.12.0`, `sigma_fun 0.9.0`, `secp256kfun 0.12.1`, and `curve25519-dalek-ng 4.1.1` (`swap-xmr/crypto/Cargo.toml`).

### 5.1 The idea

A Monero output is locked to a standard address whose public spend key is the sum of two ed25519 points, `S_a + S_b`, and whose view key is `V_a + V_b`; this is ordinary point addition, not a multisig protocol (`swap-xmr/src/monero.js:70-74`). Whoever learns both private shares `m_a` and `m_b` can reconstruct the spend key and sweep the output. The swap arranges that Bob's settlement of the UTXO leg leaks `m_a` to Bob (the happy path), and that a UTXO-side refund leaks `m_b` to Alice (so she can reclaim her XMR). Everything decisional lives on the UTXO side as a small suite of scripts.

### 5.2 The cross-curve DLEQ

The atomic link rests on a discrete-log equality proof across two curves: one 252-bit scalar `s` is simultaneously the discrete log of a secp256k1 point `P = s·G_secp` (the adaptor encryption key) and of an ed25519 point `M = s·G_ed` (a Monero spend-key share). The proof is produced by `sigma_fun`'s `dl_secp256k1_ed25519_eq` construction, a bit-wise Pedersen-commitment equality proof, instantiated here with domain-separated NUMS generators `TestnetSwap/DLEQ/secp256k1/H_p/v1` and `TestnetSwap/DLEQ/ed25519/H_q/v1`, with Fiat-Shamir over SHA-256 (`swap-xmr/crypto/src/lib.rs:27-35,84-87`). Because the two group orders both exceed `2^252` and every share is clamped below `2^252`, the same integer is a canonical scalar in both fields, and the secp form of a share is simply the byte-reversal of its ed form (`swap-xmr/src/adaptorswap.js:36`; `swap-xmr/crypto/src/lib.rs:146-151`).

Before trusting a counterparty bundle, `verifyBundle` runs a total, never-throwing check (`swap-xmr/src/adaptorswap.js:66-88`): shapes and lengths; that the DLEQ points bind to the bundle's advertised adaptor point and Monero share (`dleq.secp === P` and `dleq.ed === M`); that `M` and `Vpub` are not the ed25519 identity (a zero share would make the combined key one-sided); that the openly shared private view scalar matches the advertised view point; and finally `dleq_verify`. Points are structurally on-curve by construction (secp points reject non-curve input, ed points must decompress) and the secp point must be non-zero (`swap-xmr/crypto/src/lib.rs:215-225`).

### 5.3 ECDSA adaptor signatures and share transport

The adaptor primitive is `ecdsa_fun`'s `Adaptor` with deterministic (RFC6979-style) nonces, so signatures are deterministic (`swap-xmr/crypto/src/lib.rs:19,31`). The share is carried as follows:

- **Redeem leg (leaks `m_a` to Bob).** Bob encrypts his ECDSA signature over the redeem sighash under Alice's point `P_a`. Alice verifies that adaptor (fail-loud), completes it using her share `m_a` to obtain Bob's finished signature, and broadcasts tx_redeem to take the UTXO coin. Publishing that signature lets Bob recover `m_a` via `adaptor_recover(P_a, publishedSig, redeemAdaptor)`, then compute the combined spend key `m_a + m_b` and sweep the XMR (`swap-xmr/src/adaptorswap.js:181-203`).
- **Refund leg (leaks `m_b` to Alice).** Symmetrically, Alice's refund adaptor is encrypted under Bob's `P_b`; Bob's refund recovers `m_b` to Alice so she can reclaim her XMR (`swap-xmr/src/adaptorswap.js:207-227`).

The witness indices that carry the adaptor-completed signatures are pinned as named constants co-located with the finalizers so they cannot drift: `REDEEM_ADAPTOR_WITNESS_INDEX = 2` and `REFUND_ADAPTOR_WITNESS_INDEX = 1` (`swap-xmr/src/btcswap.js:108-118,126-155`). Every witness signature is asserted low-S and canonical before use, because negating `s` to force low-S would break the recovery relationship that leaks the Monero share (`swap-xmr/src/btcswap.js:28,35-44,67`).

### 5.4 NUMS generators

Both DLEQ generators are genuine Nothing-Up-My-Sleeve points, required for the soundness of the equality proof on which atomicity rests. The secp256k1 generator uses try-and-increment over `SHA-256(domain || counter)` placed into a compressed even-y encoding; the ed25519 generator does the same, then clears the cofactor with `mul_by_cofactor()` and rejects the identity, so it is guaranteed torsion-free and in the prime-order subgroup (`swap-xmr/crypto/src/lib.rs:39-76`, tested at `:341-355`). Scalar hygiene is enforced throughout: fresh shares are drawn with a non-panicking RNG, masked below `2^252`, and rejected if zero; the DLEQ prover rejects a secret with its top four bits set (which would otherwise abort the WebAssembly module) and rejects zero (`swap-xmr/crypto/src/lib.rs:133-143,185-190`).

### 5.5 The UTXO script suite and CSV timelocks

All decisional logic is a small set of P2WSH spends built with the vendored signer (`swap-xmr/src/btcswap.js`, `swap-xmr/src/adaptorswap.js`):

- **tx_lock** is an unsorted 2-of-2 of Alice and Bob, so the signature order is fixed `[A, B]`.
- **tx_redeem** spends tx_lock to Alice with no sequence lock, so it can confirm immediately; its witness carries Bob's adaptor-completed signature at index 2.
- **tx_cancel** spends tx_lock after a relative timelock `T1` (BIP68 CSV) to a two-branch cancel output.
- The **cancel script** has an IF branch that is a 2-of-2 refund (Alice plus Bob) and an ELSE branch that lets Alice punish alone after a further relative timelock `T2`, using a distinct punish key:
  ```
  IF   <pubA> CHECKSIGVERIFY <pubB> CHECKSIG
  ELSE <t2Blocks> CHECKSEQUENCEVERIFY DROP <punishPubA> CHECKSIG
  ENDIF
  ```
- **tx_refund** is Bob spending the cancel IF branch; its witness carries Alice's adaptor-completed signature at index 1, which is what leaks `m_b` to Alice.
- **tx_punish** is Alice spending the cancel ELSE branch after T2, taking Bob's coin if Bob cancelled but never refunded.

Timelocks are relative block counts validated by `validateXmrTimelocks` (`swap-xmr/src/swap.js:66-73`): both within the BIP68 block range and the anti-griefing cap `MAX_T_BLOCKS = 1000`; `t2 >= 12`; and `t1 >= MIN_T1_BLOCKS = 22`, which is the Monero ten-block output maturity plus a twelve-block margin. Defaults are 72 blocks for tBTC and 288 for tLTC, each about twelve hours (`swap-xmr/src/swap.js:43-58`). BIP68 correctness requires transaction version 2, which the vendored signer sets by default; this is noted rather than asserted in-repo.

### 5.6 Roles, liveness asymmetry, and theft-safe ordering

Monero's lack of a reclaim script creates an intrinsic, one-sided liveness risk. If Bob (the UTXO provider) misses his refund window at T2, Alice can punish and take his UTXO coin while the XMR stays locked forever, because there is no Monero-side script to reclaim it (`swap-xmr/DESIGN.md:65-66`; `swap-xmr/SECURITY.md:30-31`). This is a property of the protocol, not a bug, and it is minimized by generous timelocks and, eventually, by aggressive refund fee-bumping (Section 7). The design deliberately assigns the liveness-critical Bob role to the always-online maker; the deployed Monero-into-UTXO direction is exactly the direction in which the browser user is Alice, the safer role. Running the reverse direction would put a casual browser user into the liveness-critical seat, which is why it is future work rather than a flag flip (`swap-xmr/src/swap.js:21-41`; `swap-xmr/DESIGN.md:3,65`).

The ordering that makes theft impossible, rather than merely inconvenient, is precise (`swap-xmr/src/driver.js`, `swap-xmr/src/swap.js:84-91`):

1. Bundles are exchanged and `verifyBundle`'d before anything funds.
2. tx_lock is built but not broadcast; the cancel pre-signatures and the refund adaptor are exchanged and verified; then, and only then, tx_lock is broadcast last. Bob verifies Alice's cancel pre-signature and refund adaptor before he funds.
3. Alice does not lock XMR until tx_lock has reached her confirmation depth and she holds Bob's cancel pre-signature (her unwind path), and she binds the funded output to the authoritative on-chain script and amount before locking.
4. The load-bearing theft gate: Bob releases the redeem adaptor only after Alice's XMR lock is confirmed and matured (its unlocked balance meets the amount). Releasing earlier would let Alice redeem the UTXO coin, revealing `m_a`, without ever locking XMR.
5. Alice broadcasts tx_redeem (revealing `m_a`) only after receiving and verifying Bob's redeem adaptor and passing a fund-safety margin check, `redeemMarginReason`.

`redeemMarginReason` (`swap-xmr/src/driver.js:53-67`) returns a reason to abort rather than reveal if: the lock is already spent (a cancel); confirmations cannot be read (fail-closed); the lock is shallower than an absolute reorg-safe floor `minRevealConf`; or the margin `t1Blocks - confs` is below `safetyBlocks = 12`. The reorg floor exists because on a low-hashrate settle chain, a reorg deeper than the lock could evict it and let a maker who double-spends its funding UTXO scrape `m_a` from the mempool redeem and still keep its coin. `minRevealConf` defaults to the lock-acceptance depth (which itself defaults to 1) and is intended to be set deeper by production surfaces; a testnet4-class chain uses six confirmations. Every trip is fail-safe: it aborts to the maker-refund reclaim, never to a loss. The same margin check runs twice on the resume path, before requesting the adaptor and again immediately before broadcasting, because the adaptor wait is long and maker-paced.

Bob, from the moment the XMR locks, watches the lock for tx_redeem, recovers `m_a` on sight, and sweeps before the T1 cancel window can race him; once tx_redeem is seen confirmed, the cancelled branch is unreachable and is never treated as terminal for the XMR claim. Symmetrically, because tx_punish spends a CSV input it is replaceable, so an online maker can RBF-evict a punish with a refund; punish is therefore never terminal until it confirms, and on replacement Alice recovers `m_b` and reclaims the XMR instead, which is strictly better for her (`swap-xmr/src/driver.js:130-133,413-428`).

### 5.7 State machine, recovery, and resume

The driver states are `CREATED, BTC_LOCKED, XMR_LOCKED, BTC_REDEEMED, COMPLETED, CANCELLED, REFUNDED, PUNISHED, ABORTED, FAILED`, with the terminal set `{COMPLETED, REFUNDED, PUNISHED, ABORTED, FAILED}` (`swap-xmr/src/swap.js:96-122`). There is a recovery path for each way a swap can stall:

- `bobUnwind` cancels then refunds, but re-checks at every step whether Alice already redeemed; if she has, Bob recovers `m_a` and sweeps rather than refunding.
- `bobReconstructUnwind` rebuilds all unwind material after a crash from a minimal JSON blob persisted before the lock was broadcast, deriving everything else deterministically from Bob's seed.
- `aliceResumeRedeem` finishes a persisted swap forward by re-driving only the redeem tail, cross-checking the reconstructed lock address against the saved one and running the margin gate twice; it returns either `redeemed` or an explicit `must_reclaim` reason.
- `aliceReclaimOrPunish` is the canonical stall recovery: it gets a cancel on-chain, then races the maker's refund (recover `m_b`, sweep, the cooperative outcome) against the cancel maturing past T2 with no refund (punish for the UTXO coin), falling back to reclaim if a punish loses to an RBF refund.

### 5.8 Monero key math

The lock address is a standard Monero address with combined public keys; the claimer restores a wallet from the combined private keys `m_a + m_b` and `v_a + v_b` and sweeps the unlocked balance home (`swap-xmr/src/monero.js:70-109`). Network bytes are mainnet 18, testnet 53, stagenet 24. In the browser, this wallet work is the injected Monero WebAssembly engine; in the maker, it is a monero-ts backend.

## 6. Security Analysis and Threat Model

### 6.1 The non-custodial guarantee

The load-bearing property, stated precisely (`SECURITY.md:7-9`): a malicious or vanished counterparty can grief you, stalling a swap, wasting your time, and making you wait out a timelock, but it cannot take your coins. A counterparty cannot claim your contract without revealing the secret that lets you claim theirs, and if it disappears you reclaim your funds after your refund timelock. Denial of service and griefing are possible by design; theft is not. No part of the service, not the maker, not the relay, and not a compromised site, ever holds your keys.

### 6.2 Trust anchors

Three things must still be trusted, and the project states them plainly:

1. **The serving origin.** A static site has no client-side way to re-verify its own code, so the "your keys stay in your browser" guarantee ultimately rests on trusting the origin that served the page; a compromised origin could strip any self-check. The mitigation is the vendoring hash manifest in CI (Section 3.6), which makes the shipped code provably equal to the tested code, and confining the relaxed CSP to the one key-holding page (`SECURITY.md:22`).
2. **Block explorers.** The taker verifies the maker's on-chain lock against a block explorer before revealing. For tBTC this is the independent mempool.space, which is what keeps the swap non-custodial; the taker's tBTC verification must not be repointed at an operator-run explorer. For tLTC there is currently no reliably synced independent testnet explorer, so an operator-run one is used, an explicitly documented testnet tradeoff (`DEPLOY.md:25`; `swap-maker/config.example.json:6`).
3. **The upstream cryptography.** The same-curve HTLC on secp256k1 and the cross-curve adaptor and DLEQ crates on the Monero side are not formally audited. This is acceptable on testnet and never on mainnet. The protocol, transaction builders, relay, and state machines have had internal adversarial review whose findings are fixed, but that is not a substitute for an independent audit, and none is claimed (`SECURITY.md:26`; `swap-xmr/SECURITY.md:29`).

### 6.3 Proven versus must-verify

The Monero module's security file separates what has been demonstrated from what a real-funds deployment must still verify. Proven: the cross-curve cryptography and the atomic link (an adaptor scalar reconstructs the Monero share); a BTC adaptor 2-of-2 redeem accepted on testnet4 with the scalar recovered from the witness; the full transaction suite constructed and checked offline; the Monero address and combined-key chain byte-identical to monero-ts; and an in-process two-party simulation of the happy and refund paths with real crypto. Must verify before real funds, eight items not covered by the offline simulation: on-chain CSV enforcement of cancel and punish; a live Monero join from a real redeem witness; the timelock race against Monero's ten-block maturity tuned to measured block-time variance; refund fee-bumping near T2; counterparty abort at every stage; reorg handling gated on a confirmation-depth policy; relay-layer message binding and replay resistance; and a redeem-watch loop with retries that wins the T1 race (`swap-xmr/SECURITY.md:6-25`).

### 6.4 Reorg handling

On the HTLC path the maker requires confirmations before acting (example config 2, code fallback 3), zero is rejected as accepting mempool-only funding, and the taker refuses to reveal within the two-hour margin of T2 (Section 4.5). On the Monero path the reveal is gated by the `minRevealConf` reorg floor and the twelve-block cancel-window margin described in Section 5.6, both fail-safe to reclaim. The general design goal, stated in the deployment guide, is that a stall costs liveness, not funds.

### 6.5 Denial of service and defenses

The relay enforces, with these defaults: a 256 KiB payload cap (sized for the roughly 114 KB cross-curve DLEQ bundle, whose earlier 64 KiB cap silently broke every XMR swap); at most 500 takers, 64 makers, and 8 connections per IP; 2 pending makers per IP; 120 messages per minute per taker connection and 600 per maker; and per-IP roster rate limiting. Origin-bearing browser handshakes are matched against an optional allowlist, while origin-less non-browser clients (the loopback maker, native wallets) pass, so browser drive-by abuse is blocked without rejecting the maker. Taker-to-maker frames are shed rather than allowed to disconnect the authenticated maker under backpressure, and a flooding taker is closed after a threshold. All roster strings are validated and length- and charset-capped before storage and rendered only as text (`swap-relay/src/relay.js:25-62,97-135,175-179,227-230`). The maker adds economic anti-griefing limits: a global in-flight cap, one swap in flight per peer, and a deliberately short accept timeout so an unfunded reservation that pins liquidity self-heals in minutes (`swap-maker/config.example.json`).

The secure defaults are shipped, not aspirational: Monero disabled (`xmr.enabled: false`) behind an explicit experimental acknowledgment, and permissioned maker registration (`openRegistration: false`, fail-closed) with ed25519 identities bound to the relay.

### 6.6 Privacy, not anonymity

Because one operator may run the relay, the default maker, a block explorer, and the faucet link, and because the relay routes protocol messages in plaintext, a passive operator can correlate a taker's IP, timing, amounts, deposit and receive addresses, and the taker-to-maker link. Swaps are safe (nobody can take your coins) but not anonymous; moving Monero through the system does not confer Monero's usual privacy against the operator, who sees the full message flow and both on-chain endpoints. Tor and treating amounts and timing as observable are the offered mitigations (`SECURITY.md:18`).

## 7. Limitations and Future Work

- **The Monero redeem and refund transactions are fixed-fee with no RBF ladder.** Both Alice's redeem and Bob's refund broadcast once at a fixed 1000-sat fee, so a congested or stalled settle chain could leave either unconfirmed past its window; the redeem case would let the maker scrape `m_a` and keep both legs, the refund case would strand XMR. This is the Monero analogue of the HTLC redeem ladder, which is implemented, and the driver's is not yet. An amount-changing RBF changes the sighash and so requires re-making the adaptor and ECDSA signatures, which is why the fix is a design task (pre-signed fee tiers or a re-run adaptor exchange) rather than a one-line change (`swap-xmr/SECURITY.md:21`). The Monero module ships disabled partly because of this edge.
- **The reveal reorg-floor default.** `minRevealConf` defaults to the lock-acceptance depth (1); production surfaces set it deeper (six on a testnet4-class chain), but the safe default and the right per-chain depth are a tuning decision that wants live reorg measurement. The behavior is fail-safe regardless.
- **The reverse direction (BTC or LTC into XMR)** is future work. The construction is symmetric, but the reverse places the liveness-critical role on the browser user, which needs either a watchtower or a different trust model.
- **A formal audit of the upstream crypto.** The cross-curve DLEQ, adaptor, and secp256kfun crates are not formally audited; the internal soundness of the equality proof must be cited to the upstream crate, which this project instantiates rather than reimplements.
- **Torsion checking of party-supplied points.** Party-supplied ed25519 `M` points are decompressed (on-curve) but not explicitly checked for torsion-freeness; only the NUMS generators are cofactor-cleared. Whether a small-subgroup `M` is exploitable depends on the upstream crate's handling and is not determinable from this repository alone.
- **The relaxed CSP on the swap page.** The one page that holds keys runs with `unsafe-eval` because the current Monero WebAssembly build needs it. Confirming whether only `wasm-unsafe-eval` suffices, and dropping `unsafe-eval` if so, would tighten the highest-value surface.

## 8. Conclusion

TestnetSwap demonstrates that a non-custodial cross-chain atomic swap, including the hard cross-curve Monero-into-UTXO direction, can run entirely in a browser tab with the user signing both legs and no operator ever holding keys. The same-curve HTLC path is proven end to end on testnet with an explicit, parameter-coupled timelock-safety argument. The cross-curve path implements the Gugger construction faithfully, with the theft-critical ordering, verification gates, and reorg floors in place, and with a recovery and resume story for both roles. The engineering around the cryptography, one injected taker engine across surfaces, a vendoring hash manifest that makes the shipped code provably the tested code, secure-by-default configuration, and a threat model that says exactly what remains unverified, is what makes the result trustworthy as a testnet system rather than merely clever. The honest boundaries, testnet only, experimental Monero, unaudited upstream crypto, and the specific must-verify list, are stated so that no one mistakes a research artifact for a production one.

## Appendix A: Key Parameters

| Parameter | Value | Location |
|---|---|---|
| HTLC default T1 / T2 | 12 h / 6 h | `swap-core/src/swap.js:52-53` |
| HTLC minimum T1 - T2 gap | 4 h (enforced) | `swap-core/src/swap.js:59` |
| HTLC reveal margin before T2 | 2 h | `swap-taker/src/taker.js:59` |
| HTLC redeem RBF ladder | 2 to 40 sat/vB, worst case ~72 min | `swap-taker/src/taker.js:59,155-186` |
| HTLC max swap horizon | 7 days | `swap-core/src/swap.js:66` |
| Dust | 546 sats | `swap-core/src/crypto.js:15` |
| XMR T1 / T2 default (tBTC) | 72 / 72 blocks (~12 h) | `swap-xmr/src/swap.js:45-46` |
| XMR minimum T1 | 22 blocks (10-block maturity + 12) | `swap-xmr/src/swap.js:48` |
| XMR redeem safety margin | 12 blocks before cancel window | `swap-xmr/src/driver.js:201` |
| XMR reveal reorg floor | `minRevealConf`, deeper than lock-accept depth | `swap-xmr/src/driver.js:53-67` |
| Monero output maturity | 10 blocks | `swap-xmr/src/swap.js` |
| DLEQ / adaptor scalar bound | < 2^252 | `swap-xmr/crypto/src/lib.rs:133-143` |
| Relay max payload | 256 KiB (for ~114 KB bundle) | `swap-relay/src/relay.js:35` |

## Appendix B: References

1. J. Gugger. *Bitcoin-Monero Cross-chain Atomic Swap.* Cryptology ePrint Archive, Report 2020/1126 (also arXiv:2101.12332).
2. A. Poelstra. *Adaptor Signatures and Scriptless Scripts.*
3. comit-network. *cross-curve-dleq* (secp256k1 to ed25519 discrete-log equality).
4. BIP 65 (OP_CHECKLOCKTIMEVERIFY), BIP 68 (relative lock-time via nSequence), BIP 112 (OP_CHECKSEQUENCEVERIFY), BIP 143 (segwit v0 sighash), BIP 66 (strict DER), BIP 125 (opt-in RBF).

## How to Cite

Kristian Kramer (Tech1k). *TestnetSwap: Non-Custodial Cross-Chain Atomic Swaps for Testnet Coins, in the Browser.* Version 0.1, August 2026. https://testnetswap.com/whitepaper

```bibtex
@techreport{kramer2026testnetswap,
  author      = {Kramer, Kristian},
  title       = {{TestnetSwap: Non-Custodial Cross-Chain Atomic Swaps for Testnet Coins, in the Browser}},
  institution = {Independent},
  year        = {2026},
  month       = {8},
  type        = {Whitepaper},
  note        = {Version 0.1. Testnet only, experimental},
  url         = {https://testnetswap.com/whitepaper}
}
```

---

*This document describes a testnet research system. All coins are testnet coins with no value. The cryptography is not formally audited. Do not use this construction with anything of value.*
