# rpi-402

`rpi-402` is the [rpi](https://github.com/bigfish1913/pi-rust) port of pi-402:
a provider plugin, loaded by rpi as a native library, that pays for inference
over L402 with a [Wavelength](https://github.com/lightninglabs/wavelength)
wallet. It registers the `pi402` provider, answers an
[aperture](https://github.com/lightninglabs/aperture) seller's 402 challenge by
paying its invoice, and streams the model's response into rpi.

It shares its settings and its data directory with the TypeScript extension, so
a bundle bought in Pi is spent from rpi and the other way round. Both check the
daily limit against the same receipt ledger, but they count it differently:
rpi counts each receipt at no less than its invoice amount, while Pi counts what
left the wallet, which credit can bring below the invoice. So neither holds the
shared limit exactly: Pi can approve payments past it
([pi-402#49](https://github.com/lightninglabs/pi-402/issues/49)), and rpi,
counting a Pi credit-funded receipt at its invoice amount, misses that
payment's fee.

## Build and run

The flake builds the plugin and the rpi host from the same rpi revision. The
plugin SDK and the host have to match.

```bash
nix build ./rpi-402#rpi-402        # result/lib/rpi/extensions/librpi_402.so
nix run ./rpi-402 -- --provider pi402 --model deepseek-ai/DeepSeek-V4-Flash-0731
```

`nix run` starts rpi with the plugin on `RPI_EXTENSIONS_DIR`. With an rpi you
built yourself, point it at the plugin directory instead:

```bash
rpi --extensions-dir result/lib/rpi/extensions --provider pi402 \
  --model deepseek-ai/DeepSeek-V4-Flash-0731
```

`rpi --list-models` shows the model without contacting the seller or the
wallet.

## Requirements

- A running `waved` with its HTTP/JSON gateway. rpi-402 has no embedded
  wallet. If the daemon has no wallet yet, rpi-402 creates one. Like the TS
  extension's daemon path, it does not yet save the seed words that come back,
  so create the wallet yourself first if you need them
  ([pi-402#48](https://github.com/lightninglabs/pi-402/issues/48)).
- An aperture seller at `L402_PROXY_URL`.

## Settings

The same environment variables as the TS extension:

| Variable | Default | Meaning |
|----------|---------|---------|
| `L402_PROXY_URL` | `http://localhost:8402` | Seller base URL, including the API prefix (for aperture, `/v1`) |
| `PI402_WALLETD_GATEWAY` | `http://localhost:10031` | `waved` HTTP/JSON gateway |
| `PI402_WALLET_PASSWORD` | dev default | Wallet password; mainnet refuses the default |
| `PI402_NETWORK` | `regtest` | Only consulted to refuse the default password on mainnet |
| `PI402_MAX_SAT_PER_REQUEST` | `1000` | Per-payment ceiling on the invoice plus its fee |
| `PI402_DAILY_CAP_SAT` | `100000` | Daily ceiling on invoices plus their fees |
| `PI402_DATA_DIR` | `~/.pi402` | Shared with the TS extension |

## Files

In `PI402_DATA_DIR`, written by the same rules as the TS extension (fresh
reads, merge before rewrite, atomic replace, mode 0600, corrupt files set
aside):

- `tokens.json`: paid credentials, keyed by seller, path, and model. Shared
  with Pi.
- `receipts.ndjson`: one line per settled payment. Shared with Pi; the daily
  limit sums it. rpi-402 dates a receipt by when its payment was sent, so a
  payment counts on the same day whether it settles at once or is recovered
  after a restart.
- `intents/`: rpi-402's record of each payment, one file per payment named by
  its payment hash. It is written before the send and removed once the
  payment fails, or settles with its credential and receipt stored. One file
  per payment means two rpi processes never overwrite each other's records.
- `rpi-402.log`: warnings. The plugin runs inside rpi's terminal UI, so it
  does not write to stderr.

## Payments

The limits count what a payment costs: the invoice plus its fee, however it
is funded. A credit top-up only moves sats into the swap server's credit, so
it is not a cost; credit counts when a payment spends it. How much credit the
wallet applies at dispatch therefore changes where the sats come from, not
what the payment costs.

Before any send, rpi-402 quotes the invoice and checks that cost against the
per-payment ceiling and the remaining daily budget, and checks that the
wallet's confirmed balance covers what leaves it now (the swap funding plus
any top-up). A quote whose total the wallet does not know is not sent: that
happens when `waved` or its swap server is too old to quote fees, and
upgrading them is the fix.

The invoice is quoted twice: the second quote carries a fee cap the wallet
enforces at dispatch, sized so the invoice plus the fee at the cap stays within
the per-payment ceiling and what is left of the day's budget. A payment with no
room for any fee is refused, since the wallet reads a zero cap as its own
default. A fee that rises past the cap before the send makes the wallet reject
it, and nothing is sent. The receipt records the invoice plus the fee the
settled payment's swap reports, higher or lower than quoted. When the wallet
cannot show the swap, a nonzero fee on the activity row is used; a zero there
may be a credit-only payment's missing fee, so the fee cap is counted
instead.

The daily budget counts the shared receipt ledger, each receipt at no less
than its invoice amount, plus this machine's open intents, each at the invoice
plus its fee cap. A payment counts once: an intent whose receipt is already in
the ledger counts through the receipt. When either cannot be read, including a
recorded payment that cannot be parsed, no payment is made. A refused payment
sends nothing.

A cancelled prompt stops the request. Up to the moment of the send nothing is
paid; a payment already sent finishes in the background and its credential and
receipt are stored. An error from the wallet's send call does not show that
nothing was sent, so the payment stays recorded. A payment whose outcome is
unknown, after such an error, a timeout, or a restart, blocks further payments
for its model until the wallet reports it settled or failed. `/intents` lists
such payments and asks the wallet about each one, recovering any that settled.
`/intents abandon <payment hash>` stops one from blocking. It stays recorded,
keeps its reservation against the daily limit, and is recovered if it settles
later. If the
model has bought another credential by then, that one stays cached and the
recovered bundle goes unused.

When the seller answers a cached credential with 402, rpi-402 repeats a
minimal request with that credential. Only a fresh L402 challenge in answer
shows it is spent and gets paid. If the seller serves that request, the 402
was passing and the prompt is sent once more; otherwise the 402 came from the
model behind the seller, and it is reported with the credential kept. The
minimal request costs a one-token completion when the credential is good, so
a prompt gets at most one of them.

## Differences from the TS extension

- One model, `deepseek-ai/DeepSeek-V4-Flash-0731`. rpi uses the seller's
  model name as the model id.
- L402 only. MPP `charge` and wallet commands such as `/balance` are follow-up
  work.
- Both limits are checked on the quoted invoice plus fee, however it is
  funded, and receipts record that cost. The TS extension checks the daily
  limit on the challenge's stated amount and records the wallet's quoted
  outflow, credit top-ups included.
- Pi's bundle bar (`bundles.json`) is not updated, so it overstates the credit
  left in a bundle rpi also spends from.
- The challenge is fetched with a minimal unpaid request, not the prompt
  itself; the prompt is sent once, with the credential.

## Development

```bash
cargo test     # unit tests, plus end-to-end tests against a mock seller and wallet
cargo clippy --all-targets -- -D warnings
```

The end-to-end tests in `tests/flow.rs` run the provider against mock
aperture and `waved` servers. They cover the plan's acceptance checks except
the real regtest stack.
