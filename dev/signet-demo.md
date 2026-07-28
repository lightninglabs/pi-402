# Signet demo runbook: paying for Kimi K3 with sats

The live demo behind [`talk/main.pdf`](../talk/main.pdf). Three acts: show the
model provisioned on Baseten, fund the harness wallet from the Wavelength web
wallet, then prompt and watch the L402 loop settle a real payment.

> **Status note.** Every leg of this has been validated end to end on
> **regtest** against the real Baseten upstream (GLM-5.2, 4000-sat bundle, 715
> tokens debited). Signet is a re-target of the same stack, not a new code
> path, but the Ark side (arkd / darepod / swapd) has not been exercised on
> signet here. Do a full dry run the day before, not the hour before.

## 0. The bootstrapping question, answered

**Does this work from a cold start, with no prior paid inference?** Yes, and
nothing needs seeding.

- The first request goes out **unauthenticated**. `payingFetch` checks the
  token cache, finds nothing, and sends the request anyway
  (`@aperture/client` `fetch/payingFetch.ts`).
- Aperture answers **402 with the macaroon and the BOLT11 invoice**. That
  challenge is free: L402 hands out the invoice to anyone who asks, which is
  the whole point of the scheme.
- Only then does the wallet pay. So the ordering is
  `challenge → payment → access`, never `access → challenge`.
- `/wallet`, `/deposit`, and `/balance` are extension slash commands. They
  never touch a model, so you can fund and inspect the wallet before any
  inference exists.

The only precondition is **a funded wallet**. There is no chicken-and-egg.

## 1. Funding: pick your path before the talk

This is the one part with real latency risk, so decide deliberately.

### What `/deposit` does today

`/deposit` calls walletdk's `Deposit`, which returns an **on-chain boarding
address** (`src/wallet.ts`, `depositAddress()`). The daemon watches that
address and rolls the boarding output into the next Ark round. So an on-chain
deposit costs you **a signet confirmation plus a round** before the balance is
spendable. Signet blocks average ten minutes and are bursty. Do not put that
on stage.

### The fast path (not yet wired)

walletdk also has a **`Recv`** RPC that returns a **BOLT11 invoice** backed by
an inbound swap. Paying that from Wavelength is seconds, not blocks, because
it never touches the chain. pi-402 does not expose it yet: there is no
`/fund <sats>` command. Wiring one is small (mirror `depositAddress()`, call
`Recv` instead of `deposit`), and it is the difference between a three-second
funding step and a ten-minute one.

### Recommended demo shape

Whichever path you take, **pre-fund before the talk**:

1. The day before, deposit enough for the whole demo plus headroom. A 1M-token
   Kimi K3 bundle quotes at ~11,500 sats (see §4), so fund **50k sats** and you
   can buy four bundles without thinking about it.
2. Confirm it landed: `/balance` should show the confirmed amount.
3. On stage, show the *already funded* wallet with `/balance`, and narrate the
   deposit rather than waiting on it.
4. If you want a live funding moment, kick off a second deposit at the top of
   the talk and check back at the end. It either confirms (nice) or it doesn't
   (you already have the balance you need).

## 2. Act one: the model is real

Show Kimi K3 provisioned on your Baseten account, straight from the catalog:

```bash
curl -s https://inference.baseten.co/v1/models \
  -H "Authorization: Bearer $BASETEN_API_KEY" \
  | jq '.data[] | select(.id=="moonshotai/Kimi-K3")'
```

The points worth landing out loud:

- `"id": "moonshotai/Kimi-K3"`, `"context_length": 1048576`,
  `"input_modalities": ["text","image"]`.
- `"pricing": {"prompt": "0.000003", "completion": "0.000015"}`, so **$3.00 and
  $15.00 per million tokens**. Those are the numbers the meter converts to
  sats, live.
- It is an OpenAI-compatible `/v1` surface, which is the entire reason this
  integration is small.

## 3. Bring up the seller stack

Aperture holds the Baseten credential; pi never sees it.

```bash
export BASETEN_API_KEY=...   # read from the env by aperture's ${ENV} expansion
```

1. **Invoice node.** A signet LND that aperture mints invoices from. Point
   `authenticator.lndhost` / `tlspath` / `macdir` at it and set
   `authenticator.network: signet`.
2. **lightmeter** on `127.0.0.1:10025`, from
   [`dev/regtest/lightmeter.yaml`](regtest/lightmeter.yaml). For signet,
   change two things:
   - `defaultmodel: "moonshotai/Kimi-K3"` (already set)
   - `pricing.btcusd.staticrate: 0` so it polls Coinbase spot instead of the
     pinned regtest rate. Leave it pinned only if you want the slide's exact
     11,500-sat number to reproduce on stage.
