<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <strong>pi-402</strong>: pay for inference with Lightning
</p>

# pi-402

`pi-402` is a [Pi](https://pi.dev) extension that pays for LLM inference over
Lightning. It loads an embedded
[Wavelength](https://github.com/lightninglabs/wavelength) wallet, registers a
paid model provider, and settles each inference call against an
[aperture](https://github.com/lightninglabs/aperture) proxy, so you can run Pi
against a metered model with sats instead of an API key.

No changes to Pi itself: this is a self-contained extension you drop into your
own Pi install.

Inference is priced by the token rather than by the request. One payment buys a
bundle of tokens, and the proxy debits what the model actually reported serving,
weighted by direction, until the bundle runs out and a fresh challenge arrives.
See [`docs/metering.md`](https://github.com/lightninglabs/aperture/blob/master/docs/metering.md)
in aperture for how that works end to end.

## How it works

```
Pi  ──▶  pi-402 provider  ──▶  OpenAI client (fetch = payingFetch)  ──▶  aperture  ──▶  Baseten
                │                         │ 402 → pay → retry                │
                └── Wavelength wallet ◀───┘ pays the BOLT11 invoice          └── holds the model key
                    (Ark↔Lightning swap)
```

The extension registers a provider whose `streamSimple` owns the request path,
wrapping the model call in a paying `fetch`. When the proxy answers `402`, the
buyer loop runs your budget policy, pays the invoice through the embedded
wallet, caches the credential, and retries. Streaming included, and the agent
loop above it never learns that a payment happened.

The proxy offers two doors on the same `402` and the buyer takes whichever it
speaks: **L402** (a macaroon bound to the invoice's payment hash, which you can
attenuate offline and hand to a sub-agent) and the **Payment HTTP
Authentication Scheme** (`draft-httpauth-payment-00`, the IETF draft co-authored
by Stripe and Tempo). `PI402_PAYMENT_SCHEME` picks; the default takes a Payment
offer when the seller makes one and falls back to L402.

No API key ever reaches the buyer. Aperture holds the model credential and
injects it server-side, so the buyer holds sats and the seller holds the key.

## Install

The quickest path (Pi's package manager clones, installs deps, and auto-loads):

```bash
pi install git:github.com/lightninglabs/pi-402
```

See [INSTALL.md](INSTALL.md) for all install methods (managed package,
auto-discovered directory, per-run `-e` flag), dependency linking during
development, and the mock-payer verification path.

Then select a paid model and prompt:

```
/model l402-baseten/kimi-k3          # 1M context, natively multimodal
/model l402-baseten/glm-4.7          # 200K context
/model l402-baseten/glm-5.2          # 200K context
/model l402-baseten/deepseek-v4-flash # 1M context, the cheap one
```

Wallet commands:

```
/wallet        show wallet status and balance
/fund <sats>   show a Lightning invoice to fund the wallet (settles in seconds)
/deposit       show an on-chain boarding address to fund the wallet
/balance       show confirmed / pending balance
/receipts      show the payment ledger: count, all-time and today's sats
```

`/fund` is the path to use. It mints a BOLT11 invoice that you pay from the
[Wavelength](https://wavelength.money) app on your phone, and the sats land in
seconds through an inbound swap. The wallet is an Ark wallet, so there are no
channels to open, no inbound liquidity to source, and nothing to keep online.

Whatever you fund is the ceiling on what the agent can ever spend, which is a
more comfortable thing to hand an autonomous process than a card.

## Configuration

| Env var | Description |
|---------|-------------|
| `L402_PROXY_URL` | Base URL of the L402 proxy fronting the model, including the API prefix (e.g. `http://localhost:8404/v1`) |
| `PI402_MAX_SAT_PER_REQUEST` | Per-request spend ceiling (budget policy) |
| `PI402_DAILY_CAP_SAT` | Daily spend ceiling |
| `PI402_PAYMENT_SCHEME` | `auto` (default: take a Payment offer when the seller makes one, else L402) or `l402` to force the L402 door |
| `PI402_MPP_INTENTS` | Comma-separated Payment intents to accept. Defaults to `charge`. Sessions need a return-invoice minter, which the swap-backed wallet cannot supply yet, so asking for `session` here throws. |
| `PI402_MOCK_PAYER` | Set to `1` for the mock payer (no Lightning; dev only) |

### Wallet backends

The embedded wallet runs against one of two Wavelength wallet backends:

| Env var | Description |
|---------|-------------|
| `PI402_WALLETD_GATEWAY` | **Sidecar mode**: HTTP/JSON gateway of a native `waved` built with the `wavewalletrpc` tag (e.g. `http://localhost:10031`). This is the path for Node hosts, where the WASM's OPFS-backed SQLite is unavailable. |
| `PI402_WASM_DIR` | **Embedded WASM mode** (browser-like hosts): directory with the `make wasm-wallet` artifacts (`wavewalletdk.wasm`, `wasm_exec.js`, sqlite bridge) |
| `PI402_WALLET_PASSWORD` | Wallet password (created on first run) |
| `PI402_NETWORK` | `regtest` (default), `testnet`, `mainnet` |
| `PI402_ARK_SERVER` | Ark operator address (WASM mode) |
| `PI402_SWAP_SERVER` | Swap server address (WASM mode) |
| `PI402_ESPLORA_URL` | Esplora API for the embedded wallet (WASM mode) |

## Development

This repo is also the dev environment for the extension.

```bash
npm install
npm run check   # biome + tsc
```

The buyer loop reuses [`@lightninglabs/aperture-client`](https://github.com/lightninglabs/aperture-ts)
(`createPayingFetch`) and [`@lightninglabs/aperture-core`](https://github.com/lightninglabs/aperture-ts)
(`InvoicePayer`, budget policies). Until those are published, link them from a
local `aperture-ts` checkout.

## Docs

- [`docs/l402-walletdk-inference-payments.md`](docs/l402-walletdk-inference-payments.md): end-to-end design of the extension.
- [`docs/l402-protocol-extensions.md`](docs/l402-protocol-extensions.md): furthering L402 for metered / streaming inference: keep the macaroon + preimage atomic core, add the session economic model (verifiable receipts, HTLC-native refunds, a BOLT12 payment plane), informed by the Machine Payment Protocol.

## License

MIT
