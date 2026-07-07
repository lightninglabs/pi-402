# Regtest e2e environment

The tier-2 seller stack: aperture (branch `inference-pricing`) gating a model
upstream with metered L402, priced and drawn down by `meterd`, invoices from a
regtest LND.

```
buyer ──▶ aperture :8404 ──▶ upstream :8410 (fake OpenAI or Baseten)
             │  ▲                │
             │  └─ invoices: lnd-alice (:10035 grpc)
             └─ pricesrpc: meterd :10020 (GetPrice / ChallengeMinted /
                                          AuthorizeRequest / ReportUsage)
```

## Bring-up

1. **Lightning**: the lnd skill's multi-node stack (`docker-compose-multi.yml`:
   lnd-alice, lnd-bob, bitcoind), funded with a channel between the nodes.
   Alice is aperture's invoice node; bob plays the buyer's Lightning wallet in
   tier 2a.
2. **Upstream**: `node --experimental-strip-types dev/fake-openai-upstream.ts`
   (port 8410), or point aperture's service `address` at Baseten instead and
   add the `Authorization: Bearer <key>` header in the service config.
3. **meterd** (from the aperture worktree): `meterd --config dev/regtest/meterd.yaml`.
4. **aperture**: needs alice's `tls.cert`, `admin.macaroon` + `invoice.macaroon`
   copied out of the container, a config with `insecure: true`,
   `authenticator.lndhost: localhost:10035`, and the service block pointing
   `dynamicprice.grpcaddress` at meterd with `metered: true`. Note the
   sqlite key is `sqlite.databasefilename`, not `dbfile`.

## Verified flows (2026-07-06)

- 402 challenge priced by meterd (1M-token bundle at 2500 sats, blended
  msat-per-token rates), bundle booked via ChallengeMinted under the minted
  macaroon's token ID.
- Real payment (bob → alice), paid retry verified, request authorized,
  SSE streamed unbuffered, ReportUsage debited the exact final-chunk usage
  (48 tokens), balance persisted.
- Token reuse: further requests on the same L402 need no payment, each
  debiting the bundle.
- Exhaustion: with a 60-token bundle, the third request is denied by
  AuthorizeRequest and aperture answers with a fresh 402; meterd books the
  next bundle. This is the pay → draw down → re-challenge loop.

## Remaining (tier 2b)

The buyer-side walletdk leg runs on the darepo compose stack (bitcoind +
lnd-server + lnd-client + arkd + darepod + electrs) since the swap runtime
must share a chain with the invoice node. See the darepo repo's
`docker-compose.yml` and `scripts/docker-regtest-setup.sh`; walletdk WASM
artifacts come from `make wasm-wallet` in darepo-client.
