# Paying for Inference with Lightning: a walletdk + L402 Pi **extension**

Status: design / implementation spec
Owner: (TBD)
Related: darepo-client#835 (walletdk preimage exposure) · [`l402-protocol-extensions.md`](./l402-protocol-extensions.md) (metered/streaming L402)

## 1. Goal / end state

Ship a **self-contained Pi extension** that lets Pi pay for each inference call
over **L402 + Lightning**, using an embedded, loaded **walletdk** wallet. The
model is **GLM (4.5 / "2.5" class) on Baseten**, fronted by a small
**aperture-based Go L402 proxy** we control. No API keys in Pi; the proxy holds
the Baseten key and meters access by sats.

The headline change from the earlier draft: **we do not modify pi.** Everything
on the buyer side is delivered through pi's extension system
(`pi.registerProvider` + `on("session_start")` + commands/UI). The only external
dependency is a one-field addition in darepo-client (#835) and the standalone Go
proxy.

```
┌──────────────────── Pi process ────────────────────┐   ┌───────────────────┐
│  pi core (UNMODIFIED)                               │   │ L402 Go proxy     │
│    agent-loop → streamFn → model registry          │   │ (aperture-based)  │
│                    │ selects provider by model id  │   │ 402 + invoice ⇄   │
│  ┌─────────────────▼──────── our extension ───────┐│   │ token ; meters $  │
│  │ registerProvider("l402-baseten", {            ││HTTP│                   │
│  │   api, baseUrl: PROXY, models:[GLM],          ││───▶│                   │
│  │   streamSimple: OpenAI-compat + payingFetch   ││   │└────────┬──────────┘
│  │ })                                            ││   │         │ Api-Key
│  │ on("session_start"): load+unlock walletdk WASM││   │         ▼
│  │ InvoicePayer over walletdkCall(prepare/send)  ││   │  Baseten GLM
│  │ /wallet /deposit /balance  +  budget policy   ││   │  (OpenAI-compat)
│  └────────────────────┬──────────────────────────┘│   └───────────────────┘
│         walletdk WASM (Ark wallet, in-process) ◀───┘
└─────────────────────────────────────────────────────┘
```

## 2. Can we do everything as an extension? Yes.

Every capability the earlier core-mod plan needed maps onto a documented
extension hook (all verified in `packages/coding-agent/src/core/extensions/`
and the `examples/extensions/` set):

| Need | Extension mechanism | Evidence |
|---|---|---|
| Route inference through a paying transport | `registerProvider(name, { streamSimple })` — the custom `streamSimple` builds the HTTP client itself, so it can inject `payingFetch`. | `examples/extensions/custom-provider-anthropic/index.ts` registers a provider with its own `streamSimple`, `baseUrl`, `apiKey`, `oauth`, `models`. |
| Point at the L402 proxy, define the GLM model, set price metadata | `registerProvider` config: `baseUrl`, `models: [{ id, cost, contextWindow, maxTokens }]`. | same example |
| Bootstrap + hold the wallet across the session | `on("session_start", handler)` | `dynamic-tools.ts` registers on `session_start`; runtime emits `session_start` (`agent-session-runtime.ts:215+`). |
| `/wallet`, `/deposit`, `/balance` | `registerCommand(name, { … })` | `commands.ts`, `loader.ts:236` |
| Show balance / boarding address / prompts | `ctx.ui.select()`, `ctx.ui.setStatus()`, `ctx.ui.setWidget()` | `question.ts`, `status-line.ts`, `widget-placement.ts` |
| Budget caps as flags | `registerFlag(name, { type, default })` | `loader.ts:~250`, `preset.ts` |
| Surface a payment/funding error to the user | provider `streamSimple` emits an `error` event; extension may also `sendMessage`/`appendEntry`. | `AssistantMessageEventStream` error path in the example |
| Bundle native/wasm + npm deps | extension has its own `package.json` + `node_modules` | `custom-provider-anthropic/package.json`, `with-deps/`, `sandbox/` |

**Net: the buyer side is 100% an extension.** And because the provider's
`streamSimple` owns the whole request path, we **drop** the previously-planned
"add `fetch` to `SimpleStreamOptions`" change to pi-ai entirely — the extension
wires `payingFetch` into its own OpenAI client with no core seam.

### What "extension-only" changes vs. the core-mod plan
- **No pi-ai change, no coding-agent `sdk.ts` change.** Provider registration is
  the seam.
- **Opt-in is model selection.** The user runs `/model l402-baseten/glm-…` (or a
  bundled preset) to activate paid inference. Clean and explicit.
- **The one real chunk of code** is the provider's `streamSimple`: an
  OpenAI-compatible streaming translation that uses `payingFetch`. The Anthropic
  example is the (harder) template; OpenAI-compat SSE is simpler. We cannot reuse
  pi-ai's built-in openai stream directly because it uses the global `fetch` and
  won't take our paying transport — so the extension ships its own, thin,
  streamSimple. (Trade-off noted in §8.)

## 3. Layering *inside* the extension

pi core stays payment-agnostic; the structure now lives within the extension:

| Concern | Extension module | Notes |
|---|---|---|
| Paying transport + model | `provider.ts` — `streamSimple` w/ `new OpenAI({ baseURL: PROXY, fetch: payingFetch })` | request-scoped, stateless |
| L402 buyer loop | `@aperture/client` `createPayingFetch({ payer, buyerPolicy, tokenCache })` | reused as-is |
| Wallet lifecycle (create/unlock/**deposit=boarding addr**/balance) | `wallet.ts` — loads walletdk WASM on `session_start`, holds handle in extension state | the boarding-address/deposit flow lives here, surfaced via commands/UI, never on the inference path |
| InvoicePayer | `payer.ts` — wraps `walletdkCall` | see §5.3 |
| Budget/approval | `policy.ts` — `@aperture/core` policies + `ManualApprovalPolicy` via `ctx.ui` | asserted before dispatch, on quoted total |
| UX (`/wallet`, `/deposit`, `/balance`, status widget) | `commands.ts` | `ctx.ui.*` |

### Does the agent core / coding-agent need to know? (your question)
No. The agent core only sees a registered provider like any other. It does **not**
learn about boarding addresses, deposits, or preimages. The wallet/deposit UX is
entirely inside the extension (commands + `ctx.ui`), out of band from the
inference path. That's the whole appeal of the extension approach.

## 4. Dependency: darepo-client#835 (must land first)

Unchanged by the extension reframe. walletdk pays BOLT11 today
(`prepareSend`→`sendPrepared`, swap hidden), and the swap FSM observes the
preimage (`sdk/swaps/in_swap.go:968`, on `SwapSummary`), but the streamed
`WalletEntry`/`WalletEntryProgress` (`wallet.proto:1017`,`:1166`) carry only
`payment_hash`, not the preimage — and the send is fire-and-forget, so you must
watch `subscribe` for COMPLETE regardless. #835 adds `preimage` to
`WalletEntryProgress`, populated from `SwapSummary.GetPreimage()` in
`swapEntryFromSummary` (`swapwallet/history.go:318`), mapped through
`sdk/walletdk` (`types.go` + `convert.go:315`); the mobile facade and WASM bridge
carry it for free on the existing `list`/`subscribe` verbs.

Until #835 lands, build against a **stub `InvoicePayer`** (fixed preimage, like
`MockInvoicePayer`) so the extension is testable against a mock seller.

