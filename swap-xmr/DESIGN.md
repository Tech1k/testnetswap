# The Monero adaptor swap

This documents the design of the Monero adaptor swap that ships in [`swap-xmr`](../../swap-xmr): why Monero needs a construction unlike the same-curve HTLC, how the adaptor-signature swap works, what coin pairs it covers, and the footguns it has to get right. TestnetSwap deploys it one way: Monero settles **into** tBTC or tLTC. The construction is symmetric, but the reverse direction is future work.

## Why Monero needs a different construction

The same-curve `tBTC ↔ tLTC` swap works because both chains speak the same script language: the identical HTLC (one hashlock, one timelock) can live on each side, and revealing the preimage on one chain lets the counterparty claim on the other.

Monero has neither scripts nor timelocks. There is nowhere on the Monero chain to host a hashlock, a refund path, or a "decision engine" for who gets the coins if a swap stalls. So the HTLC trick cannot exist for any XMR pair. The atomic link has to be built entirely on the Bitcoin/Litecoin side and carried across to Monero by cryptography rather than by a matching on-chain script.

## The construction (Gugger adaptor swap)

The design follows the Gugger BTC↔XMR construction (eprint 2020/1126, arXiv 2101.12332), the same one behind the production BTC↔XMR stacks. It settles Monero without any Monero-side script:

1. **No Monero script.** The Monero is locked to a *normal* address whose private spend key is the additive sum of two shares, `k_s = k_s_a + k_s_b` (the view key is shared the same way). Only a party who knows *both* shares can sweep it. There is no multisig protocol, just point addition.
2. **All the logic lives on the BTC/LTC side.** A 2-of-2 output is gated by **ECDSA adaptor signatures** ("one-time VES"), with **relative timelocks** `t1` (cancel) and `t2` (punish). This is where cancel, refund, and punish are enforced.
3. **Claiming the BTC/LTC side on-chain leaks a scalar** that lets the counterparty reconstruct the *full* Monero spend key and sweep the XMR. This is the atomic link, the same role the revealed preimage plays in the HTLC, but carried by an adaptor signature instead of a hashlock.
4. **A cross-curve DLEQ proof** proves in zero knowledge that a secp256k1 public key and an ed25519 public key commit to the **same secret scalar**. Without it the adaptor signatures would not be bound to the Monero key shares. An invalid proof hard-aborts before any funds move.

The two primitives this needs (ECDSA adaptor signatures and a cross-curve secp256k1↔ed25519 DLEQ proof) existed only in Rust (with one Go port), with no JavaScript or WASM implementation anywhere. `swap-xmr` compiles a small Rust crypto core to WASM so the same core runs in the Node maker and the browser taker.

## What the construction supports

| Pair | Non-custodial atomic swap | Mechanism |
|---|---|---|
| tBTC ↔ tLTC | Yes, shipped in `swap-core` | Same-curve HTLC |
| Monero → tBTC | Yes, shipped in `swap-xmr` | This adaptor swap (all script/timelock logic on the BTC side) |
| Monero → tLTC | Yes | Same construction, Litecoin on the script side (Gugger names Litecoin compatible) |
| Monero → Monero (stagenet/testnet) | No direct construction | Both sides are scriptless; only reachable by composing two swaps through a BTC/LTC hub |

Every reachable Monero cell comes from one capability: the script-chain adaptor swap. The Litecoin lane is the same protocol with LTC on the secp256k1 side, so it works with no crypto changes. The construction is symmetric in principle (the reference stacks run it as BTC↔XMR), but TestnetSwap deploys only the Monero-into-BTC/LTC direction.

## How it maps onto TestnetSwap

The plumbing is shared with the HTLC path; the Monero-specific work is concentrated in one crypto core plus a Monero engine.