3. **aperture** from [`dev/regtest/aperture-baseten.yaml`](regtest/aperture-baseten.yaml),
   listening on `127.0.0.1:8404`, fronting `inference.baseten.co` over https
   with `dynamicprice.metered: true`.

Sanity check the seller before pi is involved. This should come back **402**
with a `WWW-Authenticate: L402 ...` header carrying a macaroon and an invoice:

```bash
curl -si http://localhost:8404/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"moonshotai/Kimi-K3","messages":[{"role":"user","content":"hi"}]}' \
  | head -20
```

That single command *is* the bootstrapping proof from §0: no credential, no
prior payment, and the invoice comes back anyway.

## 4. The pricing, so you can narrate the invoice

lightmeter converts Baseten's USD catalog into sats:

| Step | Input | Output |
|---|---|---|
| Baseten lists | $3.00 / MTok | $15.00 / MTok |
| plus 25% margin | $3.75 | $18.75 |
| at BTC $100k, rounded **up** | 4 msat/token | 19 msat/token |

The bundle is quoted at the blended rate,
`ceil(bundle_tokens * (in + out) / 2 / 1000)`, so a 1M-token bundle is
**11,500 sats**. Debits are then direction-weighted, so completions draw the
balance down faster than prompts and the margin holds either way.

At live spot the sat figure moves; the dollar figure does not. Say that out
loud, it is the more interesting fact.

## 5. Act two: point pi at it

```bash
export L402_PROXY_URL=http://localhost:8404/v1   # the /v1 suffix is required
export PI402_NETWORK=signet
export PI402_WALLET_PASSWORD=...                 # not the dev default
export PI402_WALLETD_GATEWAY=http://localhost:10031   # sidecar darepod
export PI402_MAX_SAT_PER_REQUEST=20000           # must exceed the bundle price
export PI402_DAILY_CAP_SAT=100000
```

The per-request cap is the one that bites: it is asserted against the
**quoted total outflow** (invoice principal plus swap fee), so it has to sit
comfortably above 11,500 or the policy declines the payment and the demo dies
on a budget error rather than anything interesting.

```bash
pi -e /path/to/pi-402
```

Then in the session:

```
/balance                      # show the pre-funded wallet
/model l402-baseten/kimi-k3
```

## 6. Act three: the prompt

Prompt something that shows off a 1M-token frontier model rather than
something a 7B could answer. Then narrate what happens while it runs:

1. pi calls the provider, whose `fetch` is the paying fetch.
2. Aperture answers **402** with the macaroon and an invoice for ~11,500 sats.
3. The budget policy asserts the quoted outflow against the caps.
4. walletdk pays it: **a real Ark to Lightning in-swap**, preimage returned.
5. The token is cached, the request is retried with `L402 macaroon:preimage`.
6. Aperture verifies, injects the Baseten key, and Kimi K3 streams back.
7. lightmeter debits the actual usage off the bundle.

Close on the receipt:

```
/receipts
```

That prints the payment count, all-time and today's spend, and the recent
payments with their payment hashes. The point to make: each line is a
**verifiable** spend record, because the preimage in the ledger hashes to the
payment hash in the invoice.

### The second prompt is the good one

Prompt again. **Nothing is paid.** The bundle still has ~999k tokens on it, so
the cached token is presented and the request just runs. That is the
amortization argument made concrete, and it is much more convincing live than
on a slide.

If you want the exhaustion loop too, restart lightmeter with a small
`bundletokens` (say 2000) beforehand: the third or fourth request gets denied
by `AuthorizeRequest`, aperture mints a **fresh 402**, and the buyer loop pays
it exactly as it paid the first. Same code path as cold start.

## 7. Failure modes and what to say

| Symptom | Cause | Fix |
|---|---|---|
| Baseten 403, "check the api-key you provided" | The client's L402 `Authorization` shadows the upstream credential | Needs the `Header.Set` director fix (aperture `a3969ce`) |
| Aperture start-up error about an unset env var | `${BASETEN_API_KEY}` not exported into aperture's environment | Export it in the same shell that launches aperture |
| "payment N sat exceeds per-request cap" | `PI402_MAX_SAT_PER_REQUEST` below the bundle quote | Raise it above 11,500 |
| 402 loops forever | Invoice paid but preimage never observed | Check the swap server and the wallet subscription; the payer waits on the settled entry |
| Balance shows 0 after depositing | Boarding output not yet confirmed or not yet rolled into a round | This is the §1 latency; pre-fund |
| Model rejected by the meter | Model not in lightmeter's `models` map | Unknown models fail resolution by design, so a seller never quotes an unpriced model |

## 8. The one-sentence close

A wallet with sats in it was sufficient to talk to the most capable
open-weights model in the world. No account, no API key, no card.