## 5. The extension — implementation

### 5.1 Entry point
```ts
export default function (pi: ExtensionAPI) {
  const wallet = new WalletService();          // holds walletdk WASM handle
  const payer  = new WalletInvoicePayer(wallet);
  const policy = buildBudgetPolicy(pi);        // from registerFlag values

  pi.on("session_start", async () => { await wallet.startAndUnlock(); });

  pi.registerProvider("l402-baseten", {
    api: "l402-openai",                         // our own api id
    baseUrl: process.env.L402_PROXY_URL,        // the Go proxy
    apiKey: "unused",                           // proxy holds the real key
    models: [{
      id: "glm-4.5", name: "GLM 4.5 (L402)",
      input: ["text"], reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // sats-metered, not $/token
      contextWindow: 128000, maxTokens: 8192,
    }],
    streamSimple: makeStreamSimple({ payer, policy }),
  });

  registerWalletCommands(pi, wallet);           // /wallet /deposit /balance
}
```

### 5.2 `streamSimple` with `payingFetch`
Mirror `custom-provider-anthropic`'s streaming loop, but OpenAI-compatible and
with the paying transport:

```ts
const payingFetch = createPayingFetch({ payer, buyerPolicy: policy, tokenCache });
const client = new OpenAI({ baseURL: model.baseUrl, apiKey: "unused", fetch: payingFetch });
const sse = await client.chat.completions.create({ model: model.id, messages, stream: true }, { signal });
// translate OpenAI SSE deltas → AssistantMessageEventStream (text/toolcall/usage/done)
```
`payingFetch` intercepts the proxy's 402, runs policy, pays via the wallet,
caches the token, and retries — transparently to the SDK, streaming included.

