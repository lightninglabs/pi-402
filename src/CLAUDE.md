# pi-402/src

## Purpose

The pi-402 extension itself: the code Pi loads to register a paid, L402-settled
model provider backed by an embedded walletdk wallet.

## Module Structure

- `index.ts` — extension entry (`export default function (pi)`): registers the
  provider, bootstraps the wallet on `session_start`, and wires the wallet
  commands.
- `provider.ts` — `makeStreamSimple`: the provider's `streamSimple`. Builds an
  OpenAI client whose `fetch` is `createPayingFetch(...)` and translates the
  OpenAI SSE stream into Pi's `AssistantMessageEventStream`. This is the seam
  that injects payment without touching Pi core.
- `payer.ts` — `InvoicePayer` implementations: `MockInvoicePayer` (dev) and
  `WalletInvoicePayer` (delegates to `WalletService`).
- `wallet.ts` — `WalletService`: the embedded walletdk WASM wrapper
  (`prepareSend` → `sendPrepared` → await preimage; balance; boarding address).
- `policy.ts` — `buildBudgetPolicy`: per-request and daily spend ceilings.
- `commands.ts` — `/wallet`, `/deposit`, `/balance`.

## Invariants

- `streamSimple` owns the whole request path; payment is injected here, nowhere
  in Pi core. The OpenAI client sets `maxRetries: 0` so the paying fetch owns
  retry semantics and the SDK never re-enters it to double-pay.
- The token cache is per provider instance, so paid tokens are reused until
  expiry and retries never re-pay.
- The budget policy runs before any wallet action, and the wallet re-asserts the
  per-request ceiling on the *quoted total outflow* (invoice principal plus swap
  fee) after `prepareSend`, before dispatching `send`/`sendPrepared`.

## Status / TODO

- `provider.ts` handles the text streaming path only; tool calls, reasoning, and
  usage mapping beyond `finish_reason: length` are milestone-2 work (mirror
  `custom-provider-anthropic`).
- `wallet.ts` implements both backends: the sidecar HTTP/JSON gateway
  (`PI402_WALLETD_GATEWAY`) and the embedded WASM bridge. Both run
  `prepareSend` → open settle stream → `send`/`sendPrepared` → read preimage.
  The preimage read still depends on
  [darepo-client#835](https://github.com/lightninglabs/darepo-client/issues/835)
  landing the preimage on the settled entry.
- Run with `PI402_MOCK_PAYER=1` to exercise the loop against a mock proxy before
  the wallet is wired.
