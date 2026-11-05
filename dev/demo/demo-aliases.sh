# Sourced into the driver pane: short names for the commands the demo runs, so
# nothing long or error-prone gets typed in front of a room.
#
#   source dev/demo/demo-aliases.sh regtest
#
#   challenge      the 402, with no credential and no prior payment
#   fund [sats]    mint a funding invoice and pay it (regtest) or show it (signet)
#   topup [sats]   move sats in from another Ark wallet, no swap liquidity needed
#   watch          follow the buyer balance until it moves
#   show [file]    cat what pi just wrote
#   receipts       the payment ledger, straight from the file
#   reset          drop the cached token so the next prompt pays again

_demo_profile="${1:-regtest}"
_demo_here="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"

# shellcheck source=/dev/null
source "$_demo_here/common.env"
# shellcheck source=/dev/null
source "$_demo_here/$_demo_profile.env"

DEMO_STATE="$DEMO_DIR/$_demo_profile"
DEMO_HERE="$_demo_here"
DEMO_PROFILE="$_demo_profile"
export DEMO_STATE DEMO_HERE DEMO_PROFILE

# challenge shows the seller asking to be paid. This is the bootstrapping
# proof: no credential is sent, nothing was arranged beforehand, and an invoice
# comes back anyway.
challenge() {
	curl -si --max-time 30 "http://$APERTURE_ADDR/v1/chat/completions" \
		-H 'Content-Type: application/json' \
		-d '{"model":"moonshotai/Kimi-K3.1-Pro","messages":[{"role":"user","content":"hi"}]}' \
		| sed -n '1p;/^[Ww]ww-[Aa]uthenticate: L402/p'
}

fund() { "$DEMO_HERE/demo-fund.sh" "$DEMO_PROFILE" "${1:-25000}"; }