### 5.3 InvoicePayer over walletdk
```ts
const payer: InvoicePayer = {
  async payInvoice({ invoice, amountSat }) {
    const q = await walletdkCall("prepareSend", { invoice });      // quote (incl. swap fee)
    policy.assertWithinBudget(q.expected_total_outflow_sat ?? amountSat);
    await walletdkCall("sendPrepared", { send_intent_id: q.send_intent_id });
    const preimageHex = await awaitPreimage(q.payment_hash);        // subscribe→COMPLETE→progress.preimage (#835)
    return { preimageHex, amountPaidSat: q.amount_sat ?? amountSat };
  },
};
```
`awaitPreimage` drives a `walletdkCall("subscribe", …)` handle until the entry
for `payment_hash` settles. Idempotency: `StartPay` dedups by invoice; the L402
token cache ensures retry-once never re-pays.

### 5.4 Wallet bootstrap + funding
On `session_start`: locate the bundled `walletdk-wasm` artifact + `wasm_exec.js`,
instantiate (Node and browser both work), `walletdkCall("start", cfg)` (cfg has
swap-server + data-dir; see `sdk/walletdk/mobile/config.go`), then `unlockWallet`
(or `createWallet` first run). `/deposit` → `walletdkCall("deposit")` → show
boarding address; poll `confirmedBalanceSat`/`pendingInboundSat` for a status
widget; warn when balance < policy floor.

### 5.5 Packaging
Extension `package.json` deps: `@aperture/client`, `@aperture/core`, `openai`,
and the `walletdk-wasm` blob (+ glue). Loaded via `pi -e ./l402-ext` or dropped
in `~/.pi/agent/extensions/`. Consider vendoring the wasm to avoid a build step
for users.

## 6. Seller side — the aperture-based Go L402 proxy (unchanged)

Separate deployable, identical to the earlier plan:
1. **Gate** the route with L402 (reuse aperture's `l402` package: identifier
   codec, caveats, satisfier, macaroon mint/verify).
2. **Issue invoices** from a real LN backend (LND/CLN); mirror aperture-ts's
   `RestInvoiceProvider` create/lookup abstraction for regtest vs mainnet.
3. **Price** the call — flat per-request to start; token-metered later.
4. **Forward** to Baseten with the secret key.

### Baseten target (GLM)
- OpenAI-compatible base (Engine-Builder):
  `https://model-{MODEL_ID}.api.baseten.co/environments/production/sync/v1`
  → `/chat/completions`, streaming supported.
- Baseten auth: `Authorization: Bearer {BASETEN_API_KEY}` (legacy `Api-Key {key}`
  also accepted). Key lives only in the proxy.
- Proxy presents an OpenAI-compatible surface outward, so the extension's OpenAI
  client talks to it unchanged except `baseUrl`.
