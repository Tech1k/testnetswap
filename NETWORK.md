# TestnetSwap network: multi-maker protocol (spec)

Turns the single-operator maker into an open network: anyone can run a maker, register it
with the relay, be discovered on a dashboard, and takers can swap through any of them via the
same UI. "Be your own maker."

## Why it's safe to let strangers be makers
The swap is non-custodial and atomic, so a hostile maker can't steal your principal. The worst it
can do is stall, after which you refund (HTLC) or reclaim (adaptor). The taker verifies the maker's
on-chain lock against its own independent explorer (mempool.space for tBTC), enforces `T1 > T2` with
the fixed upper-bound caps, and fails closed on any contract mismatch. So the only residual risk from
a bad maker is griefing (wasted time, then a refund), not theft. That leaves the network layer a
narrow job: prevent impersonation, roster poisoning, cross-maker message injection, and DoS. None of
those can cost a taker coins, but each degrades the experience.

## Threat model
- Makers are UNTRUSTED (any of them may be malicious). Relay holds no funds/keys (unchanged).
- Adversary goals to deny: (a) register as another maker's identity (steal its reputation);
  (b) inject messages into a swap between a taker and a *different* maker; (c) flood the roster
  with fake makers; (d) exhaust relay resources; (e) replay a captured registration.

## Identity: maker_id is an ed25519 public key
A maker derives a stable ed25519 identity keypair from its seed (label `relay-identity`).
`maker_id = hex(ed25519 pubkey)` (64 hex). Ownership is proved by signing a relay challenge, so
no central token list is needed and no one can register under someone else's id. The relay
verifies ed25519 natively via `node:crypto` (no swap-core dependency).

## Registration handshake (maker ↔ relay)
```
maker  → relay : WS connect ?role=maker
relay  → maker : { type: '_relay_challenge', relay_id, nonce: <32-byte hex>, expiry, v:1 }   # per-connection
maker  → relay : { type: 'maker_register', maker_id, sig, info }
                 # sig = ed25519_sign(priv, "testnetswap-relay-maker|v1|"+relay_id+"|"+nonce+"|"+expiry)
                 #       domain-separated + RELAY-BOUND (relay_id) + TIME-BOUND (expiry): defeats cross-relay replay
relay  → maker : { type: '_relay_hello', role: 'maker', maker_id }         # on success
                 | { type: 'error', reason }  + close                       # on failure
```
Relay verifies: valid ed25519 sig over the exact challenge string with `maker_id` as the key, and
`expiry` not in the past. Replay is impossible: the nonce is fresh per connection (a sig for nonce
N can't satisfy nonce N'), and `relay_id` in the signed string stops a sig captured at one relay from
being replayed at another.
- **Permissioned by default** (`cfg.openRegistration: false`): only ids in `cfg.allowedMakers:
  [maker_id,...]` may register. An empty allowlist in permissioned mode means **no maker can
  register** (a deliberate fail-closed default); set `openRegistration: true` to let any valid
  ed25519 identity in.
- **Reconnect / takeover:** if `maker_id` already has an OPEN socket, reject the new one
  ("maker already connected"); if the existing socket is closed/stale, replace it.

## Announce / heartbeat (keeps the roster fresh)
```
maker → relay : { type: 'maker_announce', info }   # every ~20s; updates roster info + last_seen
```
`info` mirrors the maker's own /api/status: `{ name?, pairs:[{from,to,rate,min_sats,max_sats,
liquidity_free_sats,liquidity_unit}], xmr:{enabled,networks,tickers,...}, stats:{completed, refunded,
failed, success_rate}, version }`. Everything in `info` is self-reported (a maker can lie about rates,
liquidity, or stats), so the relay treats it as advertising, not truth. The site labels it as such.

## Taker addressing + routing
```
taker → relay : WS connect ?role=taker&maker=<maker_id>
relay → taker : { type: '_relay_hello', role:'taker', sid, maker_online }
taker → relay : <swap-core msg>                → relay → maker(maker_id) : { sid, msg }
maker → relay : { sid, msg }                   → relay → taker(sid)      : msg
```
- Relay binds `sid → { ws, makerId }`. A taker session is bound to ONE maker for its lifetime.
- **Cross-maker injection guard:** when a maker sends `{sid,msg}`, the relay drops it unless
  `takers.get(sid).makerId === thisMakerId`. So maker A can never reach maker B's takers.
- `?maker` absent ⇒ route to `cfg.defaultMaker` (the operator's id) if set, which preserves the
  current single-maker clients; otherwise `{ type:'error', reason:'no maker selected' }`.
- Maker offline ⇒ `{ type:'error', reason:'maker offline' }` (unchanged behavior).

## Discovery: roster over HTTP
The relay runs a tiny HTTP endpoint (same server as the WS upgrade), CORS-open, read-only:
```
GET /roster → { ok:true, makers:[ { maker_id, info, connected:true, connected_since,
                                     last_seen, default, vouched } ],
                default_maker, generated_at }
