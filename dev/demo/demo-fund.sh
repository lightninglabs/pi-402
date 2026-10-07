#!/usr/bin/env bash
#
# demo-fund.sh — put sats in the buyer wallet.
#
#   ./demo-fund.sh regtest [sats]   # pays the invoice from the local lnd
#   ./demo-fund.sh signet  [sats]   # prints an invoice for the Wavelength app
#
# On signet this only mints the invoice: the point of the demo is that you pay
# it from the app, so nothing here can (or should) pay it for you. On regtest
# there is no app, so the compose stack's lnd-server pays it instead.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-}"
AMOUNT="${2:-50000}"
WATCH="no"

if [[ "${2:-}" == "--watch" || "${3:-}" == "--watch" ]]; then
	WATCH="yes"
	[[ "${2:-}" == "--watch" ]] && AMOUNT="50000"
fi

if [[ "$PROFILE" != "signet" && "$PROFILE" != "regtest" ]]; then
	echo "usage: $0 {signet|regtest} [sats] [--watch]" >&2
	exit 1
fi

# shellcheck source=/dev/null
source "$HERE/common.env"
# shellcheck source=/dev/null
source "$HERE/$PROFILE.env"

balance() {
	curl -s --max-time 10 -X POST "http://$BUYER_GATEWAY_HOST/v1/wallet/balance" \
		-H 'Content-Type: application/json' -d '{}' \
		| sed -n 's/.*"confirmed_sat":"\([0-9]*\)".*/\1/p'
}

# --watch just reports the balance as it changes, for the moment on stage
# between paying from the app and the sats landing.
if [[ "$WATCH" == "yes" ]]; then
	LAST="$(balance)"
	echo "watching the buyer balance (ctrl-c to stop); now at ${LAST:-unknown} sat"
	while true; do
		sleep 2
		NOW="$(balance)"
		if [[ -n "$NOW" && "$NOW" != "$LAST" ]]; then
			echo "  balance: $LAST -> $NOW sat"
			LAST="$NOW"
		fi
	done
fi

STATE_PAYLOG="$(mktemp -t pi402-payinvoice)"
trap 'rm -f "$STATE_PAYLOG"' EXIT

BEFORE="$(balance)"
echo "buyer balance before: ${BEFORE:-unknown} sat"

INVOICE="$(curl -sf --max-time 60 -X POST "http://$BUYER_GATEWAY_HOST/v1/wallet/recv" \
	-H 'Content-Type: application/json' \
	-d "{\"amt_sat\":$AMOUNT,\"memo\":\"pi-402 demo funding\"}" \
	| sed -n 's/.*"invoice":"\([^"]*\)".*/\1/p')"

[[ -n "$INVOICE" ]] || { echo "could not mint a funding invoice" >&2; exit 1; }

if [[ "$PROFILE" == "signet" ]]; then
	cat <<EOF

Pay this invoice from the Wavelength app to add $AMOUNT sat:

$INVOICE

Then watch it land with:  dev/demo/demo-fund.sh signet --watch
EOF
	exit 0
fi

# Preflight the swap server's Ark liquidity. An in-swap pays the buyer out of
# swapd's own VTXOs, so a receive larger than what it can spend is refused at
# admission and surfaces as a bare "[lncli] FAILED" with the real reason buried
# in swapd's log. Checking first turns that into a number you can act on.
SPENDABLE="$(docker logs ark-swapd 2>&1 | grep 'Auto-boarder decision' | tail -1 \
	| grep -oE 'live_vtxo_sat=[0-9]+' | cut -d= -f2)"

if [[ -n "$SPENDABLE" && "$SPENDABLE" -lt "$AMOUNT" ]]; then
	cat >&2 <<EOF

The swap server cannot cover this receive.

  asked for     $AMOUNT sat
  it can spend  $SPENDABLE sat

Use the phone wallet instead, which does not go through the swap server at
all and is what the demo is built around:

  topup $AMOUNT          mint an invoice and pay it from the phone wallet
  pay <bolt11>           pay the exact invoice pi printed

Both settle on the in-ark rail: the sender funds the vHTLC itself, so there is
no fee, no wait, and nothing drawn from the pool below.

An in-swap pays you out of swapd's own Ark liquidity. Its auto-boarder tops
that up from chain, but the boarding output only becomes spendable once it is
swept into a round, and on regtest that can stall with nothing to force it.

If you specifically want to exercise the Lightning in-swap, either ask for
less than $SPENDABLE sat or rebuild the stack for a fresh pool:

  cd \$LUMOS_DIR && docker compose -f docker-compose.yml \\
    -f $HERE/../regtest/docker-compose.pi402.yml down -v
  $HERE/demo-up.sh regtest

A rebuild resets the operator, so the wallets lose their balances and have to
be funded again.
EOF
	exit 1
fi

echo "paying $AMOUNT sat from the compose stack's lnd-server..."
if ! docker exec ark-lnd-server lncli --network=regtest payinvoice --force \
	--json "$INVOICE" > "$STATE_PAYLOG" 2>&1; then
	echo "payment failed; lncli said:" >&2
	tail -5 "$STATE_PAYLOG" >&2
	echo "and swapd said:" >&2
	docker logs ark-swapd 2>&1 | grep -iE 'rejected|Failing out-swap' | tail -3 >&2
	exit 1
fi

# The swap credits the Ark balance a moment after the Lightning leg settles.
for _ in $(seq 1 15); do
	sleep 2
	AFTER="$(balance)"
	if [[ -n "$AFTER" && "$AFTER" != "$BEFORE" ]]; then
		echo "buyer balance after:  $AFTER sat"
		exit 0
	fi
done

echo "payment sent but the balance has not moved yet; check the swap server" >&2
exit 1
