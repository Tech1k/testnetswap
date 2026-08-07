# swap-relay

The message bus for the [TestnetSwap](https://testnetswap.com) network. It routes line-delimited JSON between browser/CLI **takers** and the **makers** they choose, and keeps a directory of the makers currently online. It holds no keys and no funds, never sees a private key, and never inspects swap semantics. A fully compromised relay can disrupt or censor messages, but it cannot take anyone's coins; that is guaranteed by the on-chain HTLC (and, for Monero, the adaptor), not by trusting the relay.

Part of the testnet tooling family alongside CypherFaucet, TestnetPool, and TestnetWallet. AGPL-3.0-or-later.

See [NETWORK.md](../NETWORK.md) for the full multi-maker protocol spec.

## What it does

The relay is a `{sid, msg}` message pipe plus a maker directory:

- Multiple makers can be connected at once, each identified by an ed25519 `maker_id`.
- Takers pick a maker, and the relay routes their messages to exactly that maker.
- `GET /roster` lists the makers currently online so a client can discover them.

It has no notion of a swap. It forwards opaque messages and enforces payload, rate, and connection caps.

## Maker identity and registration

A maker's identity is an ed25519 keypair derived from its seed; `maker_id` is the hex of the public key (64 hex chars). Ownership is proven per connection, so there is no shared password to leak and no one can register under someone else's id.

On connect the relay issues a fresh per-socket challenge:

```
maker → relay : WS connect ?role=maker
relay → maker : { type:'_relay_challenge', relay_id, nonce, expiry, v:1 }
maker → relay : { type:'maker_register', maker_id, sig, info }
                sig = ed25519_sign(priv, "testnetswap-relay-maker|v1|"+relay_id+"|"+nonce+"|"+expiry)
relay → maker : { type:'_relay_hello', role:'maker', maker_id }   # on success
```

The signed string is domain-separated, relay-bound (`relay_id`), and time-bound (`expiry`), so a signature captured at one relay can't be replayed at another or reused after it expires. The relay verifies ed25519 natively via `node:crypto`; there is no swap-core dependency.

**Registration is permissioned by default.** With `openRegistration: false` (the default), only `maker_id`s listed in `allowedMakers` may register; an empty allow-list means no maker can register, a deliberate fail-closed default. Set `openRegistration: true` to let any valid ed25519 identity join ("be your own maker").

Once registered, a maker sends a `maker_announce` heartbeat every ~20s carrying its self-reported `info` (pairs, rates, liquidity, version). The relay validates every field before storing it, attributes the announce to the authenticated socket rather than to any `maker_id` in the payload, and prunes any maker that goes quiet for longer than `makerStaleMs`.

## Taker routing

```
taker → relay : WS connect ?role=taker&maker=<maker_id>
relay → taker : { type:'_relay_hello', role:'taker', sid, maker_id, maker_online }
taker → relay : <swap-core msg>          → relay → maker : { sid, msg }
maker → relay : { sid, msg }             → relay → taker : msg
```

- Each taker gets a random `sid` and is bound to one maker for the session.
- A maker can only reach its own takers: when a maker sends `{sid,msg}`, the relay drops it unless that `sid` belongs to that maker. One maker can never inject into another's swap.
- No `?maker` routes to `defaultMaker` (the operator's, for legacy single-maker clients). With neither a chosen maker nor a connected default, the taker gets `{ type:'error', reason:'maker offline' }`.
- When a taker disconnects, its maker is told (`_taker_gone`) so it can release any reservation.

## Discovery

```
GET /roster → { ok:true, makers:[ { maker_id, info, connected, connected_since,
                                    last_seen, default, vouched } ],
                default_maker, generated_at }
GET /health → { ok:true, makers:<n>, takers:<n> }
```

`connected_since` and `last_seen` are relay-observed, not fakeable: the trustworthy uptime signal. Everything under `info` is self-reported by the maker and treated as advertising, not truth; the site labels it that way. `vouched` is an operator-set trust label sourced only from the relay config, so a maker can never self-claim it. Responses are CORS-open, per-IP rate limited, and cached for `rosterCacheMs`. The endpoint exposes only makers' self-reported info plus relay-observed uptime, never taker sids or IPs.

## Safety notes

- Roster `info` is rendered into the same origin that stores takers' spend keys, so the relay schema-checks every field before storing it (ids match `^[0-9a-f]{64}$`, names are length- and charset-capped, numeric fields are bounded), and the site renders roster values with `textContent` only. Malformed or oversized input is dropped, never stored.
- **WSS/TLS is required for any public deployment.** The signature authenticates the handshake only; on plaintext `ws://` an on-path attacker could hijack the socket after auth. Browsers also can't open raw TCP or Tor sockets, so the public endpoint must be WSS. Terminate TLS at your reverse proxy and forward to the relay on loopback.

## Run

```sh
cp config.example.json config.json    # set relayId + your registration policy
npm install
node src/main.js -c config.json       # -> relay: ws+http://127.0.0.1:8910 (registration: permissioned; ...)
```

Put it behind a reverse proxy that terminates TLS (WSS) and forwards to `ws://127.0.0.1:8910`. See `deploy/` for a systemd unit and the reverse-proxy example, and [DEPLOY.md](../DEPLOY.md) for the full runbook.

## Config

Secrets belong in the environment, not `config.json`. `makerToken`, if used, reads from the `RELAY_MAKER_TOKEN` env var.

| key | meaning |
|-----|---------|
| `host`, `port` | bind address (front it with TLS); defaults `127.0.0.1:8910` |
| `relayId` | the relay's public identity, bound into each maker challenge to prevent cross-relay replay; set it to the relay's public hostname |
| `openRegistration` | `false` (default) = permissioned, only `allowedMakers` may register; `true` = any valid ed25519 identity may join |
| `allowedMakers` | list of `maker_id`s permitted when registration is not open |
| `defaultMaker` | `maker_id` a taker with no `?maker` is routed to (legacy compatibility) |
| `vouched` | operator trust labels `{ "<maker_id>": "<label>" }`, config-only; shows a badge on that maker in the UI |
| `makerToken` | optional extra gate for the `defaultMaker` only (prefer `RELAY_MAKER_TOKEN`); not needed for the ed25519 handshake |
| `maxTakers`, `maxMakers` | caps on concurrent takers and registered makers |
| `maxPendingMakers` | cap on challenged-but-unregistered maker sockets |
| `maxPerIp` | concurrent connections per IP (takers and makers) |
| `msgsPerMinPerConn`, `makerMsgsPerMin` | per-connection flood guards (makers get the higher cap) |
| `registerTimeoutMs` | a challenged maker must register within this or be dropped |
| `makerStaleMs` | prune a maker with no announce within this |
| `rosterCacheMs` | how long a `GET /roster` response is cached |
| `rosterRatePerMin` | per-IP `GET /roster` rate limit |
| `maxPayloadBytes` | hard per-message cap (default 64 KB) |
| `maxNameLen` | max maker display-name length stored from `info` |
| `heartbeatMs` | ping/pong interval to drop dead sockets |
| `trustProxyHops` | trusted reverse-proxy hops for client-IP extraction; `1` for a single proxy, `2` behind a CDN, `0` only if the relay is exposed directly |

## License

AGPL-3.0-or-later. © 2026 Tech1k.
