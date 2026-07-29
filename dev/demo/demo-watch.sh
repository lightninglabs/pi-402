#!/usr/bin/env bash
#
# demo-watch.sh — the status pane: both balances and the meter, refreshing.
#
#   ./demo-watch.sh regtest
#
# This is the pane worth pointing at. It shows the buyer's sats going down, the
# seller's going up by the same amount, and the bundle being drawn down a few
# hundred tokens at a time underneath, which is the whole argument in one
# screen.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-regtest}"

# shellcheck source=/dev/null
source "$HERE/common.env"
# shellcheck source=/dev/null
source "$HERE/$PROFILE.env"

STATE="$DEMO_DIR/$PROFILE"
LIGHTMETER_LOG="$STATE/lightmeter.log"
RECEIPTS="$STATE/pi-data/receipts.ndjson"

sats() {
	curl -s --max-time 3 -X POST "http://$1/v1/wallet/balance" \
		-H 'Content-Type: application/json' -d '{}' \
		| sed -n 's/.*"confirmed_sat":"\([0-9]*\)".*/\1/p'
}

bold=$'\033[1m'; dim=$'\033[2m'; grn=$'\033[32m'; ylw=$'\033[33m'; rst=$'\033[0m'

# The buyer's node identity, recorded when the wallet was created. Worth having
# on screen: the demo opens on an empty wallet, and this is what shows it is
# the same wallet throughout rather than a fresh one conjured up once the money
# appears. Nothing about the identity changes when the balance does.
identity() {
	python3 -c "
import json,sys
try:
    print(json.load(open('$STATE/buyer-wallet-created.json'))['identity_pubkey'])
except Exception:
    print('')
" 2>/dev/null
}
BUYER_ID="$(identity)"

while true; do
	buyer="$(sats "$BUYER_GATEWAY_HOST")"
	seller="$(sats "$SELLER_GATEWAY_HOST")"

	clear
	printf '%s pi-402 demo — %s%s\n\n' "$bold" "$PROFILE" "$rst"
	printf '  %sbuyer%s   (pi)       %s%8s sat%s\n' \
		"$bold" "$rst" "$ylw" "${buyer:---}" "$rst"
	if [[ -n "$BUYER_ID" ]]; then
		printf '  %s         node %s%s\n' "$dim" "${BUYER_ID:0:24}..." "$rst"
	fi
	printf '  %sseller%s  (aperture) %s%8s sat%s\n\n' \
		"$bold" "$rst" "$grn" "${seller:---}" "$rst"

	# Quoted and paid are deliberately shown side by side. Every 402 books a
	# bundle, so simply asking the price leaves a "Booked bundle ... for 11500
	# sats" line in the meter below, which reads like money moved. Only a paid
	# bundle is ever usable, and only the paid figure comes from receipts.
	quoted="$(grep -c 'Booked bundle' "$LIGHTMETER_LOG" 2>/dev/null || echo 0)"
	n=0; total=0
	if [[ -f "$RECEIPTS" ]]; then
		n="$(grep -c . "$RECEIPTS" 2>/dev/null || echo 0)"
		total="$(sed -n 's/.*"paidSat":\([0-9]*\).*/\1/p' "$RECEIPTS" \
			| awk '{s += $1} END {print s + 0}')"
	fi
	printf '  %sbundles%s   %s quoted, %s%s paid%s (%s sat)\n' \
		"$bold" "$rst" "$quoted" "$grn" "$n" "$rst" "$total"
	printf '  %s          quoting is free; only a paid bundle is usable%s\n\n' \
		"$dim" "$rst"

	printf '  %smeter%s\n' "$bold" "$rst"
	if [[ -f "$LIGHTMETER_LOG" ]]; then
		grep -E 'Booked bundle|Debited' "$LIGHTMETER_LOG" 2>/dev/null \
			| tail -6 | sed "s/^/  $dim/;s/\$/$rst/" \
			| cut -c1-200
	else
		printf '  %s(waiting for the pricer)%s\n' "$dim" "$rst"
	fi

	sleep 2
done
