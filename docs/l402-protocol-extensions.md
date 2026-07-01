# Metered Inference over L402: Protocol Extensions

Status: design exploration
Related: [`l402-walletdk-inference-payments.md`](./l402-walletdk-inference-payments.md)
Upstream spec: <https://github.com/lightninglabs/L402/blob/master/protocol-specification.md>

## 1. Problem

L402 today is **one invoice → one preimage → one macaroon, reused until
revoked**. There is no in-band balance, no decrement, no "buy N units," and it
is **BOLT11-only** (verified against the spec + `macaroon-spec.md`). Every
(re)authorization is a synchronous `402` round-trip.

That is a poor fit for **LLM inference**, which is:
- **metered in tokens**, priced per ~1M tokens,
- **high-frequency** (many calls per session),
- **latency-sensitive** on the buyer side — and in our stack the payment itself
  is *slow*, because walletdk pays via an **Ark↔Lightning swap** that takes
  seconds. A synchronous invoice round-trip on every call would stall each turn.

What we want is closer to a **payment channel / data channel for inference**:
buy tokens in **blocks** (100k / 1M), **draw down** as consumed, **top up**
before exhaustion, and keep the payment flow **off the request's critical path**.
It does **not** need real-time per-token settlement.

## 2. What L402 gives us to build on

From the current spec (citations to the L402 repo):

- **First-party constraint caveats** — `<service>_<constraint>=value`, attenuated
  without the root key (`macaroon-spec.md` "Attenuation"). This is the primary
  extension surface.
- **Skip-unknown-caveats rule** — "If no satisfier is registered for a caveat's
  condition, the caveat MUST be skipped (not rejected)" (`macaroon-spec.md`
  Verification Step 3). This is the forward-compatibility guarantee that lets us
  ship new caveats without breaking existing verifiers.
- **Stable `token_id` / `user_id`** — 32 random bytes in the identifier, kept
  stable across macaroon rotations for exactly "service level metering"
  (`docs/macaroons.md`). This is our server-side metering key.
- **Identifier `version` (uint16)** — the explicit knob for a new identifier
  layout (currently 0).
- **Constraint precedent** — `_monthly_volume_sats`, `_valid_until` are existing
  numeric/expiry constraints with satisfiers; our token-budget caveats mirror
  them.
- **Dual-scheme rollout precedent** — LSAT→L402 shipped both scheme names during
  migration (§10); new versions can roll out the same way.

Two hard limits to respect:
1. **Caveats only attenuate.** You cannot *raise* a numeric caveat on an existing
   macaroon. "Increasing a budget" therefore means **re-mint** (revoke + reissue
   under the same `token_id`) — which the spec already does for tier upgrades — or
   track balance **server-side** keyed by `token_id` and use the caveat only as a
   ceiling.
2. **No keysend / AMP / hold-invoice / onion-TLV anywhere in L402 today.** Any
   streaming-payment machinery is net-new.

## 3. Design axes

| Axis | Options |
|---|---|
| Timing | prepaid (buy block, draw down) vs postpaid (settle after) |
| Sync | inline `402` on the request vs out-of-band top-up channel |
| Granularity | per-request · per-100k · per-1M · continuous |
| Trust | who can cheat on the token count (server over-meters / client under-pays) |
| LN primitive | BOLT11 invoice · hold invoice · keysend+TLV · AMP · BOLT12 offer |
| Wallet-payable **today** | walletdk swap-pays **BOLT11 only** — everything else is future wallet capability |

The last row is the sharpest constraint: **only BOLT11-invoice designs work with
walletdk now.** keysend/AMP/BOLT12 require the wallet/swap layer to gain
spontaneous-payment or offer support, so they are endgame, not v1.

## 4. Layered proposal (near → far)

### Layer 0 — Metered credit via new caveats + balance headers (BOLT11, deployable now)

Extend the challenge with machine-readable pricing and block size (new params,
ignored by legacy clients):

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="…", invoice="…",
    inference_model="glm-4.5",
    price_per_1m_tokens_msat="2500000",
    block_tokens="1000000"
