# swap-core

The cross-chain HTLC atomic-swap protocol that powers [TestnetSwap](https://testnetswap.com): non-custodial swaps between **Litecoin testnet (tLTC)** and **Bitcoin testnet4 (tBTC)**.

This is the shared library: **one implementation of the crypto, two consumers.** The taker engine (shipping in the testnetswap.com swap page and in the [TestnetWallet](https://testnetwallet.net) swap tab) and the always-on maker daemon ([swap-maker](../swap-maker)) both import it. It holds no keys, no coins, runs no server, and has no UI; it is pure protocol: contract construction, transaction building, secret handling, the state machine, and the wire messages.

Part of the testnet tooling family alongside CypherFaucet, TestnetPool, and TestnetWallet.

## Why it's safe

Every swap is a classic same-curve HTLC atomic swap (BIP199 / the `decred/atomicswap` construction). The user's funds only ever sit in a contract that either **completes the swap** or **refunds to them**. A vanished or malicious counterparty cannot take coins: it cannot claim your contract without revealing the secret that lets you claim theirs, and if it disappears you refund after your timelock.

The single load-bearing safety rule, enforced in code (`validateTimelocks`): the **initiator (taker) always gets the longer refund window** (`T1 > T2`). Inverting this would let the initiator reveal the secret at the last moment, claim, and still refund. Never invert it.

## The contract

A P2WSH witness script, identical on both chains:

```
OP_IF
    OP_SIZE 0x20 OP_EQUALVERIFY          // secret must be exactly 32 bytes
    OP_SHA256 <secret_hash> OP_EQUALVERIFY
    OP_DUP OP_HASH160 <recipient_pkh>
OP_ELSE
    <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
    OP_DUP OP_HASH160 <refund_pkh>
OP_ENDIF
OP_EQUALVERIFY
OP_CHECKSIG
```

- **Redeem (IF):** reveal a 32-byte secret whose SHA256 matches `secret_hash`, signed by `recipient`.
- **Refund (ELSE):** after `locktime` (CLTV), signed by `refund`.

Locktimes are **time-based (unix seconds, BIP65)** by default; testnet block production is too irregular to give predictable refund windows, so a wall-clock deadline maps cleanly to the wallet's "refundable after HH:MM" UX.

## Built on

`@scure/btc-signer` (custom scripts, P2WSH, PSBT signing) + `@noble` (sha256, secp256k1), **vendored** in `vendor/`: no `bitcoinjs-lib`, no bundler, no CDN. The same `.mjs` files run in the browser and under Node. Litecoin testnet network params are defined locally (the library only ships Bitcoin params).

## API

```js
import * as sc from '@testnetswap/swap-core'; // or: import ... from './src/index.js'

// secret
const secret = sc.randomSecret();
const secretHash = sc.secretHashOf(secret);

// safe timelocks (throws if T1 <= T2)
const { t1, t2 } = sc.computeTimelocks(Date.now() / 1000);

// taker's contract on the SEND chain (recipient = maker, refund = taker, T1)
const contract = sc.takerContractParams({
  secretHash, makerRecvPubkey, takerRefundPubkey, t1, sendCoin: 'tLTC',
});
// -> { address, witnessScript, scriptPubKey, locktime, ... }   fund contract.address

// claim the maker's contract, revealing the secret
const redeem = sc.buildRedeemTx({ contract: makerContract, utxo, secret, privkey, destAddress, feeRate, network });

// counterparty recovers the secret from the redeem tx's witness
const S = sc.extractSecret(redeemTxHexOrEsploraObj, secretHash);

// reclaim your own contract after the timelock
const refund = sc.buildRefundTx({ contract, utxo, privkey, destAddress, feeRate, network });
```

Verify a counterparty's funded contract before acting on it (binds address + secret hash + your pubkey + the agreed locktime):

```js
const v = sc.verifyMakerContract({ witnessScript, fundedAddress, secretHash, takerRecvPubkey, makerRefundPubkey, t2, recvCoin: 'tBTC' });
if (!v.ok) abort(v.reason);
```

Wire messages (line-delimited JSON over the relay; byte fields are hex, amounts are integer sats):

```js
const msg = sc.buildMessage.initiate({ quoteId, from, to, sendSats, secretHash, takerRecvPubkey, takerRefundPubkey });
const { ok, reason } = sc.validateMessage(msg);
```

## Security: what consumers MUST enforce

swap-core gives you fail-closed primitives, but the taker session (wallet) and the maker daemon are responsible for using them. Before locking liquidity or revealing the secret:

1. **Bind to real coins, not claims.** A counterparty's `*_locked` message carries a `contract_addr` *and* a `fund_txid:vout`, both attacker-chosen. `verifyContract` only proves the script hashes to an address. You must independently fetch the output at `(fund_txid, vout)` from a trusted chain source and pass its scriptPubKey + value to **`verifyFundedOutput`**; confirm it pays the agreed script and holds ≥ the agreed amount (with confirmations).
2. **Re-check the timelocks with the current time.** `validateMessage` enforces a stateless floor (time-based CLTV, `T1 − T2 ≥ 4h` = `MIN_T_GAP_SECS`), but not T2 recency. Run **`checkAcceptAgainstQuote(quote, accept, nowSec)`** (binds `quote_id` + `recv_sats` + `validateTimelocks`) before funding, and pass `t1/t2/nowSec` to `verifyMakerContract`/`verifyTakerContract`.
3. **Verify before revealing.** The taker only broadcasts its redeem (which exposes the secret) after `verifyMakerContract` + `verifyFundedOutput` pass on the maker's confirmed contract. The maker only locks after the same checks pass on the taker's contract.
4. **Watch your refund deadline.** Once a swap stalls, the owner must broadcast the refund before/after the appropriate timelock; persist swap state and prompt for it.

## Modules

| File | Responsibility |
|------|----------------|
| `src/networks.js` | tBTC / tLTC chain params, coin registry, supported pairs |
| `src/crypto.js` | sha256, hash160, secret/hash, pubkey, hex/byte helpers, dust |
| `src/htlc.js` | build / parse / **verify** the HTLC contract script |
| `src/tx.js` | redeem / refund / funding tx builders, **secret extraction** |
| `src/swap.js` | state machine, **timelock policy**, contract role mapping |
| `src/protocol.js` | taker↔maker message shapes + validation |

## Test

```sh
node --test          # zero deps, Node's built-in runner
```

Covers: contract determinism across chains, parse/verify (incl. tamper rejection), redeem reveals + secret round-trips out of the witness, refund sets the locktime, fee floor / dust rejection, timelock ordering, role mapping, and protocol validation. A live testnet round-trip harness lives in [swap-maker](../swap-maker) / the project tools.

## License

AGPL-3.0-or-later. © 2026 Tech1k.

Vendored third-party code under `vendor/` keeps its own licenses (`@scure`, `@noble`: MIT).
