# pi-402

## Purpose

A [Pi](https://pi.dev) extension that pays for LLM inference over L402 +
Lightning, using an embedded [walletdk](https://github.com/lightninglabs/darepo-client)
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
  `@aperture/core`.
- `src/commands.ts` — `/wallet`, `/deposit`, `/balance` slash commands.

## Relationships

- **Extends**: [Pi](https://pi.dev) via `@earendil-works/pi-coding-agent`
  (`ExtensionAPI.registerProvider` / `on` / `registerCommand`).
- **Buyer loop**: [`@aperture/client`](https://github.com/lightninglabs/aperture-ts)
  `createPayingFetch`, [`@aperture/core`](https://github.com/lightninglabs/aperture-ts)
  `InvoicePayer` + policies.
- **Wallet**: [walletdk](https://github.com/lightninglabs/darepo-client) WASM
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

- Real `WalletInvoicePayer` depends on
  [darepo-client#835](https://github.com/lightninglabs/darepo-client/issues/835)
  (preimage on settled send entry). Until it lands, develop against
  `MockInvoicePayer`.

## Deep Docs

- [`docs/l402-walletdk-inference-payments.md`](docs/l402-walletdk-inference-payments.md)
- [`docs/l402-protocol-extensions.md`](docs/l402-protocol-extensions.md)
