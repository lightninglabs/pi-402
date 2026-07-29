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
		-d '{"model":"moonshotai/Kimi-K3","messages":[{"role":"user","content":"hi"}]}' \
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
	local from="${2:-$SELLER_GATEWAY_HOST}"

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
echo "  challenge | fund [sats] | topup [sats] | watch | show [file] | receipts | reset"

unset _demo_profile _demo_here
