<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <strong>pi-402</strong> — pay for inference with Lightning
</p>

# pi-402

`pi-402` is a [Pi](https://pi.dev) extension that pays for LLM inference over
**L402 + Lightning**. It loads an embedded [walletdk](https://github.com/lightninglabs/darepo-client)
wallet, registers a paid model provider, and settles each inference call against
a small [aperture](https://github.com/lightninglabs/aperture)-based L402 proxy —
so you can run Pi against a metered model with sats instead of an API key.

No changes to Pi itself: this is a self-contained extension you drop into your
own Pi install.

> Status: early development. The provider + buyer loop are the first milestone;
> the real walletdk `InvoicePayer` depends on [darepo-client#835](https://github.com/lightninglabs/darepo-client/issues/835).

## How it works

```
Pi  ──▶  pi-402 provider  ──▶  OpenAI client (fetch = payingFetch)  ──▶  L402 proxy  ──▶  Baseten GLM
                │                         │ 402 → pay → retry
                └── walletdk wallet ◀─────┘ pays the BOLT11 invoice via an Ark↔Lightning swap
```

The extension registers a provider whose `streamSimple` owns the request path,
wrapping the model call in a paying `fetch`. When the proxy answers `402`, the
buyer loop runs your budget policy, pays the invoice through the embedded
wallet, caches the L402 token, and retries — transparently, streaming included.

## Install

The quickest path (Pi's package manager clones, installs deps, and auto-loads):

```bash
pi install git:github.com/lightninglabs/pi-402
```

See [INSTALL.md](INSTALL.md) for all install methods (managed package,
auto-discovered directory, per-run `-e` flag), dependency linking during early
development, and the mock-payer verification path.

Then select the paid model and prompt:

```
/model l402-baseten/glm-4.7
```

Wallet commands:

```
/wallet        show wallet status and balance
/fund <sats>   show a Lightning invoice to fund the wallet (settles in seconds)
/deposit       show an on-chain boarding address to fund the wallet
/balance       show confirmed / pending balance
```

## Configuration

| Env var | Description |
|---------|-------------|
| `L402_PROXY_URL` | Base URL of the L402 proxy fronting the model, including the API prefix (e.g. `http://localhost:8404/v1`) |
| `PI402_MAX_SAT_PER_REQUEST` | Per-request spend ceiling (budget policy) |
| `PI402_DAILY_CAP_SAT` | Daily spend ceiling |
| `PI402_MOCK_PAYER` | Set to `1` for the mock payer (no Lightning; dev only) |

### Wallet backends

The embedded wallet runs against one of two walletdk backends:

| Env var | Description |
|---------|-------------|
| `PI402_WALLETD_GATEWAY` | **Sidecar mode**: HTTP/JSON gateway of a native darepod built with the `walletdkrpc` tag (e.g. `http://localhost:10031`). This is the path for Node hosts, where the WASM's OPFS-backed SQLite is unavailable. |
| `PI402_WASM_DIR` | **Embedded WASM mode** (browser-like hosts): directory with the `make wasm-wallet` artifacts (`walletdk.wasm`, `wasm_exec.js`, sqlite bridge) |
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

The buyer loop reuses [`@aperture/client`](https://github.com/lightninglabs/aperture-ts)
(`createPayingFetch`) and [`@aperture/core`](https://github.com/lightninglabs/aperture-ts)
(`InvoicePayer`, budget policies). Until those are published, link them from a
local `aperture-ts` checkout.

## Docs

- [`docs/l402-walletdk-inference-payments.md`](docs/l402-walletdk-inference-payments.md) — end-to-end design of the extension.
- [`docs/l402-protocol-extensions.md`](docs/l402-protocol-extensions.md) — furthering L402 for metered / streaming inference: keep the macaroon + preimage atomic core, add the session economic model (verifiable receipts, HTLC-native refunds, a BOLT12 payment plane), informed by the Machine Payment Protocol.

## License

MIT