GET /health → { ok:true, makers: <n>, takers: <n> }
```
`connected_since` / `last_seen` are relay-observed (not fakeable), the trustworthy uptime
signal; `info.stats` is self-reported. `default` marks the operator's fallback maker; `vouched`
is an operator-set trust label (`null` unless the operator listed this `maker_id` in the relay's
`vouched` config); **config-only, a maker can never self-claim it**. The site fetches `/roster`,
renders the dashboard, and seeds the swap widget's maker selector.

## Reputation (v1: transparent, minimal)
Show, per maker: relay-observed uptime (connected_since, not fakeable), advertised rate/liquidity
(verified by the taker at quote and before funding, never trusted from the roster), and
self-reported swap outcomes as NEUTRAL counts (completed, safely refunded, unfinished), **clearly
labeled self-reported**. A raw completion percentage is labeled "completion rate", NOT a maker
success or trust score: most non-completions are taker-side (never funded, closed the tab) or chain
timing, and a refund is a safe outcome (the recovery path working), not a maker failure. No
scoring/ranking beyond sorting by uptime + liquidity. Anti-Sybil is deferred: on testnet the coins
are worthless, so a spam maker only wastes its own time; the caps below bound resource abuse.

### Future: an attributable maker-reliability signal (post-launch)
A completion rate blends faults the maker cannot control with the few it can, so it must never
auto-punish. A real reliability signal measures ONLY cryptographically-attributable maker faults:
the taker did its part on time and the maker did not. Classify each terminal swap by on-chain
evidence against the protocol deadlines:
```
taker never funded T1                                -> taker-side (not attributable)
taker funded on time, maker never locked a valid T2  -> MAKER FAULT
both locked, taker never claimed                     -> taker-side (not attributable)
either side refunded after its timelock              -> safe outcome (not a fault)
invalid / mismatched maker contract                  -> MAKER FAULT
relay / chain / RPC error                            -> environment (not a fault)
```
Instrumentation: extend the swap state machine to record, per terminal swap, `taker_funded_ontime`
and `maker_locked_valid_before_deadline` (both booleans, both cryptographically observable). The
signal is their ratio, shown as EVIDENCE and never an automatic penalty, e.g. "18 of 19 eligible
funded swaps received a valid counter-lock" ("eligible" = the taker funded correctly and on time,
so the maker was obligated to act). Deferred on purpose: it needs a corpus of swaps and a real
multi-maker network to mean anything, and it touches the fund-critical path.

## DoS / abuse mitigations
- `maxMakers` cap on concurrent registered makers (e.g. 64); reject beyond it.
- Per-IP registration rate limit + the existing `maxPerIp` on taker connections.
- Prune makers with no `maker_announce` within `makerStaleMs` (e.g. 90s) → drop from roster.
- Registration must complete within a short window (e.g. 10s) after the challenge, else close.
- Per-connection message flood cap already applies (makers get a higher cap, as today).
- `maxPayloadBytes` unchanged.

## Backward compatibility
- The operator's maker migrates to the identity model (derives its keypair, registers, announces)
  and is advertised as `cfg.defaultMaker`, so takers with no `?maker` still reach it.
- The legacy `makerToken` becomes optional: if set, it's an additional gate for the operator's own
  maker; open registration uses the signature scheme.

## Security requirements (mandatory)
One path could otherwise break the "griefing-only" claim, alongside several DoS and secure-default
gaps. These requirements close them; the implementation MUST honor all of them.

1. **XSS trust boundary (critical).** Roster `info` comes from untrusted strangers and is rendered
   into the SAME origin that stores takers' spend keys (localStorage `testnetswap.swaps.v1`,
   `testnetswap_xmr_recovery`). Two mandatory controls, defense-in-depth on top of the existing CSP:
   - **Relay input validation:** every `info` field is schema-checked before storing. `maker_id`
     must match `^[0-9a-f]{64}$`. `name` ≤ 40 chars, restricted charset `[\w .\-]` (no `<>&"'/`).
     `pairs` a fixed numeric/enum schema (from/to are tickers; sats are non-neg integers).
     Anything malformed/oversized is rejected or dropped, never stored.
   - **Site output encoding:** the dashboard + selector render EVERY roster field with `textContent`
     only. The `html:`/`innerHTML` helper is forbidden for any roster-derived value.
