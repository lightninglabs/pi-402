# Installing pi-402

`pi-402` is a standard [Pi](https://pi.dev) extension. Pi can load an extension
from a managed package, from an auto-discovered directory, or from a per-run
flag, and pi-402 works with all three. Pi itself is not patched or forked. We
have verified the install paths below against Pi 1.1.0.

## Prerequisites

You need Pi (`pi --version`) and Node.js 22.19 or newer. That is all for the
install. To make a payment you also need two things that pi-402 does not
provide:

- An L402 proxy that fronts a model, reachable at the URL you put in
  `L402_PROXY_URL`. There is no hosted endpoint, so you run one yourself or use
  one run by a provider. See [Bring your own seller](#bring-your-own-seller).
- A funded wallet. The wallet is built in and creates itself on first use, and
  you fund it with `/fund` once Pi is running. See [Wallet](#wallet).

## Option 1: pi install from npm (recommended)

Pi's package manager downloads the package, records it in your settings, and
loads it on every run. The package carries the embedded wallet's WASM bundle
(about 137 MB unpacked, 22 MB to download), so nothing else needs building.

```bash
# Global (user scope, ~/.pi/agent): available in every project.
pi install npm:@lightninglabs/pi-402

# Project scope only (recorded in ./.pi):
pi install npm:@lightninglabs/pi-402 -l
```

The package declares its entry point in `package.json`, so Pi finds the
extension without any further wiring:

```json
"pi": { "extensions": ["./src/index.ts"] }
```

To update or remove it later:

```bash
pi update --extensions
pi remove npm:@lightninglabs/pi-402     # alias: pi uninstall
```

### Installing from git instead

```bash
pi install git:github.com/lightninglabs/pi-402
```

A git checkout does not contain the wallet's WASM bundle. It is about 137 MB, so
it ships in the npm package and not in the repository. After a git install, stage
a bundle built from [Wavelength](https://github.com/lightninglabs/wavelength)
(`make wasm-wallet` writes it to `bin/wasm`) into the package, or point
`PI402_WASM_DIR` at it:

```bash
scripts/stage-wasm.sh /path/to/wavelength/bin/wasm   # copies into ./wasm
# or, without copying anything:
export PI402_WASM_DIR=/path/to/wavelength/bin/wasm
```

## Option 2: auto-discovered directory

Pi scans two directories on startup and loads any extension it finds there:

```bash
# Global: every project.
git clone https://github.com/lightninglabs/pi-402.git ~/.pi/agent/extensions/pi-402

# Project-local: only when Pi runs in this project.
git clone https://github.com/lightninglabs/pi-402.git ./.pi/extensions/pi-402
```

Install its dependencies once with `npm install` inside the clone, and stage the
WASM bundle as described above.

## Option 3: per-run flag

Point Pi at a checkout for a single session, which is the usual way to develop
the extension:

```bash
pi -e /path/to/pi-402          # -e is short for --extension
```

## Where Pi looks for extensions

| Location | Scope | How it gets there |
|---|---|---|
| `./.pi/extensions/` | Project | Option 2 (project) |
| `~/.pi/agent/extensions/` | Global | Option 2 (global) |
| Recorded packages in settings | Project or global | `pi install` (Option 1) |
| `--extension <path>` / `-e <path>` | This run only | Option 3 |

The agent directory is overridable via `PI_CODING_AGENT_DIR`.

## Bring your own seller

pi-402 is the buyer. The seller is an [aperture](https://github.com/lightninglabs/aperture)
proxy that fronts an OpenAI-compatible model endpoint, answers an unpaid request
with a `402` challenge carrying a Lightning invoice, and meters the paid bundle
as the model serves tokens. Aperture's
[`docs/metering.md`](https://github.com/lightninglabs/aperture/blob/master/docs/metering.md)
describes how that works, and
[lightmeter](https://github.com/lightninglabs/lightmeter) is the metering
controller that prices bundles. If you want to run the seller on your own
machine to try pi-402, `dev/regtest/README.md` and `dev/signet-demo.md` walk
through a complete stack.

Whoever runs the seller, you point pi-402 at it with one variable:

```bash
export L402_PROXY_URL="https://your-aperture.example/v1"
```

The URL is the base that the OpenAI client appends `/chat/completions` to, so it
includes the API prefix (`/v1` for aperture). If it is unset, pi-402 uses
`http://localhost:8402`. The proxy holds the model credential. Pi never sees an
API key.

## Wallet

The wallet is Wavelength's, running inside the Pi process as WASM. There is no
daemon to start. On the first session it creates itself under
`~/.pi402/wallet` (override with `PI402_WALLET_DIR`) and writes its seed words
to `seed.txt` there, readable only by you. Back that file up. It is the only
copy, and the wallet cannot be recovered without it.

A running native `waved` can be used instead of the embedded wallet. Set
`PI402_WALLETD_GATEWAY` to its HTTP/JSON gateway (for example
`http://localhost:10031`) and pi-402 drives that daemon and loads no WASM.

### Choosing a network

`PI402_NETWORK` selects the network and defaults to `regtest`, which is for the
local dev stack. For anything real, set it explicitly. On `signet` and the
other test networks the embedded daemon finds the hosted Ark operator, swap
server and chain endpoints by itself. Only `regtest` needs them given, and it
defaults to the local compose stack's addresses; `PI402_ARK_SERVER`,
`PI402_SWAP_SERVER` and `PI402_ESPLORA_URL` override them on any network.

On non-mainnet networks the wallet uses a throwaway default password and
generates a seed without asking. Mainnet is stricter, because the funds are real:

- `PI402_WALLET_PASSWORD` must be set to a secret of your own. The extension
  refuses to start a mainnet wallet with the built-in default.
- A fresh mainnet wallet will not generate a seed that would be written to disk
  in the clear. Either restore a seed you already hold by setting
  `PI402_WALLET_MNEMONIC` to its words, or set `PI402_ALLOW_PLAINTEXT_SEED=1` to
  accept a plaintext `seed.txt` beside the wallet database.
- If `seed.txt` is present but the wallet database is gone, creation is refused
  so the old words are never mistaken for the new wallet's backup. Restore from
  the words with `PI402_WALLET_MNEMONIC`, or move the file away to start fresh.

### Funding

Inside Pi:

```
/fund 50000     a Lightning invoice; pay it from the Wavelength app
/deposit        an on-chain boarding address
/balance        confirmed and pending balance
/wallet         wallet status, and the balance in the status line
/receipts       every payment made: count, all-time sats, and today's sats
```

`/fund` is the quick path, since an invoice settles through a swap in seconds
while an on-chain deposit needs a confirmation and an Ark round. Whatever you
fund is the most the agent can ever spend.

## Configure and use

```bash
export L402_PROXY_URL="https://your-aperture.example/v1"
export PI402_NETWORK=signet
export PI402_MAX_SAT_PER_REQUEST=20000    # see the note below
export PI402_DAILY_CAP_SAT=100000

pi
# then, inside Pi:
/model l402-baseten/kimi-k3
```

The per-request ceiling defaults to 1000 sats and is checked against the quoted
total outflow, meaning the invoice plus the swap fee. A seller that sells a
large token bundle in one invoice can quote more than that, and then the budget
policy declines the payment. Set the ceiling above the bundle price you expect.

| Env var | Default | Purpose |
|---------|---------|---------|
| `L402_PROXY_URL` | `http://localhost:8402` | Base URL of the L402 proxy, including the API prefix |
| `PI402_MAX_SAT_PER_REQUEST` | `1000` | Per-request spend ceiling, checked on the quoted total outflow |
| `PI402_DAILY_CAP_SAT` | `100000` | Daily spend ceiling, seeded from the receipt ledger on restart |
| `PI402_PAYMENT_SCHEME` | `auto` | `auto` takes a Payment offer when the seller makes one and falls back to L402; `l402` pins L402 |
| `PI402_MPP_INTENTS` | `charge` | Payment intents to accept. `session` is refused, since the swap-backed wallet cannot mint the refund invoice it needs |
| `PI402_NETWORK` | `regtest` | Network the embedded wallet runs on (`signet`, `mainnet`, and so on) |
| `PI402_WALLET_PASSWORD` | dev default | Wallet password; required on mainnet |
| `PI402_WALLET_MNEMONIC` | unset | Seed words to restore on first run instead of generating a wallet |
| `PI402_ALLOW_PLAINTEXT_SEED` | unset | Set to `1` to let a new mainnet wallet write a plaintext `seed.txt` |
| `PI402_WALLET_DIR` | `$PI402_DATA_DIR/wallet` | Where the embedded wallet keeps its databases and `seed.txt` |
| `PI402_DATA_DIR` | `~/.pi402` | Token cache, credential cache, receipt ledger and wallet |
| `PI402_WASM_DIR` | `<package>/wasm` | Directory holding the WASM bundle, overriding the bundled copy |
| `PI402_WALLETD_GATEWAY` | unset | Use a native `waved` at this gateway URL instead of the embedded wallet |
| `PI402_ARK_SERVER` | regtest: `127.0.0.1:7070` | Ark operator address; other networks resolve it by name |
| `PI402_SWAP_SERVER` | regtest: `127.0.0.1:8082` | Swap server address; other networks resolve it by name |
| `PI402_ESPLORA_URL` | regtest: `http://127.0.0.1:3002` | Esplora API; other networks resolve it by name |
| `PI402_SERVER_INSECURE` | `1` on regtest, else `0` | Plaintext transport to the operator and swap server |
| `PI402_DEBUG_LEVEL` | `error` | Embedded daemon log level (`debug`, `trace`, or `info,ROND=debug`) |
| `PI402_MOCK_PAYER` | unset | Set to `1` to skip Lightning and "pay" with a mock, against a mock proxy |

The embedded daemon logs through the Pi process, so it logs errors only by
default to keep its output off the TUI. Raise `PI402_DEBUG_LEVEL` when a swap
sticks.

## Trying it without a seller

`PI402_MOCK_PAYER=1` runs the buyer loop with no wallet and no Lightning, against
any mock L402 proxy such as `dev/mock-l402-proxy.ts`:

```bash
export PI402_MOCK_PAYER=1
export L402_PROXY_URL="http://localhost:8402"
pi -e /path/to/pi-402
```

## Developing against a local aperture-ts checkout

The buyer loop comes from `@lightninglabs/aperture-client` and
`@lightninglabs/aperture-core`, which `npm install` fetches from npm. To work
against an unreleased [aperture-ts](https://github.com/lightninglabs/aperture-ts)
instead, build it and link the two packages into your checkout:

```bash
cd aperture-ts && pnpm install && pnpm -r build
cd ../pi-402 && npm install --legacy-peer-deps
mkdir -p node_modules/@lightninglabs
ln -sfn ../../../aperture-ts/packages/core   node_modules/@lightninglabs/aperture-core
ln -sfn ../../../aperture-ts/packages/client node_modules/@lightninglabs/aperture-client
```

The Pi packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are
peers. Pi provides them when it loads the extension, but `npm run check` needs
them installed in the checkout.

## Troubleshooting

```bash
pi -ne              # start with no extensions, to isolate a load failure
```

If the extension fails to load, Pi prints `Failed to load extension "<path>"`
and the paid models never appear. The usual cause:

- `Cannot find module '@lightninglabs/aperture-client'`: dependencies are not
  installed. Reinstall from npm, or run `npm install` in a checkout.

If the extension loads but the wallet cannot start, Pi keeps running and prints
`Extension "<path>" error: ...` at session start. The usual causes:

- `wasm bundle at ... is missing ...`: the bundle is incomplete or absent. Stage
  one with `scripts/stage-wasm.sh`, or set `PI402_WASM_DIR`.
- `wasm bundle at ... would load as ES modules`: the bundle sits inside a
  `"type": "module"` package without a `package.json` of its own. Re-run
  `scripts/stage-wasm.sh`, or add a `package.json` containing
  `{"type":"commonjs"}` to the bundle directory.
- A payment declined with "out of budget": the message names the limit it hit,
  `PI402_MAX_SAT_PER_REQUEST` or `PI402_DAILY_CAP_SAT`. Raise it and restart Pi.