# topup moves sats into the buyer from another Ark wallet rather than through
# an inbound swap. Both ends being Ark wallets on the same operator puts the
# payment on the in-ark rail, so it costs no fee, settles immediately, and
# above all does not draw on the swap server's own liquidity, which is the
# thing that runs dry on a long-lived regtest stack. It is also the closer
# analogue of the real demo, where a phone pays the harness.
topup() {
	local amount="${1:-15000}"
	local from="${2:-$USER_GATEWAY_HOST}"

	local invoice intent quote
	invoice="$(curl -sf --max-time 60 -X POST \
		"http://$BUYER_GATEWAY_HOST/v1/wallet/recv" \
		-H 'Content-Type: application/json' \
		-d "{\"amt_sat\":$amount,\"memo\":\"pi-402 top up\"}" \
		| sed -n 's/.*"invoice":"\([^"]*\)".*/\1/p')"
	[[ -n "$invoice" ]] || { echo "could not mint an invoice" >&2; return 1; }

	quote="$(curl -sf --max-time 60 -X POST "http://$from/v1/wallet/prepare-send" \
		-H 'Content-Type: application/json' -d "{\"invoice\":\"$invoice\"}")"
	intent="$(echo "$quote" | sed -n 's/.*"send_intent_id":"\([^"]*\)".*/\1/p')"
	[[ -n "$intent" ]] || { echo "quote failed: $quote" >&2; return 1; }

	echo "  rail $(echo "$quote" | sed -n 's/.*"rail":"\([^"]*\)".*/\1/p')" \
		"fee $(echo "$quote" | sed -n 's/.*"expected_fee_sat":"\([^"]*\)".*/\1/p') sat"

	curl -sf --max-time 90 -X POST "http://$from/v1/wallet/send" \
		-H 'Content-Type: application/json' \
		-d "{\"send_intent_id\":\"$intent\"}" -o /dev/null || return 1

	sleep 6
	curl -s --max-time 10 -X POST "http://$BUYER_GATEWAY_HOST/v1/wallet/balance" \
		-H 'Content-Type: application/json' -d '{}' \
		| sed -n 's/.*"confirmed_sat":"\([0-9]*\)".*/  buyer now \1 sat/p'
}

# pay settles one specific invoice from the user wallet. This is the beat that
# matters when the harness starts empty: pi prints an invoice, and the money
# arrives from a wallet that is visibly not the harness. Paste the invoice pi
# showed rather than minting a second one, so what the room watched being
# asked for is what they watch being paid.
pay() {
	local invoice="${1:-}"
	[[ -n "$invoice" ]] || { echo "usage: pay <bolt11>" >&2; return 1; }

	local quote intent
	quote="$(curl -sf --max-time 60 -X POST \
		"http://$USER_GATEWAY_HOST/v1/wallet/prepare-send" \
		-H 'Content-Type: application/json' -d "{\"invoice\":\"$invoice\"}")"
	intent="$(echo "$quote" | sed -n 's/.*"send_intent_id":"\([^"]*\)".*/\1/p')"
	[[ -n "$intent" ]] || { echo "quote failed: $quote" >&2; return 1; }

	echo "  paying $(echo "$quote" | sed -n 's/.*"amount_sat":"\([^"]*\)".*/\1/p') sat" \
		"on rail $(echo "$quote" | sed -n 's/.*"rail":"\([^"]*\)".*/\1/p')" \
		"fee $(echo "$quote" | sed -n 's/.*"expected_fee_sat":"\([^"]*\)".*/\1/p') sat"

	curl -sf --max-time 90 -X POST "http://$USER_GATEWAY_HOST/v1/wallet/send" \
		-H 'Content-Type: application/json' \
		-d "{\"send_intent_id\":\"$intent\"}" -o /dev/null || return 1

	sleep 6
	balances
}

# balances prints all three wallets, which is the frame the demo is told in.
balances() {
	local host name
	for pair in "buyer:$BUYER_GATEWAY_HOST" "seller:$SELLER_GATEWAY_HOST" \
		"user:$USER_GATEWAY_HOST"; do
		name="${pair%%:*}"; host="${pair#*:}"
		printf '  %-7s %s sat\n' "$name" "$(curl -s --max-time 5 -X POST \
			"http://$host/v1/wallet/balance" -H 'Content-Type: application/json' \
			-d '{}' | sed -n 's/.*"confirmed_sat":"\([0-9]*\)".*/\1/p')"
	done
}

# zero empties the buyer back into the user wallet, so the next run can open on
# a wallet with nothing in it. That opening is the whole point of the demo:
# the harness is not pre-loaded, it starts broke and earns its way in.
zero() {
	local bal
	bal="$(curl -s --max-time 10 -X POST \
		"http://$BUYER_GATEWAY_HOST/v1/wallet/balance" \
		-H 'Content-Type: application/json' -d '{}' \
		| sed -n 's/.*"confirmed_sat":"\([0-9]*\)".*/\1/p')"

	if [[ -z "$bal" || "$bal" -eq 0 ]]; then
		echo "  buyer already empty"
		return 0
	fi

	# Leave nothing behind: send the whole balance back to the phone wallet.
	local invoice quote intent
	invoice="$(curl -sf --max-time 60 -X POST \
		"http://$USER_GATEWAY_HOST/v1/wallet/recv" \
		-H 'Content-Type: application/json' \
		-d "{\"amt_sat\":$bal,\"memo\":\"pi-402 demo reset\"}" \
		| sed -n 's/.*"invoice":"\([^"]*\)".*/\1/p')"
	[[ -n "$invoice" ]] || { echo "could not mint a drain invoice" >&2; return 1; }

	quote="$(curl -sf --max-time 60 -X POST \
		"http://$BUYER_GATEWAY_HOST/v1/wallet/prepare-send" \
		-H 'Content-Type: application/json' -d "{\"invoice\":\"$invoice\"}")"
	intent="$(echo "$quote" | sed -n 's/.*"send_intent_id":"\([^"]*\)".*/\1/p')"
	[[ -n "$intent" ]] || { echo "drain quote failed: $quote" >&2; return 1; }

	curl -sf --max-time 90 -X POST "http://$BUYER_GATEWAY_HOST/v1/wallet/send" \
		-H 'Content-Type: application/json' \
		-d "{\"send_intent_id\":\"$intent\"}" -o /dev/null || return 1

	rm -f "$DEMO_STATE/pi-data/tokens.json" "$DEMO_STATE/pi-data/receipts.ndjson"
	sleep 6
	echo "  buyer drained, token cache and receipts cleared"
	balances
}

# refund empties the pi wallet to an invoice you supply, which on signet means
# an invoice from your own Wavelength app. zero sends to the local stand-in
# wallet instead, which is fine on regtest where that wallet is the phone, and
# wrong on signet where it is a throwaway holding nothing.
#
# The invoice carries its own amount, so ask the app for exactly what `owed`
# reports if you want the wallet to end at zero.
refund() {
	local invoice="${1:-}"
	if [[ -z "$invoice" ]]; then
		echo "usage: refund <bolt11>   (ask your wallet for an invoice for $(owed) sat)" >&2
		return 1
	fi

	local quote intent
	quote="$(curl -sf --max-time 60 -X POST \
		"http://$BUYER_GATEWAY_HOST/v1/wallet/prepare-send" \
		-H 'Content-Type: application/json' -d "{\"invoice\":\"$invoice\"}")"
	intent="$(echo "$quote" | sed -n 's/.*"send_intent_id":"\([^"]*\)".*/\1/p')"
	[[ -n "$intent" ]] || { echo "quote failed: $quote" >&2; return 1; }

	echo "  sending $(echo "$quote" | sed -n 's/.*"amount_sat":"\([^"]*\)".*/\1/p') sat" \
		"on rail $(echo "$quote" | sed -n 's/.*"rail":"\([^"]*\)".*/\1/p')" \
		"fee $(echo "$quote" | sed -n 's/.*"expected_fee_sat":"\([^"]*\)".*/\1/p') sat"

	curl -sf --max-time 90 -X POST "http://$BUYER_GATEWAY_HOST/v1/wallet/send" \
		-H 'Content-Type: application/json' \
		-d "{\"send_intent_id\":\"$intent\"}" -o /dev/null || return 1

	# Only clear the demo's own state once the money has actually left.
	rm -f "$DEMO_STATE/pi-data/tokens.json" "$DEMO_STATE/pi-data/receipts.ndjson"
	sleep 6
	echo "  token cache and receipts cleared"
	balances
}

# owed prints the pi wallet's confirmed balance on its own, which is the number
# to ask your wallet for an invoice for.
owed() {
	curl -s --max-time 10 -X POST \
		"http://$BUYER_GATEWAY_HOST/v1/wallet/balance" \
		-H 'Content-Type: application/json' -d '{}' \
		| sed -n 's/.*"confirmed_sat":"\([0-9]*\)".*/\1/p'
}

watch() { "$DEMO_HERE/demo-fund.sh" "$DEMO_PROFILE" --watch; }

show() { cat "${1:-$(ls -t . | head -1)}"; }

receipts() {
	python3 - "$DEMO_STATE/pi-data/receipts.ndjson" <<'PY'
import json, sys, hashlib, pathlib

path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("no payments yet")
    raise SystemExit

total = 0
for line in path.read_text().splitlines():
    if not line.strip():
        continue
    r = json.loads(line)
    paid = r.get("paidSat") or r.get("amountSat") or 0
    total += paid
    ok = hashlib.sha256(
        bytes.fromhex(r["preimageHex"])
    ).hexdigest() == r["paymentHash"]
    print(f"  {r['timestamp'][:19]}  {paid:>6} sat  {r.get('model','?')}  "
          f"{r['paymentHash'][:12]}...  preimage {'verifies' if ok else 'MISMATCH'}")
print(f"\n  {total} sat total")
PY
}

# reset drops the cached L402 token so the next prompt buys a fresh bundle.
# Without it a rehearsed run reuses the token it already paid for and no
# payment is visible, which looks like the demo silently failing.
reset() {
	rm -f "$DEMO_STATE/pi-data/tokens.json"
	echo "token cache cleared; the next prompt will pay for a new bundle"
}

echo "demo driver ready ($_demo_profile)"
echo "  challenge | pay <bolt11> | topup [sats] | balances"
echo "  zero (to stand-in) | refund <bolt11> (to your wallet) | owed"
echo "  watch | show [file] | receipts | reset | fund [sats]"

unset _demo_profile _demo_here
