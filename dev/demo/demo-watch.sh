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

while true; do
	buyer="$(sats "$BUYER_GATEWAY_HOST")"
	seller="$(sats "$SELLER_GATEWAY_HOST")"

	clear
	printf '%s pi-402 demo — %s%s\n\n' "$bold" "$PROFILE" "$rst"
	printf '  %sbuyer%s   (pi)       %s%8s sat%s\n' \
		"$bold" "$rst" "$ylw" "${buyer:---}" "$rst"
	printf '  %sseller%s  (aperture) %s%8s sat%s\n\n' \
		"$bold" "$rst" "$grn" "${seller:---}" "$rst"

	if [[ -f "$RECEIPTS" ]]; then
		n="$(grep -c . "$RECEIPTS" 2>/dev/null || echo 0)"
		total="$(sed -n 's/.*"paidSat":\([0-9]*\).*/\1/p' "$RECEIPTS" \
			| awk '{s += $1} END {print s + 0}')"
		printf '  %spayments%s  %s bundle(s), %s sat total\n\n' \
			"$bold" "$rst" "$n" "$total"
	fi

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
