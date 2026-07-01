# Metered Inference Payments: a Protocol Design

Status: design exploration
Related: [`l402-walletdk-inference-payments.md`](./l402-walletdk-inference-payments.md)
Prior art: L402 (macaroon) · [`draft-lightning-session-00`](https://datatracker.ietf.org/doc/draft-lightning-session/) (Lightspark) on the `Payment` HTTP-auth scheme ([`draft-ryan-httpauth-payment`](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/))

## 0. The reframing

An earlier version of this doc extended L402 by bolting bespoke fields onto HTTP
headers (`price_per_1m_tokens_msat`, `X-L402-Tokens-Remaining`, …). **That was
the wrong instinct.** Headers are a flat, weakly-typed, hard-to-version namespace;
smearing application semantics across them repeats the mistakes HTTP itself spent
two decades walking back.

The right move — and the direction the ecosystem is already taking — is to carry
**one structured, versioned, canonically-encoded JSON document** as the payment
credential, and keep HTTP headers as a thin envelope. The emerging `Payment` HTTP
authentication scheme and its `session` intent do exactly this:

- `WWW-Authenticate: Payment id=… method="lightning" intent="session" request="<base64url(JCS-JSON)>"`
- `Authorization: Payment <base64url(JCS-JSON credential)>`
- `Payment-Receipt: <base64url(JCS-JSON receipt)>`

where the JSON blobs carry all the semantics (`{action, preimage, returnInvoice, …}`),
canonicalized with JCS ([RFC 8785]) so they can be digested/signed, and
**"implementations MUST ignore unknown fields"** for forward-compatibility.

So this doc is now: **adopt the structured-payload model, and improve on the
`session` intent where it is architecturally weak.** Not a parallel L402 v2 — an
alignment with the standard plus a set of principled extensions we would
contribute upstream.

## 1. What the `session` intent gets right (adopt wholesale)

- **`method` × `intent` two-axis extensibility.** `lightning` × {`charge`,
  `session`, …}. Clean, negotiable, open-ended — far better than L402's
  "everything is a macaroon caveat."
- **Structured payload, not headers.** All app semantics live in the JCS-JSON
  blob. This is the core thing we were missing.
- **Prepaid deposit → per-unit draw-down → topUp → close-with-refund.** The right
  economic shape for token metering where per-request cost is unknown upfront.
- **Refund of unspent balance** via a client-supplied amountless return invoice.
- **Streaming-native:** SSE `payment-need-topup` / hold-connection / resume, and
  a per-chunk `amount`. Payment latency is hidden by holding the stream.
- **RFC 9457 problem+json** errors, **idempotency keyed by challenge id**, and
  **JCS canonicalization** for signable bytes.

We should implement this and interoperate with it. It is a good protocol.

## 2. Where it is weak — and how we do better

Read as an internet architect: the `session` intent optimizes for "ship a working
prepaid meter on BOLT11," and in doing so makes a handful of choices that a
protocol meant to last would not. Each is an opportunity.

### 2.1 The bearer preimage is a payment secret reused as an auth secret

The session draft uses the **deposit preimage directly as a bearer token**,
re-sent on every request, justified by "HMAC would require storing the preimage."

Two problems:
1. **Layering violation.** The preimage is the *Lightning payment layer's* proof.
   Overloading it as the *application auth layer's* long-lived credential couples
   the two: leak it (a TLS-terminating proxy, a log line, a compromised
   middlebox) and you lose payment proof *and* session control at once.
2. **Static replayable secret.** A bearer token on every request is precisely the
   web-auth anti-pattern OAuth spent a decade retreating from (bearer → DPoP /
   mTLS proof-of-possession).

**Our design: proof-of-possession, not bearer.** At `open`, the client registers
a **session public key** (freshly generated). Each subsequent request carries a
short signature over `(challenge_id, request_digest, seq)` — a DPoP-style proof.
The server stores only the *public* key. The preimage never leaves the client
after `open`; a captured request is not replayable and cannot drain the session.
The draft's stated objection ("server must store the preimage") is a false
tradeoff — you store a public key, not a secret. This is a *capability with
proof-of-possession* rather than a *bearer token*, the distinction the object-
capability and web-auth communities both converged on.

### 2.2 Metering is server-trusted, with no verifiable receipt

The session model trusts the server's `spent` counter absolutely. The
`payment-receipt` SSE event is informational — nothing stops a server from
over-counting tokens, and the client cannot prove it was cheated.

**Our design: signed, monotonic usage receipts.** The server signs a running
`{session_id, seq, cumulative_spent, cumulative_units, ts}` — either per chunk or
on a periodic tick — under a published key. The client verifies monotonicity and
retains the chain as non-repudiable evidence. Cheating becomes *detectable and
adjudicable* rather than a matter of trust. A protocol worth standardizing makes
misbehavior provable; the session draft leaves this as an open question, and we
should close it.

### 2.3 The refund is server goodwill

On `close`, the server unilaterally computes `refund = deposit − spent` and
*best-effort* pays the return invoice; `refundStatus:"failed"` leaves the client
with no recourse and no funds. The client trusts the server on both the count and
the payout.

**Our design: an HTLC/VHTLC-native deposit — and this is where our stack wins.**
walletdk deposits via an **Ark VHTLC**, which already has a client refund/timeout
branch. Structuring the deposit so unspent value is reclaimable by the client's
own key on a timeout (rather than paid back by server grace) removes the refund
trust entirely. Plain BOLT11 (the session draft's only rail) *cannot* express
this; our swap/HTLC-native wallet *can*. The prepaid-balance-with-refund model
becomes a genuine escrow with a client exit, not an IOU.

### 2.4 The payment flow is coupled to the data connection

topUp is still an HTTP `402` round-trip; the SSE stream *stalls and is held open*
while the client pays (seconds on an Ark↔LN swap). Clever, but it welds the
payment plane onto the data plane — the stream's liveness now depends on payment
latency, and the server must babysit a paused connection with in-flight upstream
state.

**Our design: separate the control/payment plane from the data plane** — the
classic internet move (FTP control vs data, SIP vs RTP, RTSP vs RTP). The data
stream reads a balance and never blocks; top-ups flow on an **independent
asynchronous payment channel** (Section 3). The HTTP side degrades to "is there
credit?" and the payment side runs entirely out of band. This is the user's
"payments channel alongside the data channel," made literal.

### 2.5 The client must echo the challenge params

The credential must carry `challenge = { id, realm, method, intent, request, expires }`
echoed verbatim from the server. Making the client faithfully reconstruct server
state is a reliable source of binding bugs.

**Our design: an opaque, server-authenticated challenge token.** The server issues
a single signed/MAC'd token; the client presents it back verbatim alongside its
proof, and never parses or reassembles it. "Don't make the client rebuild server
state" — the same reason cookies and macaroons are opaque to the bearer.

### 2.6 A fixed feature matrix, no negotiation

Whether streaming, invoice-topUp, or signed receipts are available is implicit.
An architecture that lasts negotiates capabilities (TLS extensions, HTTP content
negotiation) rather than hardcoding them.

**Our design: capability advertisement in the challenge.** The challenge payload
lists supported intents, top-up rails (`bolt11`, `bolt12`, `keysend`), whether
proof-of-possession and signed receipts are offered, and pricing granularity. The
client selects; both sides evolve independently.

### 2.7 Spec/example drift → normative schemas + test vectors

The draft's own example decodes `currency:"BTC"` while the prose mandates `"sat"`.
Small, but telling: prose-defined wire formats drift. We ship **normative JSON
Schemas and canonical test vectors** (challenge, each credential action, receipt,
signature inputs) as part of the spec — the IETF-quality practice the draft lacks.

## 3. The network plane: BOLT12 as the payment substrate (the Layer-4 point)

Decoupling payment from the data connection (2.4) needs a place for the payment
plane to *live*. **BOLT12 is that substrate**, and it is the network-level
communication system the earlier draft's "Layer 4" gestured at:

- **A BOLT12 offer is a stable, reusable payment endpoint** — effectively the
  service's network-level payment address. No per-session invoice issuance
  round-trip over HTTP; the offer *is* the address.
- **`invoice_request` carries a payer payload** (`invreq_payer_note` and custom
  onion TLV records), so a top-up can carry `{session_id, units}` natively at the
  Lightning layer — the "extra payloads in the onion" idea, standardized.
- **Recurrence / repeated fetch** against one offer gives many top-ups from one
  endpoint, no fresh challenge each time.

So the mature architecture is: **HTTP is the pure data plane** (stream tokens,
read balance, present proof-of-possession); **BOLT12 is the payment plane** (the
offer is the endpoint, top-ups are invoice_requests tagged with the session id).
keysend + AMP are the alternative async rail where BOLT12 isn't available. The
`session`/HTTP `402` topUp becomes the *fallback* rail for wallets that only speak
BOLT11 — which is where walletdk starts today.

## 4. Rollout, grounded in what walletdk can pay

| Phase | What | Rail | Wallet-payable now? |
|---|---|---|---|
| 0 | Implement the `session` intent as-is (interop with the standard) | BOLT11 | ✅ |
| 1 | Add proof-of-possession session key + signed usage receipts (2.1, 2.2) — pure extension, both endpoints ours | BOLT11 | ✅ |
| 2 | HTLC/VHTLC-native deposit with client refund branch (2.3) | Ark VHTLC | ⚠️ needs deposit-shape work in walletdk |
| 3 | BOLT12 payment plane, control/data separation (2.4, 3) | BOLT12 / keysend | ❌ needs wallet BOLT12/spontaneous support |

Phase 0 is interop and ships now. Phases 1–2 are our differentiators and need no
new Lightning features — just a session keypair (client) and a signing key
(proxy), plus shaping the Ark deposit. Phase 3 is the endgame once the wallet
gains BOLT12.

## 5. The `metered-inference` profile (concrete additions)

Rather than a new `method`, define our semantics as an **extension of the
`session` intent** (or a sibling `metered-inference` intent), all inside the JSON
payload so headers stay a thin envelope:

**Challenge payload** (server → client), superset of the session `request`:
```jsonc
{
  "intent": "session",
  "capabilities": { "topup": ["bolt11", "bolt12"], "pop": true, "receipts": "signed" },
  "pricing": { "unit": "token", "amount": "2", "currency": "sat", "granularity": 100000 },
  "model": { "id": "glm-4.5", "context": 128000 },     // app metadata in the blob, NOT headers
  "deposit": { "invoice": "lnbc…", "amountSat": "300", "paymentHash": "…" },
  "offer": "lno…",                                      // BOLT12 offer for async top-ups (phase 3)
  "challengeToken": "<opaque server-authenticated token>"  // client echoes verbatim (2.5)
}
```

**Credential payload** (client → server): `open` also registers `sessionPubKey`
and a `refundPath`; steady-state `invoke` replaces `bearer` and carries a
`pop` signature instead of the raw preimage:
```jsonc
{ "challengeToken": "…",
  "payload": { "action": "invoke", "sessionId": "…", "seq": 42,
               "pop": "<sig over (challengeToken, requestDigest, seq) by sessionPubKey>" } }
```

**Receipt** (server → client): the session receipt plus a signed running total:
```jsonc
{ "method": "lightning", "reference": "<sessionId>", "status": "success",
  "seq": 42, "cumulativeSpent": 202, "cumulativeUnits": 101,
  "sig": "<server signature over the above>" }
```

Everything model-, price-, and capability-specific lives in the JSON document and
is versioned by `intent` + `capabilities`, never in a header. New fields are
additive under the ignore-unknown rule.

## 6. Standardization posture

Engage the standard, don't fork it. Implement `Payment` + `session` for interop;
propose 2.1–2.7 upstream as **capability-negotiated extensions** to the session
intent (proof-of-possession, signed receipts, negotiated top-up rails, opaque
challenge token) and the HTLC-refund and BOLT12-plane work as new options. Ship
JSON Schemas + test vectors with the reference implementation (our Go proxy and
the pi-402 client) so the wire format is machine-checkable from day one.

## 7. Open questions

- **PoP key custody.** Where the session key lives (extension memory vs the
  wallet) and its lifetime across reconnects.
- **Receipt disputes.** What a signed-receipt discrepancy actually entitles the
  client to — refund branch, reputation, on-chain evidence?
- **VHTLC refund vs metering.** Reconciling an on-timeout client refund with the
  server's mid-session spend; the interaction of Ark expiry with a long session.
- **BOLT12 payload limits.** How much `{session_id, units}` context fits in
  `invoice_request` / onion TLV, and privacy of tagging payments with a session.
- **Intent vs profile.** Extend `session`, or register a distinct
  `metered-inference` intent? Prefer the former for interop unless the semantics
  diverge enough to warrant its own.