2. **Secure default: open registration is OPT-IN.** `cfg.openRegistration` defaults to **false**
   (permissioned: only `cfg.allowedMakers` may register; with the operator's maker allowlisted).
   An upgrade must NOT silently turn a closed relay into an open network. The operator sets
   `openRegistration: true` deliberately.
3. **Signature binding + freshness.** The signed string is domain-separated AND relay-bound and
   time-bound: `"testnetswap-relay-maker|v1|" + relayId + "|" + nonce + "|" + expiryUnix`, where
   `relayId` = `cfg.relayId` (e.g. the relay's public hostname) and the relay REJECTS if now >
   expiry (short, e.g. 30s). The relay verifies against the nonce IT issued and stored on that
   socket (never a client-supplied nonce). This defeats cross-relay / relay-in-the-middle
   signature relay. **WSS/TLS is REQUIRED**: the signature authenticates only the handshake; on
   plaintext `ws://` an on-path attacker could hijack the post-auth socket. Document TLS as
   mandatory for any real deployment.
4. **Announce authentication.** `maker_announce` is attributed to the authenticated socket
   (`ws._makerId` set at register), NOT to a `maker_id` in the payload, so a socket can only
   update its own roster entry.
5. **DoS caps.** Per-IP cap on maker connections (pending + registered), same `maxPerIp` family as
   takers. A challenged socket must send a valid `maker_register` within `registerTimeoutMs`
   (~10s) or be closed. Cap concurrent PENDING (challenged-but-unregistered) sockets globally.
   `maxMakers` stays but is protected by the per-IP cap so one IP can't fill it. Prune makers with
   no announce within `makerStaleMs` (~90s): free the slot AND close the socket.
6. **/roster endpoint hardening.** Per-IP rate limit, a cached response (regenerated on change or
   every few seconds, not per-request), and a bounded size (maxMakers × the validated-small info).
   CORS-open + `Cache-Control`. It exposes only makers' self-reported info + relay-observed
   uptime, never taker sids/IPs.
7. **Dashboard trust presentation.** Sort by **relay-observed uptime** (`connected_since`), never by
   self-reported liquidity/stats (gameable). Pin the operator's maker (`defaultMaker`) first and
   badge it. Always show the (unforgeable) `maker_id` next to the (decorative, unverified) `name`
   so a homograph/display-name spoof can't impersonate a reputable maker. Label all `info`-derived
   numbers "self-reported."
8. **CSP.** The site fetches `https://<relay-host>/roster`, a new connect target; add the relay's
   **https** origin to `/swap.html` (and the dashboard page) `connect-src` (today only the `wss://`
   origin is listed).
9. **Default routing.** `?maker` absent ⇒ route to `defaultMaker` if it's currently
   connected; else `{ type:'error', reason:'maker offline' }`. The site always sends `?maker` from
   the roster; the default is only a legacy fallback.
10. **XMR griefing bound (untrusted maker).** The taker MUST bound the maker-supplied
    `t1_blocks`/`t2_blocks` in the XMR quote before locking any tXMR (reject absurd values that
    would lock funds for an unreasonable time), the adaptor-swap analog of the HTLC `T1` cap.

### Known, documented limitations (not v1 blockers)
- **Reputation is relay-level, not swap-counterparty-bound.** `maker_id` authenticates to the RELAY
  (for routing + the roster); it is NOT tied to the maker's on-chain swap keys. So a maker's
  reputation is "relay-attested identity + self-reported stats," and the swap's SAFETY never
  depends on it (the taker independently verifies every on-chain lock regardless of which maker).
  Binding `maker_id` to the maker's swap pubkeys is a v2 enhancement.
- **tLTC verification** still uses the taker's configured (operator-run testnetscan) explorer, the
  accepted testnet tradeoff; tBTC uses independent mempool.space. Unchanged by multi-maker.
- **Mid-swap taker reconnection** (resume by sid) is unchanged/limited; keep the tab open.

## Be your own maker (quickstart)
Anyone can run a maker and join the network. The swap stays non-custodial regardless of who runs
the maker; a maker can only decline or stall a swap, never take a taker's coins (the taker verifies
every on-chain lock in their own browser). Steps:

1. **Get the daemon.** Clone the repo, `cd swap-maker && npm ci`, then `node src/main.js seed` to
   generate an HD seed (back it up; pool keys AND your maker identity both derive from it).
2. **Configure + fund.** `cp config.example.json config.json`, set `apis`/`rate`/`limits`/timelocks
   and `relay_url` (the network you're joining, e.g. `wss://relay.testnetswap.com/`). Run
   `node src/main.js fund` to claim CypherFaucet coins into the pool addresses.
3. **Print your identity.** `node src/main.js maker-id` prints your `maker_id`, the hex of an
   ed25519 public key derived deterministically from your seed. This is your unforgeable handle on
   the network (no one else can register it without your seed).
4. **Get listed.** Send your `maker_id` to the relay operator; they add it to `allowedMakers`
   (permissioned relays), or you connect directly if the relay runs `openRegistration: true`. No
   `relay_token` is needed to join; identity is proven by the ed25519 challenge. (`relay_token`
   only matters if you ARE the relay operator gating your own `defaultMaker`.)
5. **Run it.** `MAKER_SEED=<hex> node src/main.js -c config.json`. The daemon connects, signs the
   relay's challenge, registers, and announces its liquidity every ~20s. You now appear on
   `/network.html` and takers can route swaps to you via `?maker=<your-id>`.

**Run your OWN network** instead of joining one: deploy `swap-relay` (see [DEPLOY.md](DEPLOY.md)),
set `relayId` to your relay's hostname, add your maker to `allowedMakers` (or set
`openRegistration: true`), and point your site's `TESTNETSWAP_RELAY`/roster at it. Everything above
is self-hostable and AGPL-3.0.

## Out of scope (later phases)
Client-side quote aggregation (fan out to N makers, pick best); on-chain-verified reputation
(binding maker_id to swap keys); federated/gossip discovery (removing the central roster);
maker staking/bonding.