```

New first-party caveats committed to the macaroon at mint:

- `inference_token_budget=1000000` — tokens purchased in this credential (a
  ceiling; see re-mint note).
- `inference_model=glm-4.5` — model scope (a Services-style satisfier).
- `inference_valid_until=<unix>` — reuse the existing timeout satisfier pattern.

Server meters consumption keyed by `token_id`, decrementing against the budget.
It knows the true token count from the model response `usage` field.

**Balance feedback on every 200** so the client can top up *before* it hits zero:

```
X-L402-Tokens-Remaining: 240000
X-L402-Tokens-Used: 760000
X-L402-Usage-Receipt: <base64 signed {token_id, used, remaining, ts}>
```

**Draw-down / top-up state machine:**
1. Buy a block → macaroon with `inference_token_budget=N`.
2. Each call decrements server-side; response echoes remaining.
3. On exhaustion, the server returns **401** (credential exhausted — matching the
   spec's "any credential present → 401, not 402" rule) with a fresh challenge,
   or the client proactively re-buys.
4. Re-buy = a new invoice for another block; server re-mints (or credits the
   ledger) under the **same `token_id`** so metering history is continuous.

This is the concrete **"buy per 1M tokens"** mechanism, payable by walletdk today.

**Trust:** the count is server-side, so a server could over-meter. Mitigations:
the signed `X-L402-Usage-Receipt` gives the client an audit trail; the client
independently knows prompt+completion tokens from the API `usage` and can
reconcile / dispute. Full trust-minimization is Layer 3.

### Layer 1 — Move payment off the request path (async top-up, BOLT11, deployable now)

Even with blocks, a block that empties mid-turn triggers an inline `402` that
stalls the turn while the **Ark↔LN swap (seconds)** settles. Fix: a background
**top-up loop** keeps the balance above a floor.

- A dedicated `POST /topup` route (still BOLT11) the client calls **ahead of
  exhaustion**, driven by the `X-L402-Tokens-Remaining` header.
- The buyer runs it as a background task, not on the inference call path — so the
  swap latency is hidden. This is the first genuinely "channel-like" step: a
  side payment flow feeding a server credit ledger keyed by `token_id`, while
  inference streams over HTTP uninterrupted.
- Pure client behavior + server ledger; no new LN features. **Recommended first
  milestone beyond Layer 0.**

### Layer 2 — keysend + onion TLV: a true streaming payment channel (future wallet capability)

The endgame "payments channel alongside the data channel":

- **keysend / spontaneous payment**: pay with **no invoice**; the sender picks the
  preimage and carries app data in **custom odd onion TLV records** (the keysend
  preimage record `5482373484`, plus a custom record for our payload) — the
  "extra payloads in the onion" idea.
- Client streams keysend micropayments to the proxy's node, each TLV carrying
  `{ token_id, session_id, units }`. The server credits the ledger on HTLC
  settle. Inference flows over HTTP authenticated by the macaroon (bound to the
  session); **payment is fully async** — no `402`, no per-call round-trip.
- **AMP** lets many spontaneous top-ups reuse one credential, each deriving a
  unique payment hash/preimage from the AMP root, and helps large multipath
  top-ups.
- **Proof-model shift:** with keysend the preimage is sender-chosen, so it is not
  proof of paying a *server* invoice. Authorization moves to the macaroon; the
  TLV `token_id` attributes the payment. This motivates **identifier version 1**
  carrying a `session_pubkey` the client signs top-up messages with, binding
  async payments to the credential.
- **Constraint:** keysend/AMP are **not payable through the current Ark↔LN swap**
  (a swap targets one BOLT11 hash). Requires walletdk to gain spontaneous-payment
  support or a direct LN channel. **Future.**

### Layer 3 — hold-invoice escrow for trust-minimized batches (BOLT11-shaped, wallet caveat)

To fix Layer 0's "pay into a server-side counter" trust gap:

- Client pays a **hold invoice** for a 1M-token block; the server **holds** the
  HTLC while it streams inference and **settles only after delivery** (revealing
  the preimage), or cancels on failure. The buyer's funds aren't captured until
  service is delivered.
- Granularity via a pipeline of small hold invoices (per 100k), each settled as
  its block is delivered, remainder cancelled — approximating streaming with
  all-or-nothing HTLCs.
- **Payer compatibility:** paying a hold invoice is just paying a BOLT11 invoice,
  so the swap *can* pay it — **but** the Ark VHTLC has its own timeout, and a
  hold invoice may be held longer than the swap is willing to wait. The
  **hold-duration vs VHTLC-expiry interaction is a real constraint** to model
  before relying on this.

### Layer 4 — BOLT12 offers for recurring top-ups (future wallet capability)

The proxy publishes a **BOLT12 offer**; the client fetches a fresh invoice per
top-up (per 1M) from that one offer — one offer, many payments, no per-request
challenge. Natural fit for "keep this session funded." Requires BOLT12 support in
the wallet/swap path. **Future.**

## 5. Recommendation & mapping

| Layer | LN primitive | Buys | Payment sync | Trust | walletdk-payable now? | When |
|---|---|---|---|---|---|---|
| 0 Metered credit + headers | BOLT11 | block (1M) | inline `402` on refill | server-counted | ✅ | now |
| 1 Async top-up loop | BOLT11 | block, pre-funded | off critical path | server-counted | ✅ | next |
| 3 Hold-invoice escrow | hold invoice | block, on delivery | inline/batch | delivery-gated | ⚠️ swap timeout risk | after |
| 2 keysend + TLV channel | keysend / AMP | continuous | fully async | macaroon-bound | ❌ needs wallet support | endgame |
| 4 BOLT12 top-ups | BOLT12 offer | block, recurring | async | server-counted | ❌ needs wallet support | endgame |

**Recommended path:** ship **Layer 0 + Layer 1** on BOLT11 (deployable with
walletdk today — "buy 1M tokens, top up in the background"), add **Layer 3** for
trust-minimization, and treat **Layer 2 / Layer 4** as the native-protocol
endgame once the wallet gains spontaneous-payment / BOLT12 support.

## 6. Concrete additions to propose upstream to L402

All gated by the skip-unknown-caveats rule, so they deploy incrementally:

1. **Challenge params:** `inference_model`, `price_per_1m_tokens_msat`,
   `block_tokens` on the `WWW-Authenticate: L402` line.
2. **Caveat conditions + satisfiers:** `inference_token_budget` (numeric,
   increasingly-restrictive), `inference_model` (set/subset), `inference_valid_until`
   (timeout).
3. **Response headers:** `X-L402-Tokens-Remaining`, `X-L402-Tokens-Used`,
   `X-L402-Usage-Receipt` (server-signed usage receipt for client reconciliation).
4. **Top-up semantics section:** re-mint-under-stable-`token_id` vs server-ledger
   models, and the attenuation rule that forbids raising a caveat in place.
5. **Identifier version 1 (optional):** add a `session_pubkey` field to authorize
   async / keysend top-ups, and document "credit" semantics.
6. **keysend TLV record:** a custom odd record type carrying
   `{ token_id, session_id, units }` for the Layer 2 channel.

## 7. Open questions

- **Verifiable metering.** Can the server *prove* the token count (tie to output
  length, signed receipts, a dispute path)? Layer 0 is trust-me; Layer 3 gates on
  delivery but still trusts the count.
- **Swap latency vs hold timeouts.** Ark VHTLC expiry vs hold-invoice duration
  (Layer 3); swap seconds vs turn latency (Layer 1 mitigation).
- **Refunds.** Unused prepaid balance at session end (Layer 0/1) — refund via a
  reverse payment, or forfeit?
- **Privacy.** keysend reveals the sender node; the `token_id` links a user's
  usage across calls. What linkage is acceptable?
- **Standardize vs profile.** Push these into L402 proper, or keep an "L402
  inference profile" that layers on top?
