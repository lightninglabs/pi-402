# pi-402

## Purpose

A [Pi](https://pi.dev) extension that pays for LLM inference over L402 +
Lightning, using an embedded [Wavelength](https://github.com/lightninglabs/wavelength)
wallet. It registers a paid model provider whose request path is wrapped in a
paying `fetch`, and settles each call against an aperture-based L402 proxy.

Ships as a single extension — Pi core is not modified.

## Module Structure

- `src/index.ts` — extension entry: `registerProvider`, `session_start` wallet
  bootstrap, and wallet commands.
- `src/provider.ts` — the paid provider's `streamSimple`: an OpenAI-compatible
  streaming translation whose HTTP client uses `payingFetch`.
- `src/payer.ts` — `InvoicePayer` implementations: `MockInvoicePayer` (dev) and
  `WalletInvoicePayer` (walletdk `prepareSend` → `sendPrepared` → await preimage).
- `src/wallet.ts` — `WalletService`: loads and unlocks the walletdk WASM, exposes
  balance / boarding address / `payInvoice`.
- `src/policy.ts` — budget policy (per-request and daily ceilings) over
  `@lightninglabs/aperture-core`; the daily counter seeds from the receipt ledger.
- `src/store.ts` — durable state under `PI402_DATA_DIR` (default `~/.pi402`):
  the paid-token cache and the append-only payment receipt ledger.
- `src/commands.ts` — `/wallet`, `/deposit`, `/balance`, `/receipts` slash
  commands.

## Relationships

- **Extends**: [Pi](https://pi.dev) via `@earendil-works/pi-coding-agent`
  (`ExtensionAPI.registerProvider` / `on` / `registerCommand`).
- **Buyer loop**: [`@lightninglabs/aperture-client`](https://github.com/lightninglabs/aperture-ts)
  `createPayingFetch`, [`@lightninglabs/aperture-core`](https://github.com/lightninglabs/aperture-ts)
  `InvoicePayer` + policies.
- **Wallet**: [Wavelength](https://github.com/lightninglabs/wavelength) WASM
  (`walletdkCall`).
- **Seller**: an [aperture](https://github.com/lightninglabs/aperture)-based Go
  L402 proxy fronting the model (separate deployable).

## Invariants

- Pi core is never modified; all behavior is registered through `ExtensionAPI`.
- The wallet is bootstrapped once per session (`session_start`) and reused.
- Budget policy is asserted before any wallet action, on the *quoted total
  outflow* (invoice principal + swap fee), not the invoice face value.
- The L402 buyer loop retries exactly once after payment; the token cache
  prevents re-payment on retry.
- No API keys live in Pi — the proxy holds the model credential.

## Dependencies / status

- `WalletInvoicePayer` is live. The preimage arrives on the settled send entry,
  which [wavelength#835](https://github.com/lightninglabs/wavelength/issues/835)
  landed on 2026-07-01. `MockInvoicePayer` (`PI402_MOCK_PAYER=1`) is still there
  for exercising the buyer loop without spending anything.
- MPP charge is on by default alongside L402. MPP **sessions** are implemented
  in the SDK and proven end to end on regtest, but are off here: a session open
  requires an amountless return invoice for the refund, and the swap-backed
  wallet cannot mint one, so `mppIntents()` refuses the session intent rather
  than opening a deposit that could not come back.

## Deep Docs

- [`docs/l402-walletdk-inference-payments.md`](docs/l402-walletdk-inference-payments.md)
- [`docs/l402-protocol-extensions.md`](docs/l402-protocol-extensions.md)