- Streaming: L402 settles the whole request; pass SSE through verbatim on the
  paid retry.

## 7. End-to-end flow

1. Pi starts → extension `session_start` loads+unlocks walletdk; if unfunded,
   `/deposit` shows a boarding address; user funds; balance confirms.
2. User selects `/model l402-baseten/glm-4.5` and prompts.
3. agent-loop → model registry → our provider `streamSimple` → OpenAI client
   whose `fetch` is `payingFetch`, `baseUrl` = proxy.
4. First call → proxy `402` + invoice + macaroon.
5. `payingFetch` runs budget policy on the quoted total → `payInvoice` → walletdk
   `prepareSend`/`sendPrepared` → Ark↔LN swap pays → preimage observed (#835).
6. Token cached; retry with `L402` header; proxy verifies → forwards to Baseten
   GLM → streams the completion back.
7. Later calls reuse the cached token until expiry — no repeat payment.

## 8. What's missing / open questions / risks

- **#835 (preimage)** — hard dependency; everything else builds against a stub.
- **Own OpenAI streamSimple** — the extension must re-implement OpenAI SSE →
  `AssistantMessageEventStream` (can't reuse the built-in, which uses global
  `fetch`). Bounded, well-modeled by the Anthropic example, but real code +
  maintenance. (Alt: petition pi to add a `fetch`/`client` option to the built-in
  openai stream so the extension can reuse it — a *small* upstream change that
  would shrink the extension. Optional, not required.)
- **Latency** — Ark↔LN swap is seconds; `payingFetch` blocks on the first call
  per route. Token caching amortizes; consider pre-warming a token before the
  first turn. Decide token TTL + scope.
- **Pricing** — flat per-request first; token-metered later needs the proxy to
  read Baseten usage and pre-quote or post-charge; define reconciliation.
- **Streaming + L402** — verify no full-buffering in the proxy on the paid retry.
- **Funding floor / refills** — pause-and-prompt vs auto-refill policy; where the
  re-deposit loop surfaces in the UI.
- **Error taxonomy** — the provider maps insufficient-funds / declined / policy-
  rejected / swap-expired to clear `error` events (and optional `sendMessage`);
  no core error-type change available to an extension, but the event path
  suffices.
- **WASM packaging** — bundle size + startup cost of `walletdk-wasm`
  (`mobile,walletdkrpc,swapruntime` tags) inside the extension; Node vs browser
  glue.
- **Swap server dependency** — wallet needs a reachable swapdk server; hosted vs
  self-run; regtest wiring.
- **Receipts/audit** — `ReceiptCache` + wallet activity give two records; pick a
  source of truth for session spend.

## 9. Milestones

1. **#835** preimage on settled send entry (darepo-client) + regtest proof.
2. **Extension skeleton**: `registerProvider` + own OpenAI `streamSimple` +
   `MockInvoicePayer` + mock Go L402 proxy → prove the paying loop end to end
   with no wallet and no #835.
3. **Wallet service**: `session_start` bootstrap of walletdk WASM + `/deposit`
   (boarding addr) + `/balance` + budget flags/policy.
4. **Real InvoicePayer** (prepareSend→sendPrepared→await preimage) on regtest
   swaps.
5. **Real Go L402 proxy** in front of real Baseten GLM; LN backend issuing
   invoices.
6. Mainnet dry run with caps.

## 10. Testing

- darepo-client: unit on `swapEntryFromSummary` preimage carry + SDK convert;
  regtest send shows preimage on `subscribe`.
- extension: unit on the `InvoicePayer` adapter (mock `walletdkCall`); buyer-
  policy enforcement on quoted total; token-cache retry-once-no-double-pay;
  OpenAI SSE → event-stream translation.
- proxy: 402 challenge correctness, macaroon verify, preimage check, Baseten
  forward (mock), SSE pass-through.
- e2e: `pi -e ./l402-ext` ↔ proxy ↔ Baseten mock on regtest swaps, then one real
  GLM call.