| Component | Role for the Monero swap |
|---|---|
| `swap-relay` | Unchanged, still a dumb message pipe. The XMR protocol is just different messages over the same transport. |
| `swap-core` | Untouched. The HTLC code does not apply; `swap-xmr` is a parallel module. |
| `swap-xmr` | The crypto core (DLEQ + adaptor sigs, Rust→WASM), the BTC/LTC tx suite, the Monero address/key math, and the async role drivers. |
| `swap-maker` | `src/xmr-handler.js` runs the liveness-critical BTC-provider role per taker session, funding the BTC lock from a dedicated address and sweeping received XMR. |
| Browser taker | Uses the WASM crypto core alongside the wallet's existing Monero engine for keys, scan, lock, and sweep. |

The Monero engine drives `monero-wallet-rpc` (maker) or the wallet's Monero WASM (taker) to lock and sweep; the crypto core supplies the adaptor sigs and DLEQ that bind those actions to the BTC/LTC side.

## Monero-to-Monero routing

With no scripted chain on either side there is no place to host the atomic refund logic, so there is no direct non-custodial Monero↔Monero swap. The non-custodial way to offer it is to chain two adaptor swaps through a script-chain hub:

```
stagenet-XMR  --(adaptor swap)-->  tBTC (hub)  --(adaptor swap)-->  testnet-XMR
```

Each leg is independently atomic and refundable, so custody is never given up. It costs two timeout windows (longer, more monitoring), two sets of fees, and hub (BTC/LTC) liquidity at the maker, and the second leg is a BTC/LTC→XMR swap, the reverse direction, which is future work. Presented to the user it is one route; implemented, it is two real swaps.

## Networks: testnet vs stagenet

The reference BTC↔XMR stacks pair **Bitcoin Testnet3 with Monero Stagenet**, not Bitcoin testnet4 and not Monero testnet. TestnetSwap runs on testnet4 and Monero testnet, so the network assumptions differ from those stacks.

The maker runs `monerod` + `monero-wallet-rpc` for each Monero network it serves (stagenet and/or testnet) to lock and sweep, and the browser taker reaches Monero over the same nodes. CypherFaucet already funds both `xmr-stagenet` and `xmr-testnet`, so pool funding is covered on both networks.

## Security footguns

- **Asymmetric liveness.** The XMR-side party cannot go offline during the swap. If they miss their window after `t1`, the counterparty can `punish` and take the BTC/LTC while the Monero stays locked forever. An always-on maker daemon is fine in this role; a user in it needs a watchtower or a wallet that stays engaged. The design keeps the always-on maker in the liveness-critical BTC-provider role wherever possible.
- **Stranded XMR.** A botched or uncooperative swap can lock the Monero permanently, because there is no script to reclaim it. Refunding the XMR requires the BTC/LTC side to be refunded first.
- **First-lock height and timeout tuning.** The first timelock must be long enough for both chains to confirm safely (Monero's ~10-block lock plus BTC/LTC confirmations). Mis-tuning loses races.
- **DLEQ validation.** An invalid cross-curve DLEQ proof must hard-abort before any funds move.
- **No formal audit** of the upstream crypto. This is acceptable on testnet, where the coins are worthless, but it must be labelled honestly and never imply mainnet readiness.

## Sources

- Gugger BTC↔XMR swap: [eprint 2020/1126](https://eprint.iacr.org/2020/1126.pdf), [arXiv 2101.12332](https://arxiv.org/pdf/2101.12332)
- Cross-curve DLEQ: [comit-network/cross-curve-dleq](https://github.com/comit-network/cross-curve-dleq), [secp256kfun](https://github.com/LLFourn/secp256kfun), [go-dleq](https://github.com/athanorlabs/go-dleq)
- Production stack: [eigenwallet/core](https://github.com/eigenwallet/core) (ex-[UnstoppableSwap](https://github.com/UnstoppableSwap/core), ex-[comit xmr-btc-swap](https://github.com/comit-network/xmr-btc-swap)); beta and not formally audited
- Multi-coin DEX: [BasicSwap](https://github.com/basicswap/basicswap)
- Other-chain reference: [Tari RFC-0241](https://rfc.tari.com/RFC-0241_AtomicSwapXMR)
