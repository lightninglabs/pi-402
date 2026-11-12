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

```bash
pi install npm:@lightninglabs/pi-402
```

Pi's package manager downloads the package and loads it on every run. The
package carries the embedded wallet's WASM bundle, so there is nothing to build
and no daemon to start. You need Node.js 22.19 or newer, and we have verified it
against Pi 1.5.2. [INSTALL.md](INSTALL.md) covers the alternatives (a git
install, an auto-discovered directory, and `pi -e` for development) and
troubleshooting.

A fresh install targets a local regtest stack. To point it at a test network or
mainnet, set `PI402_NETWORK` (and, on mainnet, `PI402_WALLET_PASSWORD`); the
"Choosing a network" section of [INSTALL.md](INSTALL.md) lists every variable.

pi-402 is the buyer half. It pays a seller, and there is no hosted seller to
point it at yet, so you bring your own.

## Bring your own seller

The seller is an [aperture](https://github.com/lightninglabs/aperture) proxy in
front of an OpenAI-compatible model endpoint, with metering turned on so a
payment buys a bundle of tokens that is drawn down as the model serves them.
Aperture's
[`docs/metering.md`](https://github.com/lightninglabs/aperture/blob/master/docs/metering.md)
explains the mechanism, and [lightmeter](https://github.com/lightninglabs/lightmeter)
is the controller that prices the bundles. Run your own, or use one a provider
runs, and point pi-402 at it:

```bash
export L402_PROXY_URL="https://your-aperture.example/v1"   # include the /v1
export PI402_NETWORK=signet                                 # defaults to regtest
export PI402_MAX_SAT_PER_REQUEST=20000                      # above the bundle price
```

The per-request ceiling defaults to 1000 sats and is checked against the quoted
total outflow, so raise it above whatever your seller's bundle costs or the
budget policy will decline the payment. `dev/regtest/README.md` and
`dev/signet-demo.md` bring up a complete seller and buyer on one machine, which
is the way to try pi-402 end to end.

## Use

Select a paid model and prompt:

```
/model pi402/kimi-k3           # 1M context, natively multimodal
/model pi402/kimi-k3.1-pro     # 1M context, cheaper than K3 upstream
/model pi402/glm-4.7           # 200K context
/model pi402/glm-5.2           # 200K context
/model pi402/deepseek-v4-flash # 1M context, the cheap one
```

These are the models the extension registers. What a given seller actually serves
is up to the seller.

Wallet commands:

```
/wallet        show the network and spendable, arriving and outgoing sats
/fund <sats>   show a Lightning invoice to fund the wallet (settles in seconds)
/deposit       show an on-chain boarding address to fund the wallet
/balance       show confirmed balance
/receipts      show the payment ledger: count, all-time and today's sats
```

`/fund` is the path to use. It mints a BOLT11 invoice that you pay from the
[Wavelength](https://wavelength.money) app on your phone, and the sats land in
seconds through an inbound swap. The wallet is an Ark wallet, so there are no
channels to open, no inbound liquidity to source, and nothing to keep online.

Whatever you fund is the ceiling on what the agent can ever spend, which is a
more comfortable thing to hand an autonomous process than a card.

## The wallet

The wallet runs inside the Pi process as WASM, shipped in the package. On the
first session it creates itself under `~/.pi402/wallet` and writes its seed
words to `seed.txt` there. Back that file up: it is the only copy.

On mainnet we are stricter, because the funds are real. `PI402_WALLET_PASSWORD`
must be set to a secret of your own, and a new wallet will not write a plaintext
seed unless you either restore words you already hold with
`PI402_WALLET_MNEMONIC` or accept the plaintext file with
`PI402_ALLOW_PLAINTEXT_SEED=1`.

Two overrides exist. `PI402_WASM_DIR` points at a different WASM bundle than the
bundled one, for example a fresh build from Wavelength. `PI402_WALLETD_GATEWAY`
points at a native `waved` that is already running, and pi-402 then drives that
daemon and loads no WASM.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `L402_PROXY_URL` | `http://localhost:8402` | Base URL of the L402 proxy fronting the model, including the API prefix (for aperture, `/v1`) |
| `PI402_MAX_SAT_PER_REQUEST` | `1000` | Per-request spend ceiling, checked on the quoted total outflow |
| `PI402_DAILY_CAP_SAT` | `100000` | Daily spend ceiling, seeded from the receipt ledger on restart |
| `PI402_PAYMENT_SCHEME` | `auto` | `auto` takes a Payment offer when the seller makes one, else L402; `l402` forces the L402 door |
| `PI402_MPP_INTENTS` | `charge` | Comma-separated Payment intents to accept. Sessions need a return-invoice minter, which the swap-backed wallet cannot supply yet, so asking for `session` here throws. |
| `PI402_NETWORK` | `regtest` | Network the wallet runs on, for example `signet` or `mainnet` |
| `PI402_WALLET_PASSWORD` | dev default | Wallet password; mainnet refuses the default |
| `PI402_WALLET_MNEMONIC` | unset | Seed words to restore on first run instead of generating a wallet |
| `PI402_ALLOW_PLAINTEXT_SEED` | unset | `1` lets a new mainnet wallet write a plaintext `seed.txt` |
| `PI402_WALLET_DIR` | `$PI402_DATA_DIR/wallet` | Wallet databases and `seed.txt` |
| `PI402_DATA_DIR` | `~/.pi402` | Token cache, credential cache, receipt ledger, and the wallet |
| `PI402_WASM_DIR` | `<package>/wasm` | WASM bundle directory, overriding the bundled copy |
| `PI402_WALLETD_GATEWAY` | unset | Use a native `waved` at this HTTP/JSON gateway (e.g. `http://localhost:10031`) instead of the embedded wallet |
| `PI402_ARK_SERVER` | regtest only | Ark operator address; other networks resolve it by name |
| `PI402_SWAP_SERVER` | regtest only | Swap server address; other networks resolve it by name |
| `PI402_ESPLORA_URL` | regtest only | Esplora API; other networks resolve it by name |
| `PI402_SERVER_INSECURE` | `1` on regtest, else `0` | Plaintext transport to the operator and swap server |
| `PI402_DEBUG_LEVEL` | `error` | Embedded daemon log level. Quiet by default so it stays off the TUI; raise it (`debug`, or `info,ROND=debug`) when a swap sticks |
| `PI402_MOCK_PAYER` | unset | `1` uses the mock payer (no Lightning; dev only) |

## Development

This repo is also the dev environment for the extension.

```bash
npm install --legacy-peer-deps
npm run check   # biome + tsc
npm test
```

The buyer loop reuses [`@lightninglabs/aperture-client`](https://github.com/lightninglabs/aperture-ts)
(`createPayingFetch`) and [`@lightninglabs/aperture-core`](https://github.com/lightninglabs/aperture-ts)
(`InvoicePayer`, budget policies), both from npm. INSTALL.md has a note on linking
a local aperture-ts checkout instead.

The WASM bundle is not in git. To work on the embedded wallet, build it with
`make wasm-wallet` in Wavelength and run `scripts/stage-wasm.sh <path-to-bin/wasm>`.
`npm publish` refuses to run unless that staged bundle is complete.

## Docs

- [`docs/architecture.md`](docs/architecture.md): a map of the extension: components, request and payment pipelines, storage, and concurrency.
- [`docs/l402-walletdk-inference-payments.md`](docs/l402-walletdk-inference-payments.md): end-to-end design of the extension.
- [`docs/l402-protocol-extensions.md`](docs/l402-protocol-extensions.md): furthering L402 for metered / streaming inference: keep the macaroon + preimage atomic core, add the session economic model (verifiable receipts, HTLC-native refunds, a BOLT12 payment plane), informed by the Machine Payment Protocol.

## License

MIT
