# Installing pi-402

`pi-402` is a standard [Pi](https://pi.dev) extension. Pi loads extensions three
ways — a managed package (`pi install`), an auto-discovered directory, or a
per-run flag — and pi-402 works with all three. No Pi fork or core patch is
required.

> Status: early development. The real walletdk payer depends on
> [darepo-client#835](https://github.com/lightninglabs/darepo-client/issues/835).
> Run with `PI402_MOCK_PAYER=1` against a mock/dev proxy until it lands.

## Prerequisites

- **Pi** installed (`pi --version`), Node.js **>= 22.19**.
- An **L402 proxy URL** fronting your model (see the aperture-based Go proxy in
  the design doc). For local testing, a mock proxy plus `PI402_MOCK_PAYER=1`.
- For real payments: a **funded walletdk wallet** and a reachable swap server
  (milestone work — not required for the mock path).

## Option 1 — `pi install` (recommended)

Pi's package manager clones the repo, installs its dependencies, records it in
your settings, and auto-loads it on every run.

```bash
# Global (user scope, ~/.pi/agent): available in every project.
pi install git:github.com/lightninglabs/pi-402

# Or over SSH:
pi install ssh://git@github.com/lightninglabs/pi-402

# Project scope only (records in ./.pi, this repo/project):
pi install git:github.com/lightninglabs/pi-402 -l
```

Because pi-402's `package.json` declares its entry point:

```json
"pi": { "extensions": ["./src/index.ts"] }
```

Pi discovers the extension automatically after install — nothing else to wire.

Manage it later with:

```bash
pi update --extensions                              # update installed packages
pi remove git:github.com/lightninglabs/pi-402       # (alias: pi uninstall)
```

## Option 2 — auto-discovered directory

Pi scans two directories for extensions on startup and loads any it finds. Drop
(or clone) pi-402 into one of them:

```bash
# Global: every project.
git clone git@github.com:lightninglabs/pi-402.git ~/.pi/agent/extensions/pi-402

# Project-local: only when Pi runs in this project.
git clone git@github.com:lightninglabs/pi-402.git ./.pi/extensions/pi-402
```

A directory is recognized as an extension if it has a `package.json` with a
`pi.extensions` field (pi-402 does) or an `index.ts`/`index.js`. Install its
dependencies once:

```bash
cd ~/.pi/agent/extensions/pi-402 && npm install
```

## Option 3 — per-run flag (no install)

Point Pi at a checkout for a single session — handy for development:

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

## Dependencies (read this during early development)

pi-402's buyer loop uses `@aperture/client` and `@aperture/core` from
[aperture-ts](https://github.com/lightninglabs/aperture-ts), plus the Pi
packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) as peers.
Until the aperture packages are published to npm, link them from a local
checkout:

```bash
# In an aperture-ts checkout:
cd aperture-ts && pnpm install && pnpm -r build

# Then in pi-402, link the two packages (npm link or a workspace override):
cd pi-402
npm link @aperture/client @aperture/core
npm install
```

The Pi packages resolve from your Pi install. Once aperture publishes, plain
`npm install` (and `pi install`) will work with no linking.

## Configure and use

Set the proxy URL and (optionally) spend limits, then select the model:

```bash
export L402_PROXY_URL="https://your-l402-proxy.example"
export PI402_MAX_SAT_PER_REQUEST=1000     # per-request ceiling (optional)
export PI402_DAILY_CAP_SAT=100000         # daily ceiling (optional)

pi
# then, inside Pi:
/model l402-baseten/glm-4.7
```

Wallet commands (registered by the extension):

```
/wallet     wallet status and balance
/deposit    on-chain boarding address to fund the wallet
/balance    confirmed / pending balance
```

| Env var | Purpose |
|---------|---------|
| `L402_PROXY_URL` | Base URL of the L402 proxy fronting the model (default `http://localhost:8402`) |
| `PI402_MAX_SAT_PER_REQUEST` | Per-request spend ceiling |
| `PI402_DAILY_CAP_SAT` | Daily spend ceiling |
| `PI402_MOCK_PAYER` | Set to `1` to use the mock payer (no real Lightning) while developing |

## Verify with the mock path

Before wiring a real wallet or waiting on darepo-client#835, prove the loop end
to end against a mock proxy:

```bash
export PI402_MOCK_PAYER=1
export L402_PROXY_URL="http://localhost:8402"   # your mock/dev L402 proxy
pi -e /path/to/pi-402
# /model l402-baseten/glm-4.7 and send a prompt; the paying fetch should
# handle the 402, "pay" via the mock payer, and stream a completion.
```

## Disable / troubleshoot

```bash
pi -ne              # start with no extensions (isolate a load failure)
```

If an extension fails to load, Pi prints `Failed to load extension "<path>"`
and hints `pi -ne`. Common causes: missing dependencies (see the linking note
above) or a bad `L402_PROXY_URL`.
