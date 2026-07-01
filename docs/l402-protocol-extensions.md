# Furthering L402 for Metered Inference

Status: design exploration
Related: [`l402-walletdk-inference-payments.md`](./l402-walletdk-inference-payments.md)
Compared against: the **Machine Payment Protocol** (MPP) — the `Payment`
HTTP-auth scheme and its `session` intent ([`draft-lightning-session-00`](https://datatracker.ietf.org/doc/draft-lightning-session/), Lightspark)

## 0. Premise

The goal is to **further L402**, not to replace it. L402's two primitives — the
**macaroon** (an attenuatable, offline-verifiable authorization credential) and
the **payment preimage** (the atomic proof of settlement) — are the right
foundation. What L402 lacks is an *economic model* for metered, streaming
services like LLM inference, where per-request cost is unknown upfront and a full
Lightning round-trip per call is too slow.

MPP's `session` intent solves that economic model well (prepaid deposit → per-unit
draw-down → top-up → refund-on-close, streaming-native). But it does so by
**throwing away the macaroon** and using the deposit preimage directly as a
bearer token. We take the opposite path: **keep the macaroon and the preimage,
and bring the session economics into L402.**

An earlier draft of this doc got two things wrong, now corrected:
- It framed "preimage as a re-sent secret" as a weakness. It is not — see §1.
- It proposed adopting MPP wholesale. We are extending L402 instead — see §3.

## 1. L402's atomic core (what we must preserve)

The macaroon identifier commits to a payment hash `H`. The service mints the
macaroon alongside an invoice for `H`; paying the invoice reveals the preimage
`r` with `sha256(r) = H`; the client presents `macaroon:r`, and the server checks
`sha256(r) = H` against the `H` baked into the macaroon.

The consequence is L402's defining invariant:

> **A valid credential cannot exist without settlement, and settlement reveals
> exactly the secret that validates the credential.**

This is not incidental — it *is* how Lightning works, and it is the whole reason
L402 is trustless in-band. The preimage being "a secret you re-send" is a feature:
it is the same secret that proves you paid. Any extension **MUST preserve this
atomic binding.** We keep it.

### The one real shift metering forces

Prepaid metering unavoidably relaxes atomicity from **per-request** to
**per-deposit**. In classic L402, one payment ↔ one credential ↔ (effectively)
one unit of access. In a session, one *deposit* payment anchors many subsequent
requests drawn down *on credit*. The deposit and each top-up remain atomically
proven by their preimages; the individual metered requests are not.

That relaxation is the point of prepaid metering, but it opens an accountability
gap: the server now counts consumption unilaterally. §2.1 closes that gap. This
is the crux of furthering L402 for streaming — **anchor value with preimages as
today, and make the now-trusted draw-down verifiable.**

## 2. What to add to L402 (and where MPP informs us)

### 2.1 Verifiable metering — the necessary complement to per-deposit atomicity

Because draw-down is no longer atomic with payment, the server's `spent` counter
is trusted. MPP leaves this trusted (its `payment-receipt` SSE event is
informational). We can do better, and we should, precisely because we gave up
per-request atomicity:

- The server signs a **monotonic usage receipt** `{session_id, seq,
  cumulative_spent, cumulative_units, ts}` under a published key, per chunk or on
  a periodic tick.
- The client verifies monotonicity and retains the chain as non-repudiable
  evidence of what it was charged for.

Signed receipts restore accountability for the credit-based portion of the flow
that the preimage no longer covers. This is not a critique of MPP so much as the
missing half of any prepaid meter.

### 2.2 Optional proof-of-possession for the session lifetime (hardening, not replacement)

The preimage stays the atomic proof-of-payment. The *only* new exposure metering
introduces is that the deposit preimage is presented on **many** requests over a
long-lived session, not once. As optional defense-in-depth — and to authorize
async top-ups without re-revealing the deposit preimage on a side channel — the
macaroon can carry a caveat committing to a client **session public key**
registered at open; steady-state requests add a short signature over
`(challenge, request_digest, seq)`.

This does not replace the preimage — it rides alongside it as an attenuation
caveat, exactly the kind of thing macaroons are for. It is opt-in via capability
negotiation (§2.5); wallets that just present `macaroon:preimage` keep working.
(The sign layer is a fine addition; it is simply not load-bearing for atomicity.)

### 2.3 Trust-minimized refund — where our stack beats BOLT11

On `close`, MPP has the server unilaterally compute `refund = deposit − spent`
and *best-effort* pay a client return invoice; a failed refund leaves the client
with no recourse. Plain BOLT11 cannot express anything better.

Our stack can: walletdk deposits via an **Ark VHTLC**, which already carries a
client refund/timeout branch. Shaping the deposit so unspent value is reclaimable
by the client's own key on a timeout turns the prepaid balance into real escrow
with a client exit, rather than an IOU. This is a concrete reason L402-on-Ark can
surpass a BOLT11-only session intent.

### 2.4 Separate the payment plane from the data plane

MPP's top-up is an inline HTTP `402`; the SSE stream stalls and is held open while
the client pays (seconds on an Ark↔LN swap). That welds payment latency to stream
liveness. The durable design separates the two planes — the classic internet move
(FTP control vs data, SIP vs RTP): the HTTP data stream only reads a balance, and
top-ups flow on an **independent asynchronous payment channel** (§4). The preimage
still anchors each top-up; it just does so off the request path.

### 2.5 Capability negotiation + structured, macaroon-bound payloads

Two extensibility upgrades, both L402-native:

- **Negotiate capabilities** in the challenge: supported top-up rails
  (`bolt11`, `bolt12`, `keysend`), whether PoP and signed receipts are offered,
  pricing granularity. Client selects; both sides evolve independently.
- **Carry a structured JSON session descriptor, bound to the macaroon.** MPP's
  best idea is the structured `base64url(JCS-JSON)` payload instead of ad-hoc
  headers. We adopt the *encoding* but keep macaroon integrity: put the JSON
  descriptor (pricing, model, unit type, session params) in the challenge, and
  commit the macaroon to it with a caveat `session_descriptor_sha256=<hash>`. The
  macaroon stays the authenticated, attenuatable credential; the JSON gives us a
  versioned, forward-compatible ("ignore unknown fields") extension surface
  without smearing app semantics across HTTP headers.

Note the macaroon is already the "opaque server-issued token" MPP has to
reconstruct by echoing challenge params — L402 gets that right for free; the
client presents the macaroon verbatim and never rebuilds server state.

### 2.6 Normative schemas + test vectors

MPP's own example decodes `currency:"BTC"` while its prose mandates `"sat"` —
prose-defined wire formats drift. Ship normative JSON Schemas and canonical test
vectors (challenge, each caveat/action, receipt, signature inputs) with the L402
extension so the format is machine-checkable.

## 3. Why keep the macaroon (vs MPP's bearer preimage)

MPP drops the macaroon and authenticates with the raw preimage. That is simpler,
but it forfeits exactly what makes L402 worth furthering:

- **Attenuation.** Caveats let a holder narrow a credential (scope to a model, a
  budget, an expiry) without the root key — impossible with a bare preimage.
- **Delegation.** A funded session credential can be handed to a sub-agent with
  tightened caveats. This matters for agentic/multi-agent inference.
- **Offline, stateless verification.** The macaroon's HMAC chain verifies against
  a root key without a per-request DB round-trip for authorization.
- **A home for extensions.** Session descriptor binding (§2.5), PoP keys (§2.2),
  and future third-party caveats all live as caveats — a single, versioned
  extension vehicle. MPP has to grow new JSON fields; L402 grows caveats *and* can
  bind JSON.

So the macaroon is not legacy baggage — it is the extensibility substrate. We keep
it and let the preimage do what it does best: atomically anchor each payment.

## 4. The network payment plane: BOLT12

Separating the payment plane (§2.4) needs somewhere for payments to live off the
HTTP path. **BOLT12** is that substrate:

- A **BOLT12 offer is a stable, reusable payment endpoint** — the service's
  network-level payment address. No per-top-up invoice round-trip over HTTP.
- `invoice_request` carries a **payer payload** (`invreq_payer_note` / custom
  onion TLV), so a top-up natively carries `{session_id, units}` at the Lightning
  layer.
- One offer serves many top-ups; each still yields a preimage that atomically
  proves that increment and binds to the session.

Mature shape: **HTTP is the data plane** (stream tokens, read balance, present
`macaroon` + optional PoP); **BOLT12 is the payment plane** (offer = endpoint,
top-ups = invoice_requests tagged with the session). keysend + AMP are the
alternative async rail; inline BOLT11 `402` top-up is the fallback for BOLT11-only
wallets — which is where walletdk starts.

## 5. Rollout, grounded in what walletdk can pay

| Phase | What | Rail | Wallet-payable now? |
|---|---|---|---|
| 0 | L402 session extension: deposit-anchored macaroon + draw-down + top-up + refund, structured descriptor caveat | BOLT11 | ✅ |
| 1 | Signed usage receipts + optional PoP caveat (§2.1, §2.2) — pure extension, both endpoints ours | BOLT11 | ✅ |
| 2 | VHTLC-native deposit with client refund branch (§2.3) | Ark VHTLC | ⚠️ deposit-shape work in walletdk |
| 3 | BOLT12 payment plane, control/data separation (§2.4, §4) | BOLT12 / keysend | ❌ needs wallet BOLT12/spontaneous |

Phase 0 keeps L402's atomic core intact and adds the session economics on BOLT11
(payable today). Phases 1–2 are our differentiators over MPP and need no new
Lightning features — a signing key (proxy), an optional session key (client), and
Ark deposit shaping. Phase 3 is the endgame once the wallet speaks BOLT12.

## 6. Concrete L402 additions (sketch)

**New caveats** (the extension surface, verified by satisfiers; unknown caveats
are skipped per the L402 rule, so this is incrementally deployable):
- `inference_session_id=<token_id>` — the metering key (reuses L402's stable
  `token_id`).
- `inference_token_budget=<n>` — purchased units (a ceiling; raising it means
  re-mint under the same `token_id`, as L402 already does for tier upgrades).
- `inference_model=<id>` — model scope.
- `session_descriptor_sha256=<hash>` — binds the structured JSON descriptor.
- `session_pubkey=<hex>` — optional PoP key (§2.2).
- `inference_valid_until=<unix>` — reuse the timeout satisfier.

**Credential presentation:** `L402 <macaroon>:<preimage>` unchanged for the
atomic anchor; steady-state metered requests additionally carry the JSON payload
(action, seq, optional PoP signature) and, on settlement, receive a signed
receipt (§2.1).

## 7. Open questions

- **Receipt disputes.** What a signed-receipt discrepancy entitles the client to
  (refund branch, reputation, evidence) — signatures make cheating provable, but
  the remedy is a policy question.
- **VHTLC refund vs draw-down.** Reconciling an on-timeout client refund with the
  server's mid-session spend; Ark expiry vs long sessions.
- **BOLT12 payload + privacy.** How much session context fits in
  `invoice_request`/onion TLV, and the linkability of tagging payments with a
  session.
- **Standardization.** Push these as L402 extensions (new caveats, session
  descriptor binding), and align the descriptor JSON with MPP's schema where it
  helps interop — without giving up the macaroon.
