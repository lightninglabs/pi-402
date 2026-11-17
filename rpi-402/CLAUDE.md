# pi-402/rpi-402

## Purpose

The rpi port of pi-402: a Rust `cdylib` provider plugin that rpi loads with
`--extensions-dir`. It pays for inference over L402 through a `waved` daemon
and shares the TS extension's settings and data directory.

## Module Structure

- `src/lib.rs` — plugin entry: registers the `pi402` provider with a
  `ProviderContext` and the `/intents` command.
- `src/provider.rs` — `Pi402Provider`: sends the unpaid probe for the
  challenge, buys a credential, then delegates the request to rpi's built-in
  OpenAI-compatible provider with `Authorization: L402 ...`. A 402 from the
  delegated call (`http error 402:` before any event) means the credential is
  spent.
- `src/payer.rs` — `Plugin::buy`: quote, limits on invoice plus fee, intent,
  subscribe-then-send, preimage check, credential and receipt. `reconcile`
  settles recorded intents against the wallet's activity list.
- `src/wallet.rs` — the `waved` HTTP/JSON gateway client, ported from the TS
  sidecar path.
- `src/store.rs` — `tokens.json`, `receipts.ndjson`, and `intents/` (one
  file per payment).
- `src/challenge.rs` — `WWW-Authenticate` parsing, including merged MPP + L402.
- `src/commands.rs` — `/intents` and `/intents abandon <hash>`.
- `tests/flow.rs` — end-to-end tests against mock aperture and `waved`.
- `flake.nix` — builds the plugin, the rpi host, and `rpi-with-402`.

## Invariants

- The plugin SDK (Cargo.toml) and the rpi host (flake input) are the same
  rpi revision; the `rpi-revision` flake check enforces it.
- Shared files follow the TS write rules exactly; the token cache key is
  `<origin>|<path>|<model>|POST`, the same as the TS extension's.
- Limits count cost, the invoice plus its fee, however it is funded, and
  apply before any send to a quote with `total_outflow_known`. Credit top-ups
  are not cost, so credit applied differently at dispatch, or a top-up whose
  payment then fails, does not change what is counted. The balance check is
  on the quoted wallet outflow.
- The sent quote carries a positive `max_fee_sat` (waved reads zero as its
  default) sized so the invoice plus that cap fits the remaining budget; the
  intent reserves invoice plus cap until it resolves. A "exceeds max fee" send
  error means nothing was sent. The receipt records the invoice plus the fee
  of the settled swap, read through activity inspection; without it, a
  nonzero activity-row fee, else the fee cap (a credit-only row's fee reads
  as zero).
- The ledger counts each receipt at max(`paidSat`, `amountSat`), so a Pi
  receipt lowered by credit counts at least its invoice (its fee can still be
  missed); each payment hash counts once, at its larger line, since two
  processes recovering one payment can both append it; and an intent whose
  receipt is recorded counts through the receipt, not its reservation. `counted_today` reads the intents before the
  ledger, the ledger once, with one date; receipts are dated by their
  intent's creation, on live settlement and recovery alike.
- An unreadable ledger, intent store, or intent file stops payments rather
  than counting as zero.
- An intent is closed after settlement only when the credential is stored
  and the receipt reads back from the ledger.
- An intent is written before the send and holds what is needed to rebuild
  the credential; a pending intent blocks payments for its cache key. Only a
  failure the wallet reports, a settlement whose credential and receipt are
  both stored, or `/intents abandon` closes or unblocks it. A send error or
  a missing activity row does not: waved starts the payment before it writes
  the row.
- Intents are one file per payment, so concurrent rpi processes never
  overwrite each other's records.
- A cancel is honoured until just before the send, and once more after the
  intent is written, which drops the unsent intent. The activity stream gets
  two seconds to answer before the send goes ahead anyway, because an idle
  wallet answers only after its first event; after the send, the payment
  finishes in its own task.
- A delegated 402 drops a credential only when a repeat probe with it gets a
  fresh L402 challenge; any other answer means the 402 came from upstream. A
  served probe sends the prompt once more; a prompt gets at most one probe.
- The wallet client keeps no idle connections, because payments and commands
  run on different tokio runtimes.

## Status / TODO

- FIXME in `wallet.rs`: wallet creation discards the returned mnemonic and
  ignores `PI402_WALLET_MNEMONIC`, as the TS daemon path does
  ([pi-402#48](https://github.com/lightninglabs/pi-402/issues/48)).
- Not yet run against the regtest stack in `dev/regtest`.
- Follow-up: MPP `charge`, wallet commands, debiting `bundles.json`.
