# Signet demo runbook: paying for Kimi K3 with sats

The live demo behind [`talk/main.pdf`](../talk/main.pdf). Three acts: show the
model provisioned on Baseten, fund the harness wallet from the Wavelength web
wallet, then prompt and watch the L402 loop settle a real payment.

> **Status note.** Every leg of this has been validated end to end on
> **regtest** against the real Baseten upstream (GLM-5.2, 4000-sat bundle, 715
> tokens debited). Signet is a re-target of the same stack, not a new code
> path, but the Ark side (arkd / darepod / swapd) has not been exercised on
> signet here. Do a full dry run the day before, not the hour before.

> **Merge PR #11 first.** The `/receipts` command and the durable token cache
> live on the `durable-receipts` branch, still open as
> [#11](https://github.com/lightninglabs/pi-402/pull/11). Without it there is
> no `/receipts` to close on (§6), and the token cache is in-memory, so every
> `pi` process re-buys a bundle. Within one session the reuse story still
> works, but a restart mid-demo costs another 11,500 sats.

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

## 1. Funding: two paths, and which to put on stage

### `/fund <sats>`: the live path

```
/fund 50000
```

Returns a **BOLT11 invoice** (walletdk's `receive`, wired in
`src/wallet.ts` as `receiveInvoice()`). Pay it from the Wavelength web wallet
and the balance lands in **seconds**, because the daemon sets the receive up
through its swap subsystem and nothing touches the chain. This is the funding
moment worth showing live.

### Which rail actually carries the sats

Worth understanding before you narrate any of it, because the honest sentence
is not the obvious one.

A BOLT11 invoice is the *interface* here, not the settlement path. When you
call `prepare-send`, the quote comes back with a `rail`, and the swap server
picks it, not the wallet: `swapwallet/router.go` only maps the server's
`SwapSettlementType` onto the client-facing `SendRail`. Two rails matter for
this demo.

**`SEND_RAIL_LIGHTNING`** is what an L402 payment uses. Aperture mints its
invoice on a plain Lightning node, which is nobody's Ark client, so the swap
server has to actually pay it: it takes the VTXO and sends a real HTLC over a
real channel. This is the path every payment in `/receipts` took.

**`SEND_RAIL_IN_ARK`** is what a wallet-to-wallet deposit uses. When both ends
are Ark wallets on the same operator, paying the invoice over Lightning would
mean the swap server's node paying an invoice its own node issued. Instead it
settles the transfer inside Ark, and the quote comes back at **zero fee**.

The part worth being precise about: settling in Ark does **not** mean a
trusted book transfer. The server builds a **vHTLC** (`arkscript.NewVHTLCPolicy`)
whose `PreimageHash` is *the invoice's own payment hash*, verbatim. The sender
funds it, a `refund_without_receiver` recovery job is armed immediately, and
that job is only cancelled once the claim is seen:

```
SWAP: In-swap vHTLC funding submitted hash=678ce54d… outpoint=a3fc0af6…:0
VREC: vhtlc recovery job created  … direction=pay action=refund_without_receiver state=armed
VREC: vhtlc recovery cancelled    … cancel_reason="server claim observed"
```

So it is the same hash-locked, unilaterally-refundable contract Lightning
gives you, with the HTLC living as an Ark virtual output instead of a channel
HTLC. The preimage is still revealed to claim it, which is why this rail would
preserve L402's proof-of-payment property if a seller were ever an Ark wallet
too.

**How to say it on stage.** "The wallet paid the invoice" is always true.
"Routed over Lightning" is true for the L402 payments and false for the
deposit. If you want one line that covers both: *the invoice is the interface,
and the network picks the cheapest settlement that still honours the payment
hash.* You can show the split live from the swap server's log, where the two
read as `Sending in-swap Lightning payment` and `Created in-ark p2p swap`.

### `/deposit`: the on-chain path

Returns an **on-chain boarding address**. The daemon watches it and rolls the
boarding output into the next Ark round, so the balance costs **a signet
confirmation plus a round** before it is spendable. Signet blocks average ten
minutes and are bursty. Fine for pre-funding, wrong for the stage.

On signet, `./dev/demo/demo-fund.sh signet 25000` mints the invoice for you and
`./dev/demo/demo-fund.sh signet --watch` prints the balance the moment it
moves, which is the bit worth having on screen while you pay from the app. On
regtest the same script pays the invoice itself, since there is no app.

### Recommended demo shape: do both

Use `/fund` live, but **pre-fund the day before as the safety net**, so a swap
server hiccup can't sink the demo:

1. The day before, fund enough for the whole demo plus headroom. A 1M-token
   Kimi K3 bundle quotes at ~11,500 sats (see §4), so **50k sats** buys four
   bundles without thinking about it.
2. Confirm it landed with `/balance`.
3. On stage, run `/fund 20000`, pay from Wavelength, and watch `/balance` move.
   If it stalls, you already have the balance to keep going, and the stall
   costs you a sentence instead of the demo.

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

One script, two profiles. Signet is the one to demo on; regtest is the
fallback for when signet or the venue's network is unwell.

```bash
export BASETEN_GLM_5_2=...        # aperture reads the credential from its env
./dev/demo/demo-up.sh signet      # or: ./dev/demo/demo-up.sh regtest
```

It brings up the pricer, the proxy and both wallets in a tmux session, creates
the wallets on first run, and finishes by proving the seller works: it fires an
unauthenticated request and shows you the 402 with the invoice it minted. If
that line does not appear, stop and fix it before the room is watching.

**There is no Lightning node on either profile.** Aperture mints its challenge
invoices from a Wavelength wallet (`authenticator.wavelengthgateway`), so the
swap server supplies the inbound liquidity and the seller needs no node, no
channels and no inbound capacity. That is also the honest headline for this
part of the talk: standing up a paid API took a wallet, not an infrastructure
project.

What actually differs between the profiles:

| | signet | regtest |
|---|---|---|
| Chain, operator, swap server | public, hosted | local, `docker compose` |
| Containers | none | the lumos stack |
| Buyer funding | **you pay from the Wavelength app** | local lnd pays it |
| Invoice prefix | `lntbs…` | `lnbcrt…` |

Both pin `btcusd.staticrate: 100000` so the quoted bundle is the same 11,500
sats the deck cites. Set it to `0` to poll Coinbase spot instead, at the cost
of the number on the slide no longer matching the one on screen.

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
/fund 20000                   # live top-up: pay this from Wavelength
/balance                      # watch it land
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
| Balance shows 0 after `/deposit` | Boarding output not yet confirmed or not yet rolled into a round | This is the §1 latency; pre-fund |
| `/fund` invoice never settles | Swap server unreachable, or no inbound capacity for the receive | Fall back to the pre-funded balance and keep going |
| `/fund` says "Usage: /fund \<sats\>" | Amount missing or not a positive whole number | `/fund 20000`; underscores and commas are fine |
| Model rejected by the meter | Model not in lightmeter's `models` map | Unknown models fail resolution by design, so a seller never quotes an unpriced model |
| Session aborts at start-up with "wallet is not ready (create first)" | The sidecar has no wallet yet, and the bootstrap read the probe failure as fatal | Needs the fix in `93bbff1`; before it, the first run against a fresh wallet could never start |
| Answers arrive as `<\|open\|>call tool="bash"...` markup | The request carried no tool declarations, so the model fell back to its native call syntax | Needs the fix in `ef9f9b5`, which declares Pi's tools and translates `tool_calls` back |
| Long pause before any text on Kimi K3 | Reasoning streams first, and on a short answer it is most of the response | Expected; reasoning now renders as thinking content rather than dead air |

## 8. The one-sentence close

A wallet with sats in it was sufficient to talk to the most capable
open-weights model in the world. No account, no API key, no card.
